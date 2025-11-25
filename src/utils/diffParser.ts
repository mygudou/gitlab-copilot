import logger from './logger';

export interface ParsedDiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export interface ParsedDiffFile {
  oldPath: string;
  newPath: string;
  lines: ParsedDiffLine[];
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
  hasDiff: boolean;
}

export interface MergeRequestDiffInfo {
  baseSha: string;
  headSha: string;
  startSha: string;
  files: ParsedDiffFile[];
}

export class DiffParser {
  /**
   * 判断文件是否应该被排除在代码审查之外
   */
  private static shouldExcludeFromReview(filePath: string): boolean {
    const excludePatterns = [
      // 生成的 protobuf 文件
      /\.pb\.go$/,
      // Swagger/OpenAPI 相关文件
      /swagger\.json$/i,
      /swagger\.yaml$/i,
      /swagger\.yml$/i,
      /openapi\.json$/i,
      /openapi\.yaml$/i,
      /openapi\.yml$/i,
      // 文档文件
      /\.(md|txt|rst)$/i,
      // docs 目录下的所有文件
      /^docs\//i,
      /\/docs\//i,
      // API 文档目录
      /^api-docs\//i,
      /\/api-docs\//i,
      // Swagger UI 相关
      /swagger-ui/i,
    ];

    return excludePatterns.some(pattern => pattern.test(filePath));
  }

