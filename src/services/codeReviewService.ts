import { GitLabService } from './gitlabService';
import { DiffParser, MergeRequestDiffInfo, ParsedDiffFile } from '../utils/diffParser';
import logger from '../utils/logger';

export interface ReviewComment {
  filePath: string;
  lineNumber: number;
  content: string;
  severity: 'info' | 'warning' | 'error';
  category: 'style' | 'security' | 'performance' | 'logic' | 'maintainability';
}

export class CodeReviewService {
  private gitlabService: GitLabService;

  constructor() {
    this.gitlabService = new GitLabService();
  }

  /**
   * Perform inline code review for a merge request
   */
  public async performInlineReview(
    projectId: number,
    mergeRequestIid: number,
    reviewComments: ReviewComment[]
  ): Promise<void> {
    try {
      // Get MR details and diffs
      const mergeRequest = await this.gitlabService.getMergeRequest(projectId, mergeRequestIid);
      const diffs = await this.gitlabService.getMergeRequestDiffs(projectId, mergeRequestIid);

      // Parse diff information
      const parsedDiff = DiffParser.parseMergeRequestDiffs(diffs, mergeRequest);

      // Build lookup map and set of all available file paths (both old and new for renamed files)
      const availableFiles = new Set<string>();
      const fileLookup = new Map<string, ParsedDiffFile>();
      parsedDiff.files.forEach(file => {
        if (file.newPath) {
          availableFiles.add(file.newPath);
          fileLookup.set(file.newPath, file);
        }
        if (file.oldPath && file.oldPath !== file.newPath) {
          availableFiles.add(file.oldPath);
          fileLookup.set(file.oldPath, file);
        }
      });

      logger.info('Starting inline code review', {
        projectId,
        mergeRequestIid,
        commentsCount: reviewComments.length,
        filesChanged: parsedDiff.files.length,
        availableFiles: Array.from(availableFiles)
      });

      // Debug: Log detailed file information
      logger.debug('Detailed diff files information', {
        files: parsedDiff.files.map(f => ({
          newPath: f.newPath,
          oldPath: f.oldPath,
          isNew: f.isNew,
          isDeleted: f.isDeleted,
          isRenamed: f.isRenamed,
          linesCount: f.lines.length
        }))
      });

      // Separate comments into inline-able and general ones
      const inlineComments: ReviewComment[] = [];
      const generalComments: ReviewComment[] = [];
      const reroutedComments: ReviewComment[] = [];

      reviewComments.forEach(comment => {
        const targetFile = fileLookup.get(comment.filePath);

        if (!targetFile) {
          generalComments.push(comment);
          return;
        }

        if (!targetFile.lines.length) {
          generalComments.push(comment);
          reroutedComments.push(comment);
          return;
        }

        inlineComments.push(comment);
      });

      if (reroutedComments.length > 0) {
        logger.info('Rerouted comments to general MR comment because diff content is unavailable', {
          reroutedCount: reroutedComments.length,
          files: Array.from(new Set(reroutedComments.map(comment => comment.filePath)))
        });
      }

      // Create inline comments for files in the diff
      const inlineResults = await Promise.allSettled(
        inlineComments.map(comment =>
          this.createInlineReviewComment(projectId, mergeRequestIid, comment, parsedDiff)
        )
      );

      // Create general MR comment for files not in diff
      let generalCommentResult: PromiseSettledResult<void> | null = null;
      if (generalComments.length > 0) {
        generalCommentResult = await Promise.allSettled([
          this.createGeneralReviewComment(projectId, mergeRequestIid, generalComments)
        ]).then(results => results[0]);
      }

      const inlineSuccessful = inlineResults.filter(r => r.status === 'fulfilled').length;
      const inlineFailed = inlineResults.filter(r => r.status === 'rejected').length;
      const generalSuccessful = generalCommentResult?.status === 'fulfilled' ? 1 : 0;
      const generalFailed = generalCommentResult?.status === 'rejected' ? 1 : 0;

      logger.info('Inline code review completed', {
        projectId,
        mergeRequestIid,
        inlineSuccessful,
        inlineFailed,
        generalSuccessful,
        generalFailed,
        total: reviewComments.length,
      });

      // Log any inline comment failures
      inlineResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          const comment = inlineComments[index];
          logger.warn('Failed to create inline comment', {
            comment: {
              filePath: comment.filePath,
              lineNumber: comment.lineNumber,
              severity: comment.severity,
              category: comment.category,
              content: comment.content.substring(0, 100) + (comment.content.length > 100 ? '...' : '')
            },
            error: result.reason,
            errorMessage: result.reason instanceof Error ? result.reason.message : String(result.reason),
            errorStack: result.reason instanceof Error ? result.reason.stack : undefined
          });
        }
      });

      // Log general comment failure
      if (generalCommentResult?.status === 'rejected') {
        logger.warn('Failed to create general review comment', {
          error: generalCommentResult.reason,
          errorMessage: generalCommentResult.reason instanceof Error ? generalCommentResult.reason.message : String(generalCommentResult.reason),
          commentsCount: generalComments.length
        });
      }

    } catch (error) {
      logger.error('Failed to perform inline code review:', error);
      throw error;
    }
  }

  /**
   * Create general MR comment for files not in diff
   */
  private async createGeneralReviewComment(
    projectId: number,
    mergeRequestIid: number,
    comments: ReviewComment[]
  ): Promise<void> {
    const severityEmojis = {
      error: '🚨',
      warning: '⚠️',
      info: '💡',
    };

    const categoryLabels = {
      style: 'Code Style',
      security: 'Security',
      performance: 'Performance',
      logic: 'Logic',
      maintainability: 'Maintainability',
    };

    let commentBody = '## 📋 代码审查建议 (相关文件)\n\n';
    commentBody += '*以下建议涉及的文件不在当前 MR 的更改范围内，但与此次更改相关：*\n\n';

    // Group comments by file
    const commentsByFile = comments.reduce((acc, comment) => {
      if (!acc[comment.filePath]) {
        acc[comment.filePath] = [];
      }
      acc[comment.filePath].push(comment);
      return acc;
    }, {} as Record<string, ReviewComment[]>);

    for (const [filePath, fileComments] of Object.entries(commentsByFile)) {
      commentBody += `### 📄 \`${filePath}\`\n\n`;

      fileComments.forEach((comment, index) => {
        const emoji = severityEmojis[comment.severity];
        const categoryLabel = categoryLabels[comment.category];

        commentBody += `${index + 1}. ${emoji} **${categoryLabel}** (${comment.severity}) - 行 ${comment.lineNumber}\n`;
        commentBody += `   ${comment.content}\n\n`;
      });
    }

    commentBody += '---\n*🤖 此评论由 AI 代码审查生成*';

    await this.gitlabService.addMergeRequestComment(projectId, mergeRequestIid, commentBody);

    logger.info('Created general review comment for files not in diff', {
      projectId,
      mergeRequestIid,
      filesCount: Object.keys(commentsByFile).length,
      commentsCount: comments.length
    });
  }

  /**
   * Create a single inline review comment
   */
  private async createInlineReviewComment(
    projectId: number,
    mergeRequestIid: number,
    comment: ReviewComment,
    parsedDiff: MergeRequestDiffInfo
  ): Promise<void> {
    // Find the file in the diff (handle renamed files)
    const file = parsedDiff.files.find(f =>
      f.newPath === comment.filePath || f.oldPath === comment.filePath
    );

    logger.debug('Looking for file in diff', {
      targetFile: comment.filePath,
      foundFile: file ? {
        newPath: file.newPath,
        oldPath: file.oldPath,
        isRenamed: file.isRenamed
      } : null
    });

    if (!file) {
      const availableFiles = parsedDiff.files.map(f => {
        if (f.isRenamed && f.oldPath !== f.newPath) {
          return `${f.oldPath} -> ${f.newPath}`;
        }
        return f.newPath || f.oldPath;
      }).join(', ');
      throw new Error(`File not found in diff: ${comment.filePath}. Available files: ${availableFiles}`);
    }

    // Find the specific line in the file
    const line = file.lines.find(l =>
      (l.type === 'add' && l.newLineNumber === comment.lineNumber) ||
      (l.type === 'context' && l.newLineNumber === comment.lineNumber)
    );

    if (!line) {
      // If we can't find the exact line, try to find the closest reviewable line
      const reviewableLines = DiffParser.getReviewableLines(parsedDiff);
      const fileLines = reviewableLines.filter(rl => rl.file === file);
      const closestLine = fileLines.find(fl => Math.abs(fl.lineNumber - comment.lineNumber) <= 2);

      if (closestLine) {
        logger.warn('Using closest line for review comment', {
          requested: comment.lineNumber,
          actual: closestLine.lineNumber,
          filePath: comment.filePath,
        });
        return this.createInlineCommentForLine(
          projectId,
          mergeRequestIid,
          comment,
          parsedDiff,
          closestLine.file,
          closestLine.line,
          closestLine.lineNumber
        );
      }

      const availableLines = file.lines
        .filter(l => l.type === 'add' || l.type === 'context')
        .map(l => l.newLineNumber)
        .filter(ln => ln !== null)
        .join(', ');
      throw new Error(`Line ${comment.lineNumber} not found in diff for ${comment.filePath}. Available lines: ${availableLines}`);
    }

    return this.createInlineCommentForLine(
      projectId,
      mergeRequestIid,
      comment,
      parsedDiff,
      file,
      line,
      comment.lineNumber
    );
  }

  /**
   * Create inline comment for a specific line
   */
  private async createInlineCommentForLine(
    projectId: number,
    mergeRequestIid: number,
    comment: ReviewComment,
    parsedDiff: MergeRequestDiffInfo,
    file: any,
    line: any,
    lineNumber: number
  ): Promise<void> {
    // Create position object
    const position = DiffParser.createPosition(parsedDiff, file, line, lineNumber);

    // Format comment body with severity and category
    const formattedBody = this.formatReviewComment(comment);

    // Create the inline comment
    await this.gitlabService.createInlineComment(
      projectId,
      mergeRequestIid,
      formattedBody,
      position
    );
  }

  /**
   * Format review comment with appropriate styling
   */
  private formatReviewComment(comment: ReviewComment): string {
    const severityEmojis = {
      error: '🚨',
      warning: '⚠️',
      info: '💡',
    };

    const categoryLabels = {
      style: 'Code Style',
      security: 'Security',
      performance: 'Performance',
      logic: 'Logic',
      maintainability: 'Maintainability',
    };

    const emoji = severityEmojis[comment.severity];
    const categoryLabel = categoryLabels[comment.category];

    return `${emoji} **${categoryLabel}** (${comment.severity})\n\n${comment.content}`;
  }

  /**
   * Parse AI review response into structured comments
   */
  public static parseAiReviewResponse(response: string): ReviewComment[] {
    logger.info('Parsing AI review response', {
      responseLength: response.length,
      responsePreview: response.substring(0, 200) + '...'
    });

    const comments: ReviewComment[] = [];

    // Try to parse JSON format first
    try {
      const parsed = JSON.parse(response);
      if (Array.isArray(parsed)) {
        return parsed
          .filter(item => item.filePath && item.lineNumber && item.content)
          .map(item => ({
            filePath: item.filePath,
            lineNumber: parseInt(item.lineNumber, 10),
            content: item.content,
            severity: item.severity || 'info',
            category: item.category || 'logic',
          }));
      }
    } catch {
      // Not JSON, try to parse structured text format
    }

    // Parse structured text format
    // Look for patterns like:
    // File: path/to/file.ts
    // Line: 42
    // Comment: This could be improved...

    const lines = response.split('\n');
    let currentFile = '';
    let currentLine: number | null = null;
    let currentComment = '';
    let currentSeverity: ReviewComment['severity'] = 'info';
    let currentCategory: ReviewComment['category'] = 'logic';
    let collectingComment = false;

    const severityValues: ReviewComment['severity'][] = ['error', 'warning', 'info'];
    const categoryValues: ReviewComment['category'][] = [
      'style',
      'security',
      'performance',
      'logic',
      'maintainability',
    ];

    const matchFieldValue = (rawLine: string, fieldNames: string[]): string | null => {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        return null;
      }

      for (const fieldName of fieldNames) {
        const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patterns = [
          new RegExp(`^\\*\\*${escaped}:\\*\\*[\\s\\u00A0]*(.+)$`, 'i'),
          new RegExp(`^\\*\\*${escaped}:\\*[\\s\\u00A0]*(.+)$`, 'i'),
          new RegExp(`^${escaped}:[\\s\\u00A0]*(.+)$`, 'i'),
        ];

        for (const pattern of patterns) {
          const match = trimmed.match(pattern);
          if (match) {
            return match[1].trim();
          }
        }
      }

      return null;
    };

    // Helper function to save current comment if complete
    const saveCurrentComment = () => {
      const trimmedComment = currentComment.trim();

      // Filter out example/template file paths and generic content
      const isExamplePath = currentFile && (
        currentFile.includes('path/to/file') ||
        currentFile.includes('[file path]') ||
        currentFile.includes('example') ||
        currentFile === 'path/to/file.ts'
      );

      const isExampleContent = trimmedComment && (
        trimmedComment.includes('具体的问题描述和建议') ||
        trimmedComment.includes('[your review comment]') ||
        trimmedComment.includes('issue description and suggestion')
      );

      if (currentFile && currentLine !== null && trimmedComment && !isExamplePath && !isExampleContent) {
        comments.push({
          filePath: currentFile,
          lineNumber: currentLine,
          content: trimmedComment,
          severity: currentSeverity,
          category: currentCategory,
        });
      }

      currentComment = '';
      collectingComment = false;
    };

    for (const rawLine of lines) {
      const trimmedLine = rawLine.trim();

      const fileValue = matchFieldValue(trimmedLine, ['File']);
      if (fileValue) {
        saveCurrentComment();
        currentFile = fileValue;
        currentLine = null;
        currentComment = '';
        currentSeverity = 'info';
        currentCategory = 'logic';
        continue;
      }

      const lineValue = matchFieldValue(trimmedLine, ['Line', 'Lines']);
      if (lineValue) {
        const lineNumberMatch = lineValue.match(/\d+/);
        currentLine = lineNumberMatch ? parseInt(lineNumberMatch[0], 10) : null;
        collectingComment = false;
        continue;
      }

      const commentValue = matchFieldValue(trimmedLine, ['Comment', 'Review', 'Issue']);
      if (commentValue !== null) {
        currentComment = commentValue;
        collectingComment = true;
        continue;
      }

      const severityValue = matchFieldValue(trimmedLine, ['Severity', 'Level']);
      if (severityValue) {
        const normalized = severityValue.toLowerCase();
        if (severityValues.includes(normalized as ReviewComment['severity'])) {
          currentSeverity = normalized as ReviewComment['severity'];
        }
        collectingComment = false;
        continue;
      }

      const categoryValue = matchFieldValue(trimmedLine, ['Category', 'Type']);
      if (categoryValue) {
        const normalizedCategory = categoryValue.toLowerCase();
        if (categoryValues.includes(normalizedCategory as ReviewComment['category'])) {
          currentCategory = normalizedCategory as ReviewComment['category'];
        }
        collectingComment = false;
        continue;
      }

      if (collectingComment) {
        const lineContent = rawLine.trim();
        if (!lineContent) {
          if (currentComment) {
            currentComment += '\n';
          }
        } else {
          currentComment += (currentComment ? '\n' : '') + lineContent;
        }
      }
    }

    // Don't forget the last comment
    saveCurrentComment();

    logger.info('Parsed AI review response', {
      totalComments: comments.length,
      commentDetails: comments.map(c => ({
        file: c.filePath,
        line: c.lineNumber,
        severity: c.severity,
        category: c.category
      }))
    });

    return comments;
  }
}