  /**
   * Parse GitLab MR diffs into a structured format
   */
  public static parseMergeRequestDiffs(diffs: any[], mergeRequest: any): MergeRequestDiffInfo {
    const files: ParsedDiffFile[] = [];
    let excludedCount = 0;

    for (const diff of diffs) {
      try {
        const filePath = diff.new_path || diff.old_path;

        // 跳过应排除的文件
        if (this.shouldExcludeFromReview(filePath)) {
          excludedCount++;
          logger.debug('Excluding file from code review', {
            filePath,
            reason: 'Matches exclusion pattern (docs/swagger/pb.go)'
          });
          continue;
        }

        const parsedFile = this.parseDiffFile(diff);
        if (parsedFile) {
          files.push(parsedFile);
        }
      } catch (error) {
        logger.warn('Failed to parse diff file:', {
          fileName: diff.new_path || diff.old_path,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (excludedCount > 0) {
      logger.info('Excluded files from code review', {
        excludedCount,
        totalFiles: diffs.length,
        reviewableFiles: files.length
      });
    }

    return {
      baseSha: mergeRequest.diff_refs?.base_sha || '',
      headSha: mergeRequest.diff_refs?.head_sha || '',
      startSha: mergeRequest.diff_refs?.start_sha || '',
      files,
    };
  }

  /**
   * Parse a single diff file
   */
  private static parseDiffFile(diff: any): ParsedDiffFile | null {
    if (!diff.diff) {
      return {
        oldPath: diff.old_path || diff.new_path,
        newPath: diff.new_path || diff.old_path,
        lines: [],
        isNew: diff.new_file || false,
        isDeleted: diff.deleted_file || false,
        isRenamed: diff.renamed_file || false,
        hasDiff: false,
      };
    }

    return {
      oldPath: diff.old_path || diff.new_path,
      newPath: diff.new_path || diff.old_path,
      lines: this.parseDiffContent(diff.diff),
      isNew: diff.new_file || false,
      isDeleted: diff.deleted_file || false,
      isRenamed: diff.renamed_file || false,
      hasDiff: true,
    };
  }

  /**
   * Parse diff content string into structured lines
   */
  private static parseDiffContent(diffContent: string): ParsedDiffLine[] {
    const lines: ParsedDiffLine[] = [];
    const diffLines = diffContent.split('\n');

    let oldLineNumber = 0;
    let newLineNumber = 0;

    for (const line of diffLines) {
      // Skip header lines
      if (line.startsWith('@@')) {
        // Parse hunk header to get line numbers
        const hunkMatch = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
        if (hunkMatch) {
          oldLineNumber = parseInt(hunkMatch[1], 10) - 1;
          newLineNumber = parseInt(hunkMatch[2], 10) - 1;
        }
        continue;
      }

      // Skip diff header lines
      if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff --git')) {
        continue;
      }

      if (line.startsWith('+')) {
        // Added line
        newLineNumber++;
        lines.push({
          type: 'add',
          content: line.substring(1),
          newLineNumber,
        });
      } else if (line.startsWith('-')) {
        // Removed line
        oldLineNumber++;
        lines.push({
          type: 'remove',
          content: line.substring(1),
          oldLineNumber,
        });
      } else if (line.startsWith(' ') || line === '') {
        // Context line (unchanged)
        oldLineNumber++;
        newLineNumber++;
        lines.push({
          type: 'context',
          content: line.substring(1),
          oldLineNumber,
          newLineNumber,
        });
      }
    }

    return lines;
  }

  /**
   * Get reviewable lines (added or modified lines) from parsed diff
   */
  public static getReviewableLines(parsedDiff: MergeRequestDiffInfo): Array<{
    file: ParsedDiffFile;
    line: ParsedDiffLine;
    lineNumber: number;
  }> {
    const reviewableLines: Array<{
      file: ParsedDiffFile;
      line: ParsedDiffLine;
      lineNumber: number;
    }> = [];

    for (const file of parsedDiff.files) {
      for (const line of file.lines) {
        // Only review added lines (we can't comment on removed lines in the new version)
        if (line.type === 'add' && line.newLineNumber) {
          reviewableLines.push({
            file,
            line,
            lineNumber: line.newLineNumber,
          });
        }
      }
    }

    return reviewableLines;
  }

  /**
   * Create position object for GitLab API
   */
  public static createPosition(
    diffInfo: MergeRequestDiffInfo,
    file: ParsedDiffFile,
    line: ParsedDiffLine,
    lineNumber: number
  ): any {
    const position = {
      base_sha: diffInfo.baseSha,
      head_sha: diffInfo.headSha,
      start_sha: diffInfo.startSha,
      old_path: file.oldPath,
      new_path: file.newPath,
      position_type: 'text' as const,
    };

    if (line.type === 'add') {
      return {
        ...position,
        new_line: lineNumber,
      };
    } else if (line.type === 'remove') {
      return {
        ...position,
        old_line: lineNumber,
      };
    } else {
      // Context line (unchanged)
      return {
        ...position,
        old_line: line.oldLineNumber,
        new_line: line.newLineNumber,
      };
    }
  }

  /**
   * Filter lines that likely need review based on content patterns
   */
  public static filterLinesNeedingReview(reviewableLines: Array<{
    file: ParsedDiffFile;
    line: ParsedDiffLine;
    lineNumber: number;
  }>): Array<{
    file: ParsedDiffFile;
    line: ParsedDiffLine;
    lineNumber: number;
    reviewReason?: string;
  }> {
    return reviewableLines
      .map(item => {
        const content = item.line.content.trim();

        // Skip empty lines or lines with only whitespace changes
        if (!content) {
          return null;
        }

        // Skip import/require statements (usually not worth reviewing)
        if (/^(import|require|from)\s/.test(content)) {
          return null;
        }

        // Skip simple variable assignments without logic
        if (/^(const|let|var)\s+\w+\s*=\s*(true|false|null|undefined|\d+|"[^"]*"|'[^']*');\s*$/.test(content)) {
          return null;
        }

        // Identify lines that might need review
        let reviewReason: string | undefined;

        // Complex logic patterns
        if (/\b(if|else|for|while|switch|try|catch)\b/.test(content)) {
          reviewReason = 'Control flow logic';
        }
        // Function definitions
        else if (/^(function|async\s+function|\w+\s*:\s*(async\s+)?function|\w+\s*=\s*(async\s+)?\(|\w+\s*=\s*(async\s+)?\w+\s*=>)/.test(content)) {
          reviewReason = 'Function definition';
        }
        // API calls or external dependencies
        else if (/(fetch|axios|http|api|client)\./i.test(content) || /\.then\(|\.catch\(|await\s/.test(content)) {
          reviewReason = 'API call or async operation';
        }
        // Security-sensitive patterns
        else if (/(password|token|secret|key|auth|session|cookie|jwt)/i.test(content)) {
          reviewReason = 'Security-sensitive code';
        }
        // Database or data manipulation
        else if ((/(sql|query|insert|update|delete|select)\b/i.test(content)) || /\.(save|create|update|delete|find)\(/.test(content)) {
          reviewReason = 'Data manipulation';
        }
        // Complex expressions
        else if (content.length > 80 || (content.match(/[(){}[\]]/g) || []).length > 4) {
          reviewReason = 'Complex expression';
        }

        return reviewReason ? { ...item, reviewReason } : item;
      })
      .filter(Boolean) as Array<{
        file: ParsedDiffFile;
        line: ParsedDiffLine;
        lineNumber: number;
        reviewReason?: string;
      }>;
  }
}
