import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { AsyncLocalStorage } from 'async_hooks';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { GitLabWebhookEvent, AiInstruction } from '../types/gitlab';
import type { ExecutionScenario } from '../types/aiExecution';
import { extractAiInstructions } from '../utils/webhook';
import logger from '../utils/logger';
import { ProjectManager } from './projectManager';
import { StreamingAiExecutor, StreamingProgressCallback, ExecutionOptions } from './streamingAiExecutor';
import { GitLabService } from './gitlabService';
import { MRGenerator } from '../utils/mrGenerator';
import { CodeReviewService, ReviewComment } from './codeReviewService';
import { DiffParser } from '../utils/diffParser';
import { config } from '../utils/config';
import { SessionManager } from './sessionManager';
import { SessionKey, SessionInfo, ProviderType, ProviderSessionInfo, SpecKitStage } from '../types/session';
import { TenantUserContext } from '../types/tenant';
import { runWithTenantContext } from '../utils/tenantContext';

const AI_RESPONSE_MARKER = '<!-- AI_RESPONSE -->';
const MR_SUMMARY_DELIMITER = '===MR_SUMMARY_START===';
const MAX_GITLAB_NOTE_LENGTH = 1_000_000;
const TRUNCATION_NOTICE = '\n\n*(内容过长，已截断)*';

export type ProcessEventStatus = 'processed' | 'ignored' | 'error';

export interface ProcessEventResult {
  status: ProcessEventStatus;
  executionTimeMs: number;
  error?: string;
}

type SessionExecutionContext = {
  issueKey: SessionKey;
  provider: ProviderType;
  existingSession?: SessionInfo;
  retryAttempted?: boolean;
};

type EventContext = {
  currentCommentId: number | null;
  discussionId: string | null;
  discussionNoteId: number | null;
  discussionResolvable: boolean;
  discussionReplySucceeded: boolean;
  executorName: string;
  progressMessages: string[];
  threadContext: string | null;
};

export class EventProcessor {
  private projectManager: ProjectManager;
  private aiExecutor: StreamingAiExecutor;
  private gitlabService: GitLabService;
  private codeReviewService: CodeReviewService;
  private sessionManager: SessionManager;
  private aiExecutionDelayMs = 100;
  private specKitInitTimeoutMs = 5 * 60 * 1000;
  private issueLocks: Map<string, Promise<void>> = new Map();
  private eventContext = new AsyncLocalStorage<EventContext>();

  private get discussionContext(): EventContext {
    const context = this.eventContext.getStore();
    if (!context) {
      throw new Error('Event context is not available');
    }
    return context;
  }

  constructor() {
    this.projectManager = new ProjectManager();
    this.aiExecutor = new StreamingAiExecutor();
    this.gitlabService = new GitLabService();
    this.codeReviewService = new CodeReviewService();
    this.sessionManager = new SessionManager();
  }

  private createEventContext(): EventContext {
    return {
      currentCommentId: null,
      discussionId: null,
      discussionNoteId: null,
      discussionResolvable: false,
      discussionReplySucceeded: false,
      executorName: this.getExecutorDisplayName(),
      progressMessages: [],
      threadContext: null,
    };
  }

  private withEventContext<T>(callback: () => Promise<T>): Promise<T> {
    const context = this.createEventContext();
    return this.eventContext.run(context, callback);
  }

  private resetEventContext(): void {
    const context = this.eventContext.getStore();
    if (!context) {
      return;
    }
    context.currentCommentId = null;
    context.discussionId = null;
    context.discussionNoteId = null;
    context.discussionResolvable = false;
    context.discussionReplySucceeded = false;
    context.executorName = this.getExecutorDisplayName();
    context.progressMessages = [];
    context.threadContext = null;
  }

  private getExecutorDisplayName(provider?: 'claude' | 'codex'): string {
    const resolved = provider ?? (config.ai.executor as 'claude' | 'codex');
    return resolved === 'codex' ? 'Codex' : 'Claude';
  }

  private getMergeRequestWorkspaceId(projectId: number, mrIid: number): string {
    return `mr:${projectId}:${mrIid}`;
  }

  private formatLocalTime(date: Date): string {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(date);
  }

  private formatLocalDateTime(date: Date): string {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const parts = formatter.formatToParts(date);
    const map: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    parts.forEach(part => {
      if (part.type !== 'literal') {
        map[part.type] = part.value;
      }
    });

    const year = map.year ?? '';
    const month = map.month ?? '';
    const day = map.day ?? '';
    const hour = map.hour ?? '';
    const minute = map.minute ?? '';
    const second = map.second ?? '';

    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  }

  private generateTenantSessionKey(projectId: number, issueIid: number, tenant?: TenantUserContext): SessionKey {
    return this.sessionManager.generateSessionKey(projectId, issueIid, tenant?.userId);
  }

  private extractOwnerIdFromIssueKey(issueKey: SessionKey): string | undefined {
    const parts = issueKey.split(':');
    if (parts.length === 3) {
      return parts[0];
    }
    return undefined;
  }

  private stripTimestampPrefix(message: string): string {
    const separatorIndex = message.indexOf('] ');
    return separatorIndex >= 0 ? message.slice(separatorIndex + 2) : message;
  }

  private getIssueKeyFromEvent(event: GitLabWebhookEvent, tenant?: TenantUserContext): SessionKey | null {
    if (!config.session.enabled) {
      return null;
    }

    const projectId = event.project?.id;
    if (!projectId) {
      return null;
    }

    if (event.object_kind === 'issue') {
      const issueInfo = this.getIssueInfo(event);
      if (issueInfo) {
        return this.generateTenantSessionKey(projectId, issueInfo.iid, tenant);
      }
    } else if (event.object_kind === 'note') {
      const issueInfo = this.getIssueInfo(event);
      if (issueInfo) {
        return this.generateTenantSessionKey(projectId, issueInfo.iid, tenant);
      }

      const mrInfo = this.getMergeRequestInfo(event);
      if (mrInfo) {
        return this.generateTenantSessionKey(projectId, mrInfo.iid, tenant);
      }
    } else if (event.object_kind === 'merge_request') {
      const mrInfo = this.getMergeRequestInfo(event);
      if (mrInfo) {
        return this.generateTenantSessionKey(projectId, mrInfo.iid, tenant);
      }
    }

    return null;
  }

  private async runWithIssueLock<T>(issueKey: SessionKey, task: () => Promise<T>): Promise<T> {
    const previous = this.issueLocks.get(issueKey) ?? Promise.resolve();
    let resolveCurrent!: () => void;
    let rejectCurrent!: (error: unknown) => void;

    const current = new Promise<void>((resolve, reject) => {
      resolveCurrent = resolve;
      rejectCurrent = reject;
    });

    const chain = previous.catch(() => {}).then(() => current);
    this.issueLocks.set(issueKey, chain);

    await previous.catch(() => {});

    try {
      const result = await task();
      resolveCurrent();
      return result;
    } catch (error) {
      rejectCurrent(error);
      throw error;
    } finally {
      if (this.issueLocks.get(issueKey) === chain) {
        this.issueLocks.delete(issueKey);
      }
    }
  }

  private getIssueInfo(event: GitLabWebhookEvent): { iid: number; title: string; description: string } | null {
    if (event.issue) {
      return {
        iid: event.issue.iid,
        title: event.issue.title,
        description: event.issue.description || ''
      };
    } else if (event.object_attributes && event.object_kind === 'issue') {
      const attrs = event.object_attributes as any;
      return {
        iid: attrs.iid,
        title: attrs.title,
        description: attrs.description || ''
      };
    }
    return null;
  }

  private getMergeRequestInfo(event: GitLabWebhookEvent): { iid: number; title: string; description: string; source_branch: string; target_branch: string; action?: string } | null {
    if (event.merge_request) {
      return {
        iid: event.merge_request.iid,
        title: event.merge_request.title,
        description: event.merge_request.description || '',
        source_branch: event.merge_request.source_branch,
        target_branch: event.merge_request.target_branch
      };
    } else if (event.object_attributes && event.object_kind === 'merge_request') {
      const attrs = event.object_attributes as any;
      return {
        iid: attrs.iid,
        title: attrs.title,
        description: attrs.description || '',
        source_branch: attrs.source_branch,
        target_branch: attrs.target_branch,
        action: attrs.action
      };
    }
    return null;
  }

  public async processEvent(
    event: GitLabWebhookEvent,
    tenant?: TenantUserContext
  ): Promise<ProcessEventResult> {
    return this.withEventContext(async () => {
      if (tenant) {
        return runWithTenantContext(tenant, () => this.processEventInternal(event, tenant));
      }

      return this.processEventInternal(event, tenant);
    });
  }

  private async processEventInternal(
    event: GitLabWebhookEvent,
    tenant?: TenantUserContext
  ): Promise<ProcessEventResult> {
    const startedAt = Date.now();
    try {
      if (this.isAiGeneratedComment(event)) {
        logger.debug('Ignoring AI-generated comment');
        return {
          status: 'ignored',
          executionTimeMs: Date.now() - startedAt,
        };
      }

      const issueKey = this.getIssueKeyFromEvent(event, tenant);
      const existingSession = issueKey ? this.sessionManager.peekSession(issueKey) : null;

      const instruction = await this.extractInstruction(event, {
        existingSession: existingSession ?? undefined,
      });

      if (!instruction) {
        logger.debug(`No ${this.getExecutorDisplayName()} instruction found in event`, {
          eventType: event.object_kind,
          projectId: event.project.id,
        });
        return {
          status: 'ignored',
          executionTimeMs: Date.now() - startedAt,
        };
      }

      logger.info(`Processing ${this.getExecutorDisplayName()} instruction`, {
        eventType: event.object_kind,
        projectId: event.project.id,
        instruction: instruction.command.substring(0, 100),
      });

      await this.executeInstruction(event, instruction, {
        issueKey,
      }, tenant);

      return {
        status: 'processed',
        executionTimeMs: Date.now() - startedAt,
      };
    } catch (error) {
      logger.error('Error processing event:', error);
      await this.reportError(event, error);
      return {
        status: 'error',
        executionTimeMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Reset event-scoped context after processing
      this.resetEventContext();
    }
  }

  private async extractInstruction(
    event: GitLabWebhookEvent,
    options?: { existingSession?: SessionInfo }
  ): Promise<AiInstruction | null> {
    let content = '';
    let branch = '';
    let context = '';
    const existingSession = options?.existingSession;

    switch (event.object_kind) {
      case 'issue': {
        const issueInfo = this.getIssueInfo(event);
        if (issueInfo) {
          content = issueInfo.description;
          context = `Issue #${issueInfo.iid}: ${issueInfo.title}`;
          branch = event.project.default_branch;
        }
        break;
      }

      case 'merge_request': {
        const mrInfo = this.getMergeRequestInfo(event);
        if (mrInfo) {
          content = mrInfo.description;
          context = await this.buildMergeRequestContext(mrInfo, event.project.id);
          branch = mrInfo.source_branch;
        }
        break;
      }

      case 'note':
        if (event.object_attributes) {
          content = (event.object_attributes as { note?: string }).note || '';
          const noteId = (event.object_attributes as { id?: number }).id;
          this.discussionContext.discussionNoteId = noteId ?? null;

          const noteIssueInfo = this.getIssueInfo(event);
          const noteMrInfo = this.getMergeRequestInfo(event);

          if (noteIssueInfo) {
            // Only send the current comment content as context
            const trimmedContent = content.trim();
            context = trimmedContent || content;
            branch = event.project.default_branch;
            this.discussionContext.discussionId =
              (event.object_attributes as { discussion_id?: string }).discussion_id ?? null;
            this.discussionContext.discussionNoteId = noteId ?? null;
            if (noteId && this.discussionContext.discussionId) {
              const threadContext = await this.getThreadContext(
                'issue',
                event.project.id,
                noteIssueInfo.iid,
                noteId
              );
              if (threadContext && threadContext.trim()) {
                context = `${context}\n\n${threadContext}`;
              }
            }
          } else if (noteMrInfo) {
            // Build enhanced context for merge request comments including code changes
            context = await this.buildMergeRequestContext(noteMrInfo, event.project.id);
            branch = noteMrInfo.source_branch;
            this.discussionContext.discussionId =
              (event.object_attributes as { discussion_id?: string }).discussion_id ?? null;
            this.discussionContext.discussionNoteId = noteId ?? null;

            logger.info('MR note discussion ID extracted', {
              discussionId: this.discussionContext.discussionId,
              noteId: this.discussionContext.discussionNoteId,
              mrIid: noteMrInfo.iid,
              hasDiscussionId: !!this.discussionContext.discussionId,
            });

            if (noteId && this.discussionContext.discussionId) {
              const threadContext = await this.getThreadContext(
                'merge_request',
                event.project.id,
                noteMrInfo.iid,
                noteId
              );
              if (threadContext && threadContext.trim()) {
                context = `${context}\n\n${threadContext}`;
              }
            }
          }
        }
        break;

      default:
        return null;
    }

    const resolvedBranch = existingSession?.baseBranch || branch || event.project.default_branch;

    const extractedInstruction = extractAiInstructions(content);
    const isIssueNote = event.object_kind === 'note' && this.isIssueScenario(event);
    const defaultScenario = this.isIssueScenario(event) ? 'issue-session' : 'mr-fix';

    if (!extractedInstruction) {
      if (existingSession && isIssueNote) {
        const fallbackCommand = content.trim();
        if (!fallbackCommand) {
          return null;
        }

        return {
          command: fallbackCommand,
          provider: existingSession.lastProvider || 'claude',
          context,
          fullContext: content,
          branch: resolvedBranch,
          scenario: defaultScenario,
        };
      }

      // 对于 MR open/reopen 场景,如果没有显式提及 AI,默认使用 codex
      // 仅在目标分支是 develop 时触发
      if (event.object_kind === 'merge_request') {
        const mrInfo = this.getMergeRequestInfo(event);
        if (mrInfo && this.shouldTriggerDefaultCodeReview(mrInfo.action, mrInfo.target_branch)) {
          return {
            command: 'Please perform a code review',
            provider: config.ai.codeReviewExecutor,
            context,
            fullContext: content,
            branch: resolvedBranch,
            scenario: 'code-review',
          };
        }
      }

      return null;
    }

    const instructionResult: AiInstruction = {
      command: extractedInstruction.command,
      provider: extractedInstruction.provider || existingSession?.lastProvider || 'claude',
      context,
      fullContext: extractedInstruction.fullContext,
      branch: resolvedBranch,
      scenario: extractedInstruction.scenario ?? defaultScenario,
      specKitCommand: extractedInstruction.specKitCommand,
    };

    logger.info('Extracted AI instruction', {
      projectId: event.project.id,
      issueIid: this.getIssueInfo(event)?.iid,
      mrIid: this.getMergeRequestInfo(event)?.iid,
      provider: instructionResult.provider,
      scenario: instructionResult.scenario,
      triggerType: extractedInstruction.trigger.type,
      triggerHandle:
        extractedInstruction.trigger.type === 'mention'
          ? extractedInstruction.trigger.handle
          : undefined,
      isSpecTrigger: extractedInstruction.trigger.type === 'slash-spec',
      specKitCommand: extractedInstruction.specKitCommand,
      commandPreview: instructionResult.command.substring(0, 80),
    });

    return instructionResult;
  }

  private async getThreadContext(
    type: 'issue' | 'merge_request',
    projectId: number,
    itemIid: number,
    noteId: number
  ): Promise<string | null> {
    try {
      let discussions: any[];

      if (type === 'issue') {
        discussions = await this.gitlabService.getIssueDiscussions(projectId, itemIid);
      } else {
        discussions = await this.gitlabService.getMergeRequestDiscussions(projectId, itemIid);
      }

      const result = await this.gitlabService.findNoteInDiscussions(discussions, noteId);

      if (result) {
        // Store discussion ID for later use in replies
        this.discussionContext.discussionId = result.discussionId;
        const discussionMeta = result.discussion as { resolvable?: boolean; resolved?: boolean } | undefined;
        if (discussionMeta) {
          const isResolvable = discussionMeta.resolvable === true;
          const isResolved = discussionMeta.resolved === true;
          this.discussionContext.discussionResolvable = isResolvable && !isResolved;
        }

        this.discussionContext.discussionNoteId = this.parseDiscussionNoteId((result.note as { id?: number | string } | undefined)?.id);
        this.discussionContext.threadContext = result.threadContext ?? null;

        logger.info('Found thread context for note', {
          projectId,
          itemIid,
          noteId,
          discussionId: result.discussionId,
          contextLength: result.threadContext.length,
        });
        return result.threadContext;
      }

      this.discussionContext.discussionResolvable = false;
      this.discussionContext.discussionReplySucceeded = false;
      this.discussionContext.discussionNoteId = null;
      this.discussionContext.threadContext = null;

      return null;
    } catch (error) {
      logger.error('Failed to get thread context:', error);
      return null;
    }
  }

  private isActualReply(threadContext: string | null): boolean {
    if (!threadContext || !threadContext.trim()) {
      return false;
    }

    // Check if there's meaningful thread context content
    // Thread context should contain previous comments in the discussion
    const hasThreadContext = threadContext.includes('**Thread Context:**');

    if (!hasThreadContext) {
      return false;
    }

    // Extract the content after "**Thread Context:**"
    const contextContent = threadContext.split('**Thread Context:**')[1]?.trim();

    // If there's actual previous conversation content, this is a reply
    // If it's empty or just whitespace, this is the first comment in a new thread
    return Boolean(contextContent && contextContent.length > 0);
  }

  private async buildMergeRequestContext(mergeRequest: { iid: number; title: string; description: string; source_branch: string; target_branch: string; action?: string }, projectId: number): Promise<string> {
    try {
      let context = `MR #${mergeRequest.iid}: ${mergeRequest.title}\n\n`;

      // Add MR description if available and not too long
      if (mergeRequest.description && mergeRequest.description.trim()) {
        const description =
          mergeRequest.description.length > 200
            ? mergeRequest.description.substring(0, 200) + '...'
            : mergeRequest.description;
        context += `**Description:** ${description}\n\n`;
      }

      // Add branch information
      context += `**Source Branch:** ${mergeRequest.source_branch}\n`;
      context += `**Target Branch:** ${mergeRequest.target_branch}\n`;

      // For webhook data, we need to check the original event for changes_count/additions/deletions
      // Since we don't have that info in our simplified mrInfo object, we'll call the API
      try {
        const mrDetails = await this.gitlabService.getMergeRequest(projectId, mergeRequest.iid);

        if (mrDetails.changes_count) {
          context += `**Changes:** ${mrDetails.changes_count} files modified\n`;
        }

        if (mrDetails.additions && mrDetails.deletions) {
          context += `**Additions:** +${mrDetails.additions}, **Deletions:** -${mrDetails.deletions}\n`;
        }
      } catch (error) {
        logger.debug('Could not fetch additional MR details:', error);
      }

      return context.trim();
    } catch (error) {
      logger.error('Error building merge request context:', error);
      return `MR #${mergeRequest.iid}: ${mergeRequest.title}`;
    }
  }

  private async shouldUseSession(
    event: GitLabWebhookEvent,
    precomputedIssueKey?: SessionKey,
    tenant?: TenantUserContext
  ): Promise<{
    useSession: boolean;
    issueKey: string;
    existingSession?: SessionInfo;
  }> {
    // Check if sessions are enabled in configuration
    if (!config.session.enabled) {
      return { useSession: false, issueKey: '' };
    }

    // Generate session key based on event type
    let issueKey = precomputedIssueKey || '';
    const projectId = event.project.id;

    if (!issueKey) {
      if (event.object_kind === 'issue') {
        const issueInfo = this.getIssueInfo(event);
        if (issueInfo) {
          issueKey = this.generateTenantSessionKey(projectId, issueInfo.iid, tenant);
        }
      } else if (event.object_kind === 'note') {
        const issueInfo = this.getIssueInfo(event);
        const mrInfo = this.getMergeRequestInfo(event);

        if (issueInfo) {
          issueKey = this.generateTenantSessionKey(projectId, issueInfo.iid, tenant);
        } else if (mrInfo) {
          issueKey = this.generateTenantSessionKey(projectId, mrInfo.iid, tenant);
        }
      }
    }

    if (!issueKey) {
      return { useSession: false, issueKey: '' };
    }

    // Check if there's an existing active session
    const existingSession = this.sessionManager.getSession(issueKey);

    if (existingSession) {
      const providers = (Object.entries(existingSession.providerSessions) as Array<
        [ProviderType, ProviderSessionInfo | undefined]
      >)
        .filter(([, info]) => Boolean(info?.sessionId))
        .map(([p, info]) => ({
          provider: p,
          sessionId: info!.sessionId,
        }));

      logger.info('Found existing session for conversation', {
        issueKey,
        providers,
        lastUsed: existingSession.lastUsed,
      });

      return {
        useSession: true,
        issueKey,
        existingSession,
      };
    }

    // No existing session, will create new one
    return { useSession: true, issueKey };
  }

  private async handleSessionBasedExecution(
    event: GitLabWebhookEvent,
    instruction: AiInstruction,
    sessionInfo: SessionExecutionContext,
    tenant?: TenantUserContext
  ): Promise<void> {
    const provider = sessionInfo.provider;
    instruction.provider = instruction.provider || provider;
    const executorName = this.getExecutorDisplayName(instruction.provider);
    this.discussionContext.executorName = executorName;

    this.discussionContext.progressMessages = [];

    let providerSessionInfo: ProviderSessionInfo | null = null;
    if (sessionInfo.existingSession?.providerSessions?.[provider]?.sessionId) {
      providerSessionInfo = this.sessionManager.getProviderSession(sessionInfo.issueKey, provider);
    }

    const existingSessionId = providerSessionInfo?.sessionId;
    const hasExistingSession = Boolean(existingSessionId);
    const retryAttempted = Boolean(sessionInfo.retryAttempted);
    const requiresNewSessionId = !existingSessionId;
    const sessionText = requiresNewSessionId
      ? 'new session'
      : `session ${existingSessionId.substring(0, 8)}...`;
    const scenario =
      instruction.scenario ??
      (this.isIssueScenario(event) ? 'issue-session' : 'mr-fix');
    const isSpecScenario = scenario === 'spec-doc';

    const initialMessage = `🚀 ${executorName} is starting to work on your request (${sessionText})...\n\n**Task:** ${instruction.command.substring(0, 100)}${instruction.command.length > 100 ? '...' : ''}\n\n---\n\n⏳ Processing...`;

    this.discussionContext.currentCommentId = await this.createProgressComment(event, initialMessage);

    const baseBranch = sessionInfo.existingSession?.baseBranch ?? instruction.branch ?? event.project.default_branch;
    const branchToCheckout = sessionInfo.existingSession?.branchName ?? baseBranch;

    const ownerId = this.extractOwnerIdFromIssueKey(sessionInfo.issueKey);
    const issueDetailsForSession = this.getIssueInfo(event) || this.getMergeRequestInfo(event);
    let pendingSessionId: string | undefined;

    if (requiresNewSessionId && issueDetailsForSession) {
      pendingSessionId = `pending-${randomUUID()}`;
      this.sessionManager.setSession(
        sessionInfo.issueKey,
        pendingSessionId,
        {
          projectId: event.project.id,
          issueIid: issueDetailsForSession.iid,
          discussionId: this.discussionContext.discussionId || undefined,
          baseBranch,
          ownerId,
        },
        provider
      );
    }

    const projectPath = await this.projectManager.prepareProject(event.project, baseBranch, {
      workspaceId: sessionInfo.issueKey,
      checkoutBranch: branchToCheckout,
      baseBranch,
    });

    try {
      if (isSpecScenario) {
        await this.prepareSpecKitWorkspace(projectPath, event);
      }

      const callback: StreamingProgressCallback = {
        onProgress: async (message: string, isComplete?: boolean) => {
          await this.updateProgressComment(event, message, isComplete);
        },
        onError: async (error: string) => {
          await this.updateProgressComment(event, error, true, true);
        },
      };

      const executionOptions: ExecutionOptions = {
        sessionId: existingSessionId,
        isNewSession: requiresNewSessionId,
        // 始终使用 JSON 格式以获得更干净的输出(避免元数据泄漏)
        outputFormat: 'json',
      };

      this.logAiPrompt({
        action: 'session-execution',
        prompt: instruction.command,
        provider: instruction.provider,
        projectId: event.project.id,
        scenario,
      });
      await this.delayBeforeAiExecution();

      const result = await this.aiExecutor.executeWithSession(
        instruction.command,
        projectPath,
        {
          context: instruction.context,
          fullContext: instruction.fullContext,
          projectUrl: event.project.web_url,
          branch: branchToCheckout,
          event,
          instruction: instruction.command,
          provider: instruction.provider,
          isIssueScenario: this.isIssueScenario(event),
          scenario,
        },
        callback,
        executionOptions
      );

      if (result.success) {
        const issueInfo = this.getIssueInfo(event) || this.getMergeRequestInfo(event);

        if (requiresNewSessionId && result.sessionId && issueInfo) {
          this.sessionManager.setSession(
            sessionInfo.issueKey,
            result.sessionId,
            {
              projectId: event.project.id,
              issueIid: issueInfo.iid,
              discussionId: this.discussionContext.discussionId || undefined,
              baseBranch,
              ownerId,
            },
            provider
          );
        } else if (pendingSessionId && !result.sessionId) {
          this.sessionManager.removeSession(sessionInfo.issueKey, provider);
        }

        await this.handleSuccess(event, instruction, result, baseBranch, projectPath, {
          sessionContext: {
            issueKey: sessionInfo.issueKey,
            sessionId: result.sessionId ?? existingSessionId,
            existingSession: sessionInfo.existingSession,
            baseBranch,
            provider,
            branchToCheckout,
            hasExistingSession,
          },
        });
      } else {
        if (
          existingSessionId &&
          !requiresNewSessionId &&
          !retryAttempted &&
          this.isRecoverableSessionError(result.error)
        ) {
          logger.warn('Session invalid, retrying with new session', {
            issueKey: sessionInfo.issueKey,
            sessionId: existingSessionId,
          });

          this.sessionManager.removeSession(sessionInfo.issueKey, provider);

          await this.handleSessionBasedExecution(event, instruction, {
            issueKey: sessionInfo.issueKey,
            existingSession: sessionInfo.existingSession,
            provider,
            retryAttempted: true,
          }, tenant);

          return;
        }

        await this.handleFailure(event, instruction, result);
        if (pendingSessionId) {
          this.sessionManager.removeSession(sessionInfo.issueKey, provider);
        }
      }
    } finally {
      // 按 issue 复用工作区，不做清理
    }
  }

  private async executeInstructionInternal(
    event: GitLabWebhookEvent,
    instruction: AiInstruction,
    issueKeyForLock?: SessionKey,
    tenant?: TenantUserContext
  ): Promise<void> {
    const executorName = this.getExecutorDisplayName(instruction.provider);
    this.discussionContext.executorName = executorName;

    // Check if this is a merge request event
    if (event.object_kind === 'merge_request') {
      const mrInfo = this.getMergeRequestInfo(event);

      logger.info('Processing MR event', {
        action: mrInfo?.action,
        provider: instruction.provider,
        command: instruction.command.substring(0, 50)
      });

      // Automatically trigger code review for new and reopened MRs targeting develop branch
      if (mrInfo && this.shouldTriggerDefaultCodeReview(mrInfo.action, mrInfo.target_branch)) {
        await this.handleCodeReviewInstruction(event, instruction, tenant);
        return;
      } else if (mrInfo && mrInfo.action === 'update') {
        // For updates, ignore completely (don't process)
        logger.info('MR update detected, ignoring (no processing)');
        return;
      } else {
        logger.info('Skipping processing for MR action:', mrInfo?.action, 'target branch:', mrInfo?.target_branch);
        return;
      }
    }

    // Check if this is a comment on a merge request
    if (this.isMergeRequestComment(event)) {
      await this.handleMergeRequestComment(event, instruction, issueKeyForLock, tenant);
      return;
    }

    // Check if we should use session for this event
    const sessionInfo = await this.shouldUseSession(event, issueKeyForLock, tenant);

    if (sessionInfo.useSession) {
      const resolvedProvider =
        instruction.provider ||
        sessionInfo.existingSession?.lastProvider ||
        (config.ai.executor as ProviderType);
      // Use session-based execution for issue comments and regular issue events
      await this.handleSessionBasedExecution(event, instruction, {
        issueKey: sessionInfo.issueKey,
        provider: resolvedProvider,
        existingSession: sessionInfo.existingSession,
        retryAttempted: false,
      }, tenant);
    } else {
      // Fallback to regular execution for events that don't support sessions
      await this.handleRegularExecution(event, instruction);
    }
  }

  private async executeInstruction(
    event: GitLabWebhookEvent,
    instruction: AiInstruction,
    options?: { issueKey?: SessionKey | null },
    tenant?: TenantUserContext
  ): Promise<void> {
    const issueKey = options?.issueKey ?? this.getIssueKeyFromEvent(event, tenant);

    if (issueKey) {
      await this.runWithIssueLock(issueKey, () => this.executeInstructionInternal(event, instruction, issueKey, tenant));
      return;
    }

    await this.executeInstructionInternal(event, instruction, undefined, tenant);
  }

  private async handleRegularExecution(
    event: GitLabWebhookEvent,
    instruction: AiInstruction
  ): Promise<void> {
    const executorName = this.getExecutorDisplayName(instruction.provider);

    this.discussionContext.executorName = executorName;

    // Clear previous progress messages for this new instruction
    this.discussionContext.progressMessages = [];

    const scenario =
      instruction.scenario ??
      (this.isIssueScenario(event) ? 'issue-session' : 'mr-fix');
    const isSpecScenario = scenario === 'spec-doc';

    // Create initial progress comment
    const initialMessage = `🚀 ${executorName} is starting to work on your request...\n\n**Task:** ${instruction.command.substring(0, 100)}${instruction.command.length > 100 ? '...' : ''}\n\n---\n\n⏳ Processing...`;

    this.discussionContext.currentCommentId = await this.createProgressComment(event, initialMessage);

    const baseBranch = instruction.branch || event.project.default_branch;
    const projectPath = await this.projectManager.prepareProject(event.project, baseBranch);

    if (isSpecScenario) {
      await this.prepareSpecKitWorkspace(projectPath, event);
    }

    // Create streaming callback for real-time updates
    const callback: StreamingProgressCallback = {
      onProgress: async (message: string, isComplete?: boolean) => {
        await this.updateProgressComment(event, message, isComplete);
      },
      onError: async (error: string) => {
        await this.updateProgressComment(event, error, true, true);
      },
    };

    // Execute instruction without session support (fallback)
    this.logAiPrompt({
      action: 'regular-execution',
      prompt: instruction.command,
      provider: instruction.provider,
      projectId: event.project.id,
      scenario,
    });
    await this.delayBeforeAiExecution();

    const result = await this.aiExecutor.executeWithStreaming(
      instruction.command,
      projectPath,
      {
        context: instruction.context,
        projectUrl: event.project.web_url,
        branch: baseBranch,
        event,
        instruction: instruction.command,
        provider: instruction.provider,
        isIssueScenario: this.isIssueScenario(event),
        scenario,
      },
      callback
    );

    if (result.success) {
      await this.handleSuccess(event, instruction, result, baseBranch, projectPath);
    } else {
      await this.handleFailure(event, instruction, result);
    }
  }

  // Note: isCodeReviewInstruction method was removed as MR updates no longer trigger code reviews

  private shouldTriggerDefaultCodeReview(action?: string, targetBranch?: string): boolean {
    // 当没有显式提及 @claude 或 @codex 时，判断是否应该触发默认的自动代码审查
    // 只在目标分支是 develop 且动作是 open/reopen 时触发
    // GitLab MR actions include: 'open', 'reopen', 'update', 'merge', 'close'
    const isValidAction = action === 'open' || action === 'reopen' || !action;
    const isTargetDevelop = targetBranch === 'develop';
    return isValidAction && isTargetDevelop;
  }

  private isIssueScenario(event: GitLabWebhookEvent): boolean {
    // Issue scenario: direct issue events or notes on issues (not MR comments)
    if (event.object_kind === 'issue') {
      return true;
    }
    if (event.object_kind === 'note') {
      // It's an issue comment if there's issue info but no MR info
      const issueInfo = this.getIssueInfo(event);
      const mrInfo = this.getMergeRequestInfo(event);
      return issueInfo !== null && mrInfo === null;
    }
    return false;
  }

  private isMergeRequestComment(event: GitLabWebhookEvent): boolean {
    return event.object_kind === 'note' && this.getMergeRequestInfo(event) !== null;
  }

  private async handleMergeRequestComment(
    event: GitLabWebhookEvent,
    instruction: AiInstruction,
    issueKeyForLock?: SessionKey,
    tenant?: TenantUserContext
  ): Promise<void> {
    const mrInfo = this.getMergeRequestInfo(event);

    if (!mrInfo) {
      logger.error('No merge request info found for MR comment');
      return;
    }

    logger.info('Processing MR comment instruction - will modify source branch directly', {
      projectId: event.project.id,
      mrIid: mrInfo.iid,
      sourceBranch: mrInfo.source_branch,
      instruction: instruction.command.substring(0, 100)
    });

    // Work directly on the source branch of the MR
    const sourceBranch = mrInfo.source_branch;
    const workspaceId = this.getMergeRequestWorkspaceId(event.project.id, mrInfo.iid);
    const sessionKey =
      issueKeyForLock ?? this.getIssueKeyFromEvent(event, tenant) ?? null;
    const existingSession = sessionKey ? this.sessionManager.getSession(sessionKey) : null;
    const provider =
      instruction.provider ||
      existingSession?.lastProvider ||
      (config.ai.executor as ProviderType);
    instruction.provider = provider;
    const executorName = this.getExecutorDisplayName(provider);
    this.discussionContext.executorName = executorName;

    // Clear previous progress messages
    this.discussionContext.progressMessages = [];

    // Create initial progress comment
    const initialMessage = `🔧 ${executorName} is working on your code changes in branch \`${mrInfo.source_branch}\`...\n\n**Task:** ${instruction.command.substring(0, 100)}${instruction.command.length > 100 ? '...' : ''}\n\n---\n\n⏳ Processing...`;
    this.discussionContext.currentCommentId = await this.createProgressComment(event, initialMessage);

    let providerSessionInfo: ProviderSessionInfo | null = null;
    if (sessionKey && existingSession?.providerSessions?.[provider]?.sessionId) {
      providerSessionInfo = this.sessionManager.getProviderSession(sessionKey, provider);
    }

    const existingSessionId = providerSessionInfo?.sessionId;
    const hasExistingSession = Boolean(existingSessionId);
    const ownerId = sessionKey ? this.extractOwnerIdFromIssueKey(sessionKey) : undefined;

    const projectPath = await this.projectManager.prepareProject(event.project, sourceBranch, {
      workspaceId,
      checkoutBranch: sourceBranch,
      baseBranch: sourceBranch,
    });

    if (instruction) {
      const enrichedContext = await this.buildMergeRequestCommentContext(
        event,
        instruction.context,
        projectPath
      );

      if (enrichedContext) {
        instruction.context = enrichedContext;
        instruction.fullContext = instruction.fullContext
          ? `${instruction.fullContext}\n\n${enrichedContext}`
          : enrichedContext;
      }
    }

    // Create streaming callback for real-time updates
    const callback: StreamingProgressCallback = {
      onProgress: async (message: string, isComplete?: boolean) => {
        await this.updateProgressComment(event, message, isComplete);
      },
      onError: async (error: string) => {
        await this.updateProgressComment(event, error, true, true);
      },
    };

    // Execute instruction on the source branch
    this.logAiPrompt({
      action: sessionKey ? 'mr-comment-session' : 'mr-comment',
      prompt: instruction.command,
      provider: instruction.provider,
      projectId: event.project.id,
      scenario: 'mr-fix',
    });
    await this.delayBeforeAiExecution();

    let result: any;

    if (sessionKey) {
      const executionOptions: ExecutionOptions = {
        sessionId: existingSessionId,
        isNewSession: !existingSessionId,
        // 始终使用 JSON 格式以获得更干净的输出(避免元数据泄漏)
        outputFormat: 'json',
      };

      result = await this.aiExecutor.executeWithSession(
        instruction.command,
        projectPath,
        {
          context: instruction.context,
          fullContext: instruction.fullContext,
          projectUrl: event.project.web_url,
          branch: sourceBranch,
          event,
          instruction: instruction.command,
          provider: instruction.provider,
          isIssueScenario: this.isIssueScenario(event),
          scenario: 'mr-fix',
        },
        callback,
        executionOptions
      );
    } else {
      result = await this.aiExecutor.executeWithStreaming(
        instruction.command,
        projectPath,
        {
          context: instruction.context,
          fullContext: instruction.fullContext,
          projectUrl: event.project.web_url,
          branch: sourceBranch,
          event,
          instruction: instruction.command,
          provider: instruction.provider,
          isIssueScenario: this.isIssueScenario(event),
          scenario: 'mr-fix',
        },
        callback
      );
    }

    if (result.success) {
      if (sessionKey) {
        const sessionIdForUpdate = result.sessionId ?? existingSessionId;
        if (sessionIdForUpdate) {
          const mergeRequestUrl =
            ((event.merge_request as { url?: string } | undefined)?.url) ??
            `${event.project.web_url}/-/merge_requests/${mrInfo.iid}`;

          this.sessionManager.setSession(
            sessionKey,
            sessionIdForUpdate,
              {
                projectId: event.project.id,
                issueIid: mrInfo.iid,
                discussionId: this.discussionContext.discussionId || undefined,
                branchName: sourceBranch,
                baseBranch: sourceBranch,
                mergeRequestIid: mrInfo.iid,
                mergeRequestUrl,
                ownerId,
              },
              provider
          );
        } else if (!hasExistingSession) {
          logger.warn('AI session execution succeeded but no sessionId returned for MR comment', {
            sessionKey,
          });
        }
      }

      await this.handleMRCommentSuccess(
        event,
        instruction,
        result,
        sourceBranch,
        projectPath,
        mrInfo,
        {
          sessionContext: sessionKey
            ? {
                sessionKey,
                sessionId: result.sessionId ?? existingSessionId,
                provider,
              }
            : undefined,
        }
      );
    } else {
      if (
        sessionKey &&
        hasExistingSession &&
        this.isRecoverableSessionError(result.error)
      ) {
        logger.warn('MR comment session invalid, removing session and retrying', {
          sessionKey,
        });
        this.sessionManager.removeSession(sessionKey, provider);
        await this.handleMergeRequestComment(event, instruction, sessionKey, tenant);
        return;
      }

      await this.handleFailure(event, instruction, result);
    }
  }

  private async handleMRCommentSuccess(
    event: GitLabWebhookEvent,
    instruction: AiInstruction,
    result: any,
    sourceBranch: string,
    projectPath: string,
    mrInfo: { iid: number; title: string; description: string; source_branch: string; target_branch: string; action?: string },
    options?: {
      sessionContext?: {
        sessionKey?: SessionKey;
        sessionId?: string;
        provider: 'claude' | 'codex';
      };
    }
  ): Promise<void> {
    const executorName = this.getExecutorDisplayName(instruction.provider);
    this.discussionContext.executorName = executorName;

    logger.info(`${executorName} MR comment instruction executed successfully`, {
      projectId: event.project.id,
      mrIid: mrInfo.iid,
      sourceBranch,
      hasChanges: result.changes?.length > 0,
    });

    let responseMessage = `✅ ${executorName} completed the changes in branch \`${sourceBranch}\`.\n\n`;

    const summaryLines: string[] = [];
    const changeSummary = this.buildChangeSummary(result.changes ?? []);
    const outputSummary = this.summarizeOutput(result.output);

    if (changeSummary.length > 0) {
      summaryLines.push(...changeSummary);
    }
    if (outputSummary) {
      summaryLines.push(`- ${outputSummary}`);
    }

    if (summaryLines.length > 0) {
      responseMessage += '**梗概：**\n';
      responseMessage += summaryLines.join('\n');
      responseMessage += '\n\n';
    }

    if (result.changes?.length > 0) {
      responseMessage += `**变更分支：\`${sourceBranch}\`**\n`;
      for (const change of result.changes) {
        responseMessage += `- ${change.type}: \`${change.path}\`\n`;
      }
      responseMessage += '\n';

      // Commit and push changes to the source branch
      try {
        await this.updateProgressComment(event, `Committing changes to \`${sourceBranch}\`...`);

        // Create a meaningful commit message based on the instruction
        const commitMessage = `${instruction.command.length > 50 ? instruction.command.substring(0, 50) + '...' : instruction.command}

🤖 Generated with Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>`;

        // Commit and push directly to the source branch
        const pushResult = await this.projectManager.commitAndPushChanges(projectPath, commitMessage);

        if (pushResult.success) {
          await this.updateProgressComment(
            event,
            pushResult.rebased
              ? `Successfully pushed changes to \`${sourceBranch}\` after rebasing with latest upstream.`
              : `Successfully pushed changes to \`${sourceBranch}\`.`
          );

          responseMessage += `🔄 **Changes have been pushed to \`${sourceBranch}\`**\n`;
          if (pushResult.rebased) {
            responseMessage += `已自动执行 \`git pull --rebase\` 同步最新远端提交。\n`;
          }
          responseMessage += `The merge request will automatically update with your changes.\n\n`;
        } else if (pushResult.conflicts && pushResult.conflicts.length > 0) {
          await this.updateProgressComment(
            event,
            `⚠️ 推送失败：\`git pull --rebase\` 过程中出现冲突，需要解决 ${pushResult.conflicts.length} 个冲突文件。`
          );

          const resolved = await this.resolvePushConflictsWithAi(
            event,
            instruction,
            projectPath,
            sourceBranch,
            pushResult.conflicts,
            options?.sessionContext
          );

          if (resolved) {
            responseMessage += `🛠️ **检测到远端更新并自动合并**\n`;
            responseMessage += `AI 已解决 rebase 冲突并完成推送。\n\n`;
          } else {
            responseMessage += `⚠️ **Note:** 远端存在新的提交且自动解决冲突失败，请手动处理以下文件：\n`;
            pushResult.conflicts.forEach(conflict => {
              responseMessage += `- ${conflict}\n`;
            });
            responseMessage += '\n';
          }
        } else {
          const errorMessage = pushResult.error ?? 'Unknown git error';
          logger.error('Failed to commit and push changes to source branch:', errorMessage);
          responseMessage += `⚠️ **Note:** Changes were made但推送到 \`${sourceBranch}\` 失败：${errorMessage}\n\n`;
        }
      } catch (error) {
        logger.error('Failed to commit and push changes to source branch:', error);
        responseMessage += `⚠️ **Note:** Changes were made but could not be pushed to \`${sourceBranch}\`: ${error instanceof Error ? error.message : String(error)}\n\n`;
      }
    } else {
      // No changes, just post the result
      responseMessage += '📋 No file changes were made.\n';
    }

    await this.postComment(event, responseMessage);

    await this.resolveCurrentDiscussionIfNeeded(event, mrInfo);
  }

  private async resolvePushConflictsWithAi(
    event: GitLabWebhookEvent,
    instruction: AiInstruction,
    projectPath: string,
    sourceBranch: string,
    conflicts: string[],
    sessionContext?: {
      sessionKey?: SessionKey;
      sessionId?: string;
      provider: ProviderType;
    }
  ): Promise<boolean> {
    if (!sessionContext?.sessionKey) {
      logger.warn('Cannot auto-resolve conflicts without session context');
      return false;
    }

    const provider =
      sessionContext.provider ??
      this.sessionManager.getSession(sessionContext.sessionKey)?.lastProvider ??
      (instruction.provider || 'claude');

    const existingProviderSession =
      sessionContext.sessionId ??
      this.sessionManager.getProviderSession(sessionContext.sessionKey, provider)?.sessionId;

    const existingSessionId = existingProviderSession;

    const conflictList = conflicts.map(file => `- ${file}`).join('\n');

    await this.updateProgressComment(
      event,
      `⚙️ 正在尝试自动解决冲突。\n冲突文件：\n${conflictList}`
    );

    const conflictCommand = [
      '当前执行 `git pull --rebase` 时出现了冲突，需要自动完成以下流程：',
      '1. 分析冲突文件并修复冲突标记。',
      '2. 确保代码可以编译/运行（如有必要可运行测试）。',
      '3. 使用 `git add` 标记冲突已解决。',
      '4. 如果 rebase 仍在进行，请执行 `git rebase --continue` 完成流程。',
      '5. 最后运行 `git push`，确保变更已经推送到远端。',
      '',
      '请给出简要说明，确认冲突已解决且推送完成。',
    ].join('\n');

    const callback: StreamingProgressCallback = {
      onProgress: async (message: string, isComplete?: boolean) => {
        await this.updateProgressComment(event, message, isComplete);
      },
      onError: async (error: string) => {
        await this.updateProgressComment(event, error, true, true);
      },
    };

    const executionOptions: ExecutionOptions = {
      sessionId: existingSessionId ?? undefined,
      isNewSession: !existingSessionId,
      // 始终使用 JSON 格式以获得更干净的输出(避免元数据泄漏)
      outputFormat: 'json',
    };

    const aiResult = await this.aiExecutor.executeWithSession(
      conflictCommand,
      projectPath,
      {
        context: `${instruction.context ?? ''}\n\n冲突文件：\n${conflictList}`,
        fullContext: instruction.fullContext,
        projectUrl: event.project.web_url,
        branch: sourceBranch,
        event,
        instruction: conflictCommand,
        provider,
        isIssueScenario: false,
        scenario: 'mr-fix',
      },
      callback,
      executionOptions
    );

    if (!aiResult.success) {
      await this.updateProgressComment(
        event,
        '❌ 自动解决冲突失败，请手动处理冲突后重新运行。'
      );
      return false;
    }

    const pushResult = await this.projectManager.pushAfterConflictResolution(projectPath);

    if (pushResult.success) {
      await this.updateProgressComment(
        event,
        `✅ 冲突已解决并成功推送到 \`${sourceBranch}\`。`
      );
      return true;
    }

    if (pushResult.conflicts && pushResult.conflicts.length > 0) {
      await this.updateProgressComment(
        event,
        `⚠️ 自动解决冲突失败，仍存在冲突文件：\n${pushResult.conflicts
          .map(file => `- ${file}`)
          .join('\n')}`
      );
    } else {
      await this.updateProgressComment(
        event,
        `⚠️ 冲突处理后推送仍失败：${pushResult.error ?? '未知错误'}`
      );
    }

    return false;
  }

  private async appendSummaryToMRDescription(
    event: GitLabWebhookEvent,
    mrInfo: { iid: number; title: string; description: string },
    instruction: AiInstruction,
    changes: Array<{ path: string; type: string }>,
    outputSummary: string | null
  ): Promise<void> {
    logger.info('appendSummaryToMRDescription called', {
      projectId: event.project.id,
      mrIid: mrInfo.iid,
      changeCount: changes.length,
      hasOutputSummary: !!outputSummary
    });
    
    try {
      // Fetch the current MR to get the latest description
      logger.info('Fetching current MR details', {
        projectId: event.project.id,
        mrIid: mrInfo.iid
      });
      
      const currentMR = await this.gitlabService.getMergeRequest(event.project.id, mrInfo.iid);
      const currentDescription = currentMR.description || '';
      
      logger.info('Current MR fetched', {
        projectId: event.project.id,
        mrIid: mrInfo.iid,
        currentDescriptionLength: currentDescription.length,
        mrTitle: currentMR.title
      });

      // Build the summary section
      let summary = '\n\n---\n\n';
      
      if (outputSummary) {
        summary += `**摘要：** ${outputSummary}\n\n`;
      }
      
      const newDescription = currentDescription + summary;
      
      await this.gitlabService.updateMergeRequestDescription(
        event.project.id,
        mrInfo.iid,
        newDescription
      );
      
      logger.info('Successfully appended summary to MR description', {
        projectId: event.project.id,
        mrIid: mrInfo.iid,
        changeCount: changes.length
      });
    } catch (error) {
      logger.error('Failed to append summary to MR description:', error);
      throw error;
    }
  }

  private async resolveCurrentDiscussionIfNeeded(
    event: GitLabWebhookEvent,
    mrInfo?: { iid: number }
  ): Promise<void> {
    if (
      !this.discussionContext.discussionId ||
      !this.discussionContext.discussionResolvable ||
      !this.discussionContext.discussionReplySucceeded
    ) {
      return;
    }

    const mergeRequest = mrInfo ?? this.getMergeRequestInfo(event);
    if (!mergeRequest) {
      this.discussionContext.discussionResolvable = false;
      this.discussionContext.discussionReplySucceeded = false;
      return;
    }

    try {
      await this.gitlabService.resolveMergeRequestDiscussion(
        event.project.id,
        mergeRequest.iid,
        this.discussionContext.discussionId
      );

      logger.info('Resolved merge request discussion after successful fix', {
        projectId: event.project.id,
        mergeRequestIid: mergeRequest.iid,
        discussionId: this.discussionContext.discussionId,
      });
    } catch (error) {
      logger.error('Failed to resolve merge request discussion automatically:', error);
    } finally {
      // Prevent repeated attempts in the same processing cycle
      this.discussionContext.discussionResolvable = false;
      this.discussionContext.discussionReplySucceeded = false;
    }
  }

  private async handleCodeReviewInstruction(
    event: GitLabWebhookEvent,
    instruction: AiInstruction,
    tenant?: TenantUserContext
  ): Promise<void> {
    const executorName = this.getExecutorDisplayName(instruction.provider);
    this.discussionContext.executorName = executorName;
    const mrInfo = this.getMergeRequestInfo(event);
    if (!mrInfo) {
      logger.error('No merge request info found for code review');
      return;
    }

    // 获取或创建 session
    const sessionKey = this.getIssueKeyFromEvent(event, tenant);
    const existingSession = sessionKey ? this.sessionManager.getSession(sessionKey) : null;
    const provider = instruction.provider || existingSession?.lastProvider || (config.ai.executor as ProviderType);
    instruction.provider = provider;

    // Clear previous progress messages
    this.discussionContext.progressMessages = [];

    // 检查是否有现有的 provider session
    let providerSessionInfo: ProviderSessionInfo | null = null;
    if (sessionKey && existingSession?.providerSessions?.[provider]?.sessionId) {
      providerSessionInfo = this.sessionManager.getProviderSession(sessionKey, provider);
    }

    const existingSessionId = providerSessionInfo?.sessionId;
    const requiresNewSessionId = !existingSessionId;
    const sessionText = requiresNewSessionId
      ? 'new session'
      : `session ${existingSessionId.substring(0, 8)}...`;

    // Create initial progress comment
    const initialMessage = `🔍 ${executorName} is starting code review (${sessionText})...\n\n**Task:** ${instruction.command}\n\n---\n\n⏳ Analyzing changes...`;
    this.discussionContext.currentCommentId = await this.createProgressComment(event, initialMessage);

    try {
      await this.updateProgressComment(event, 'Fetching merge request diffs...');

      // Get MR diffs
      const diffs = await this.gitlabService.getMergeRequestDiffs(event.project.id, mrInfo.iid);
      const mergeRequest = await this.gitlabService.getMergeRequest(event.project.id, mrInfo.iid);
      const summaryChanges = this.mapDiffsToFileChanges(diffs);

      const baseBranch = instruction.branch || mrInfo.source_branch;
      const workspaceId = this.getMergeRequestWorkspaceId(event.project.id, mrInfo.iid);
      const projectPath = await this.projectManager.prepareProject(event.project, baseBranch, {
        workspaceId,
        checkoutBranch: baseBranch,
        baseBranch,
      });

      await this.updateProgressComment(event, `Found ${diffs.length} changed files`);

      // Parse diffs
      const parsedDiff = DiffParser.parseMergeRequestDiffs(diffs, mergeRequest);
      const reviewableLines = DiffParser.getReviewableLines(parsedDiff);
      const filteredLines = DiffParser.filterLinesNeedingReview(reviewableLines);

      await this.updateProgressComment(event, `Identified ${filteredLines.length} lines for review`);

      let changeSummaryText: string | null = null;

      const appendChangeSummary = async (): Promise<void> => {
        if (summaryChanges.length === 0) {
          logger.info('Skipping MR description update for code review summary - no diff changes detected', {
            projectId: event.project.id,
            mrIid: mrInfo.iid,
          });
          return;
        }
        if (!changeSummaryText) {
          logger.info('Skipping MR description update - change summary text empty', {
            projectId: event.project.id,
            mrIid: mrInfo.iid,
          });
          return;
        }

        logger.info('Attempting to append code review summary to MR description', {
          projectId: event.project.id,
          mrIid: mrInfo.iid,
          changeCount: summaryChanges.length,
        });

        try {
          await this.appendSummaryToMRDescription(
            event,
            mrInfo,
            instruction,
            summaryChanges,
            changeSummaryText
          );
          logger.info('Successfully appended code review summary to MR description', {
            projectId: event.project.id,
            mrIid: mrInfo.iid,
          });
        } catch (appendError) {
          logger.error('Failed to append code review summary to MR description', {
            error: appendError instanceof Error ? appendError.message : String(appendError),
            projectId: event.project.id,
            mrIid: mrInfo.iid,
          });
        }
      };

      if (filteredLines.length === 0) {
        await this.updateProgressComment(event, 'No significant changes found to review', true);
        await this.postComment(event, '✅ Code review completed. No significant issues found in the changes.');
        if (!changeSummaryText) {
          changeSummaryText = this.buildCodeChangeSummaryText(summaryChanges);
        }

        await this.ensureMergeRequestTitleFormat(
          event,
          mrInfo,
          mergeRequest.title ?? '',
          instruction,
          summaryChanges
        );

        await appendChangeSummary();
        return;
      }

      // Create context for AI with diff information
      const reviewContext = this.createCodeReviewContext(parsedDiff, filteredLines);

      await this.updateProgressComment(event, `Sending code to ${executorName} for analysis...`);

      const reviewPrompt = await this.createCodeReviewPrompt(
        instruction.command,
        reviewContext,
        instruction.fullContext,
        mergeRequest.title,
        mrInfo.source_branch
      );

      const ownerId = sessionKey ? this.extractOwnerIdFromIssueKey(sessionKey) : undefined;
      let pendingSessionId: string | undefined;

      // 如果需要新 session，先创建一个 pending session
      if (sessionKey && requiresNewSessionId) {
        pendingSessionId = `pending-${randomUUID()}`;
        this.sessionManager.setSession(
          sessionKey,
          pendingSessionId,
          {
            projectId: event.project.id,
            issueIid: mrInfo.iid,
            discussionId: this.discussionContext.discussionId || undefined,
                branchName: baseBranch,
                baseBranch,
                mergeRequestIid: mrInfo.iid,
                mergeRequestUrl: ((event.merge_request as { url?: string } | undefined)?.url) ?? `${event.project.web_url}/-/merge_requests/${mrInfo.iid}`,
                ownerId,
              },
              provider
        );
      }

      this.logAiPrompt({
        action: sessionKey ? 'code-review-session' : 'code-review',
        prompt: reviewPrompt,
        provider: instruction.provider,
        projectId: event.project.id,
        scenario: 'code-review',
      });
      await this.delayBeforeAiExecution();

      const executionOptions: ExecutionOptions = {
        sessionId: existingSessionId,
        isNewSession: requiresNewSessionId,
        // 始终使用 JSON 格式以获得更干净的输出(避免元数据泄漏)
        outputFormat: 'json',
      };

      const result = sessionKey
        ? await this.aiExecutor.executeWithSession(
            reviewPrompt,
            projectPath,
            {
              context: instruction.context,
              fullContext: instruction.fullContext,
              projectUrl: event.project.web_url,
              branch: baseBranch,
              event,
              instruction: reviewPrompt,
              provider: instruction.provider,
              isIssueScenario: this.isIssueScenario(event),
              scenario: 'code-review',
            },
            {
              onProgress: async (message: string, isComplete?: boolean) => {
                await this.updateProgressComment(event, message, isComplete);
              },
              onError: async (error: string) => {
                await this.updateProgressComment(event, error, true, true);
              },
            },
            executionOptions
          )
        : await this.aiExecutor.executeWithStreaming(
            reviewPrompt,
            projectPath,
            {
              context: instruction.context,
              projectUrl: event.project.web_url,
              branch: baseBranch,
              event,
              instruction: reviewPrompt,
              provider: instruction.provider,
              isIssueScenario: this.isIssueScenario(event),
              scenario: 'code-review',
            },
            {
              onProgress: async (message: string, isComplete?: boolean) => {
                await this.updateProgressComment(event, message, isComplete);
              },
              onError: async (error: string) => {
                await this.updateProgressComment(event, error, true, true);
              },
            }
          );

      if (result.success && result.output) {
        // 保存 session（如果有）
        if (sessionKey && 'sessionId' in result) {
          const newSessionId = typeof result.sessionId === 'string' ? result.sessionId : undefined;
          const sessionIdForUpdate = newSessionId || existingSessionId;
          if (typeof sessionIdForUpdate === 'string') {
            this.sessionManager.setSession(
              sessionKey,
              sessionIdForUpdate,
              {
                projectId: event.project.id,
                issueIid: mrInfo.iid,
                discussionId: this.discussionContext.discussionId || undefined,
                branchName: baseBranch,
                baseBranch,
                mergeRequestIid: mrInfo.iid,
                mergeRequestUrl: ((event.merge_request as { url?: string } | undefined)?.url) ?? `${event.project.web_url}/-/merge_requests/${mrInfo.iid}`,
                ownerId,
              },
              provider
            );
          } else if (pendingSessionId && !newSessionId) {
            // 如果创建 session 失败，清理 pending session
            this.sessionManager.removeSession(sessionKey, provider);
          }
        }

        await this.updateProgressComment(event, 'Processing review comments...');

        // Parse AI response into structured comments
        const {
          reviewComments,
          summaryText,
          titleSuggestion,
        } = this.parseCodeReviewOutput(result.output);

        if (!summaryText) {
          changeSummaryText = this.buildCodeChangeSummaryText(summaryChanges);
        } else {
          changeSummaryText = summaryText;
        }

        await this.ensureMergeRequestTitleFormat(
          event,
          mrInfo,
          mergeRequest.title ?? '',
          instruction,
          summaryChanges,
          titleSuggestion
        );

        if (reviewComments.length > 0) {
          await this.updateProgressComment(event, `Creating ${reviewComments.length} inline comments...`);

          // Create inline comments
          await this.codeReviewService.performInlineReview(
            event.project.id,
            mrInfo.iid,
            reviewComments
          );

          await this.updateProgressComment(event, 'Code review completed!', true);
          await this.postComment(event, `✅ Code review completed! Created ${reviewComments.length} inline comments. Please review the suggestions.`);
        } else {
          await this.updateProgressComment(event, 'No specific issues found', true);
          await this.postComment(event, '✅ Code review completed. No specific issues found in the changes.');
        }
        await appendChangeSummary();
      } else {
        await this.ensureMergeRequestTitleFormat(
          event,
          mrInfo,
          mergeRequest.title ?? '',
          instruction,
          summaryChanges
        );
        await this.handleFailure(event, instruction, result);
      }

    } catch (error) {
      logger.error('Code review failed:', error);
      await this.updateProgressComment(event, `Error: ${error instanceof Error ? error.message : String(error)}`, true, true);
      await this.reportError(event, error);
    }
  }

  private createCodeReviewContext(parsedDiff: any, reviewableLines: any[]): string {
    let context = '**Code Review Context:**\n\n';

    context += `**Files Changed:** ${parsedDiff.files.length}\n`;
    context += `**Lines to Review:** ${reviewableLines.length}\n\n`;

    // Group by file
    const fileGroups = reviewableLines.reduce((acc, item) => {
      const filePath = item.file.newPath;
      if (!acc[filePath]) {
        acc[filePath] = [];
      }
      acc[filePath].push(item);
      return acc;
    }, {} as Record<string, any[]>);

    context += '**Changed Files and Lines:**\n';
    for (const [filePath, lines] of Object.entries(fileGroups)) {
      context += `\n### ${filePath}\n`;
      (lines as any[]).forEach((item: any) => {
        const reason = item.reviewReason ? ` (${item.reviewReason})` : '';
        context += `- Line ${item.lineNumber}: \`${item.line.content.trim()}\`${reason}\n`;
      });
    }

    return context;
  }

  private async createCodeReviewPrompt(
    originalCommand: string,
    reviewContext: string,
    fullContext?: string,
    mergeRequestTitle?: string,
    sourceBranch?: string
  ): Promise<string> {
    // Read project-specific guidelines
    let guidelines = '';
    try {
      const fs = await import('fs');
      const path = await import('path');
      const guidelinesPath = path.join(process.cwd(), 'CODE_REVIEW_GUIDELINES.md');
      guidelines = await fs.promises.readFile(guidelinesPath, 'utf8');
    } catch (error) {
      logger.warn('Could not load CODE_REVIEW_GUIDELINES.md, using default guidelines');
      guidelines = 'Use standard code review practices focusing on security, performance, and maintainability.';
    }

    let prompt = `Perform a detailed code review based on the following request: "${originalCommand}"

${reviewContext}`;

    // Include full context if available
    if (fullContext && fullContext.trim() && fullContext !== originalCommand) {
      prompt += `

**Full Context from Original Message:**
${fullContext}

Please consider the complete context when performing the review.`;
    }

    // Include MR title and branch information
    if (mergeRequestTitle || sourceBranch) {
      prompt += `

**Merge Request Context:**`;
      if (mergeRequestTitle) {
        prompt += `
- **Original MR Title:** ${mergeRequestTitle}`;
      }
      if (sourceBranch) {
        prompt += `
- **Source Branch:** ${sourceBranch}`;
      }
    }

    prompt += `

**Project-Specific Code Review Guidelines:**
${guidelines}

**CRITICAL CONSTRAINT**: You must ONLY review and comment on files that are listed in the "Changed Files and Lines" section above. DO NOT reference, analyze, or comment on any files that are not explicitly shown in the diff context. If you identify issues related to files not in the current changes, mention them in general terms but do not create specific File/Line comments for them.

Please analyze the changed code and provide feedback according to the guidelines above. For any issues you find, use EXACTLY this format (including the **bold** formatting):

**File:** [file path from the "Changed Files and Lines" section above]
**Line:** [line number from the "Changed Files and Lines" section above]
**Comment:** [your review comment]
**Severity:** [error|warning|info]
**Category:** [style|security|performance|logic|maintainability|testing]

Once you finish listing all issues, output the following delimiter on its own line:
===MR_SUMMARY_START===

After the delimiter, produce a single JSON block summarizing the merge request changes. Follow this schema:
{
  "title": "类型: 简洁的中文标题， 优先参考原始title的关键词",
  "overview": "一句话概述核心变更",
  "majorChanges": ["最多3条主要改动"],
  "technicalHighlights": ["最多2条技术要点"],
  "risks": ["最多2条潜在风险"],
  "tests": ["最多2条测试建议"]
}

Rules for the summary JSON (请严格遵守):
1. **语言要求**: 全部使用中文
2. **标题格式**: title 必须遵循约定式提交格式,例如 "feat: 添加用户认证功能"、"fix: 修复登录错误"
3. **标题类型判断**: 优先根据原始 MR Title 关键词判断类型,其次参考分支名称
4. **精简原则**: 每个数组字段控制在2-3条以内,用最精炼的语言表达核心信息
5. **overview**: 限制在一句话(20-30字),概括最核心的变更
6. **majorChanges**: 只列出最重要的改动,使用"模块: 行为变更"格式
7. 如果某个字段确实没有内容,使用 "无"
8. 分隔符后**只输出** JSON,不要有其他注释或解释

IMPORTANT:
1. Only use the structured format above for files explicitly listed in the "Changed Files and Lines" section
2. File paths must exactly match those shown in the context above
3. Line numbers must be from the lines specifically shown in the context above
4. You can provide general commentary before or after, but use the exact **Field:** format only for specific line-by-line feedback on changed files`;

    return prompt;
  }

  private parseCodeReviewOutput(rawOutput: string): {
    reviewComments: ReviewComment[];
    summaryText: string | null;
    titleSuggestion: string | null;
  } {
    if (!rawOutput || !rawOutput.trim()) {
      return {
        reviewComments: [],
        summaryText: null,
        titleSuggestion: null,
      };
    }

    const delimiterIndex = rawOutput.indexOf(MR_SUMMARY_DELIMITER);
    let reviewSection = rawOutput;
    let summarySection = '';

    if (delimiterIndex !== -1) {
      reviewSection = rawOutput.slice(0, delimiterIndex).trim();
      summarySection = rawOutput.slice(delimiterIndex + MR_SUMMARY_DELIMITER.length).trim();
    }

    const reviewComments = CodeReviewService.parseAiReviewResponse(reviewSection);

    let summaryText: string | null = null;
    let titleSuggestion: string | null = null;
    if (summarySection) {
      const parsedSummary = this.parseMergeRequestSummary(summarySection);
      titleSuggestion = parsedSummary?.title ?? null;
      summaryText = this.formatMergeRequestSummary(parsedSummary);
    }

    return {
      reviewComments,
      summaryText,
      titleSuggestion,
    };
  }


  private parseMergeRequestSummary(raw: string): {
    title: string | null;
    overview: string | null;
    majorChanges: string[];
    technicalHighlights: string[];
    risks: string[];
    tests: string[];
  } | null {
    if (!raw) {
      return null;
    }

    const jsonBlock = this.extractJsonBlock(raw);
    if (!jsonBlock) {
      return null;
    }

    try {
      const parsed = JSON.parse(jsonBlock);
      return {
        title: typeof parsed.title === 'string' ? parsed.title.trim() : null,
        overview: typeof parsed.overview === 'string' ? parsed.overview.trim() : null,
        majorChanges: this.normalizeSummaryArray(parsed.majorChanges ?? parsed.highlights),
        technicalHighlights: this.normalizeSummaryArray(parsed.technicalHighlights ?? parsed.impacts),
        risks: this.normalizeSummaryArray(parsed.risks),
        tests: this.normalizeSummaryArray(parsed.tests),
      };
    } catch (error) {
      logger.warn('Failed to parse merge request summary JSON', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private normalizeSummaryArray(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value
        .map(item => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) {
      return [value.trim()];
    }
    return [];
  }

  private formatMergeRequestSummary(
    summary: {
      title: string | null;
      overview: string | null;
      majorChanges: string[];
      technicalHighlights: string[];
      risks: string[];
      tests: string[];
    } | null
  ): string | null {
    if (!summary) {
      return null;
    }

    const lines: string[] = [];
    lines.push('本次提交变更概述', '');

    if (summary.overview && summary.overview.toLowerCase() !== 'none') {
      lines.push(summary.overview, '');
    }

    const addSection = (heading: string, items: string[]) => {
      const filtered = items.filter(item => item && item.toLowerCase() !== 'none');
      if (filtered.length === 0) {
        return;
      }
      lines.push(heading, '');
      filtered.forEach(item => lines.push(`- ${item}`));
      lines.push('');
    };

    addSection('主要改动', summary.majorChanges);
    addSection('技术要点', summary.technicalHighlights);
    addSection('潜在影响', summary.risks);
    addSection('测试建议', summary.tests);

    const result = lines
      .map(line => line.trimEnd())
      .join('\n')
      .trim();

    return result || null;
  }

  private extractJsonBlock(text: string): string | null {
    if (!text) {
      return null;
    }
    const trimmed = text.trim();
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch && fenceMatch[1]) {
      return fenceMatch[1].trim();
    }
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end >= start) {
      return trimmed.slice(start, end + 1);
    }
    return null;
  }

  private async handleSuccess(
    event: GitLabWebhookEvent,
    instruction: AiInstruction,
    result: any,
    baseBranch: string,
    projectPath: string,
    options?: {
      sessionContext?: {
        issueKey: SessionKey;
        sessionId?: string;
        existingSession?: SessionInfo;
        baseBranch: string;
        provider: ProviderType;
        branchToCheckout: string;
        hasExistingSession: boolean;
      };
    }
  ): Promise<void> {
    const sessionContext = options?.sessionContext;
    const executorName = this.getExecutorDisplayName(instruction.provider);
    this.discussionContext.executorName = executorName;
    const existingSpecKitStage = sessionContext?.existingSession?.specKitStage;
    const activeSpecKitStage = instruction.specKitCommand ?? existingSpecKitStage;
    const isSpecScenario = instruction.scenario === 'spec-doc' || Boolean(activeSpecKitStage);
    const branchPrefix = activeSpecKitStage
      ? activeSpecKitStage
      : (sessionContext?.provider ?? instruction.provider ?? config.ai.executor);

    logger.info(`${executorName} instruction executed successfully`, {
      projectId: event.project.id,
      hasChanges: result.changes?.length > 0,
    });

    const summaryWarnings: string[] = [];
    const changeCount = Array.isArray(result.changes) ? result.changes.length : 0;
    const effectiveBaseBranch = sessionContext?.baseBranch ?? baseBranch;
    const stageDocuments: Array<{ path: string; content: string }> = [];
    let stageDocumentPaths: string[] = [];

    const collectDocuments = async (paths: string[]) => {
      const uniquePaths = Array.from(new Set(paths.filter(Boolean)));

      for (const relativePath of uniquePaths) {
        if (stageDocuments.some(doc => doc.path === relativePath)) {
          stageDocumentPaths = Array.from(new Set([...stageDocumentPaths, relativePath]));
          continue;
        }

        try {
          const absolutePath = path.join(projectPath, relativePath);
          const content = await fs.readFile(absolutePath, 'utf-8');
          stageDocuments.push({ path: relativePath, content });
          stageDocumentPaths = Array.from(new Set([...stageDocumentPaths, relativePath]));
        } catch (error) {
          logger.warn('Failed to read Spec Kit document for response', {
            projectPath,
            relativePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };

    let workingBranch = sessionContext?.existingSession?.branchName;
    let mergeRequestUrl = sessionContext?.existingSession?.mergeRequestUrl;
    let mergeRequestIid = sessionContext?.existingSession?.mergeRequestIid;

    const sessionMode: 'new' | 'continuation' | 'none' = sessionContext
      ? sessionContext.hasExistingSession
        ? 'continuation'
        : 'new'
      : 'none';

    if (changeCount > 0) {
      const mrInfo = MRGenerator.generateMR({
        instruction: instruction.command,
        context: instruction.context,
        changes: result.changes,
        projectUrl: event.project.web_url,
      });

      if (sessionContext) {
        const issueInfo = this.getIssueInfo(event) || this.getMergeRequestInfo(event);
        const existingProviderSessionId =
          sessionContext.existingSession?.providerSessions?.[sessionContext.provider]?.sessionId;
        const sessionIdForUpdate = sessionContext.sessionId ?? existingProviderSessionId;

        if (!sessionContext.hasExistingSession || !sessionContext.existingSession?.branchName) {
          const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
          const randomSuffix = Math.random().toString(36).substring(2, 8);
          const aiBranch = `${branchPrefix}-${timestamp}-${randomSuffix}`;

          try {
            await this.gitlabService.createBranch(event.project.id, aiBranch, effectiveBaseBranch);
            await this.updateProgressComment(event, `Created branch: ${aiBranch}`);

            await this.commitAndPushToNewBranch(event, projectPath, aiBranch, mrInfo.commitMessage);
            workingBranch = aiBranch;

            try {
              const mergeRequest = await this.gitlabService.createMergeRequest(event.project.id, {
                sourceBranch: aiBranch,
                targetBranch: effectiveBaseBranch,
                title: mrInfo.title,
                description: mrInfo.description,
              });

              mergeRequestIid = mergeRequest.iid;
              mergeRequestUrl = `${event.project.web_url}/-/merge_requests/${mergeRequest.iid}`;
              await this.updateProgressComment(event, `Created merge request: ${mergeRequestUrl}`);
            } catch (mrError) {
              logger.error('Failed to create merge request:', mrError);
              summaryWarnings.push(
                `合并请求创建失败：${mrError instanceof Error ? mrError.message : String(mrError)}`
              );
            }
          } catch (error) {
            logger.error('Failed to create branch or push changes:', error);
            summaryWarnings.push(
              `推送到新分支失败：${error instanceof Error ? error.message : String(error)}`
            );
          }

          if (sessionIdForUpdate && issueInfo) {
            this.sessionManager.setSession(
              sessionContext.issueKey,
              sessionIdForUpdate,
              {
                projectId: event.project.id,
                issueIid: issueInfo.iid,
                discussionId: this.discussionContext.discussionId || undefined,
                branchName: workingBranch,
                baseBranch: effectiveBaseBranch,
                mergeRequestIid,
                mergeRequestUrl,
                ownerId: this.extractOwnerIdFromIssueKey(sessionContext.issueKey),
              },
              sessionContext.provider
            );
          }
        } else {
          workingBranch = sessionContext.existingSession.branchName ?? sessionContext.branchToCheckout;

          await this.updateProgressComment(event, `Updating branch: ${workingBranch}`);

          try {
            await this.projectManager.commitAndPush(projectPath, mrInfo.commitMessage, workingBranch);
          } catch (error) {
            logger.error('Failed to push updates to existing branch:', error);
            summaryWarnings.push(
              `推送到现有分支失败：${error instanceof Error ? error.message : String(error)}`
            );
          }

          if (!mergeRequestIid) {
            try {
              const mergeRequest = await this.gitlabService.createMergeRequest(event.project.id, {
                sourceBranch: workingBranch,
                targetBranch: effectiveBaseBranch,
                title: mrInfo.title,
                description: mrInfo.description,
              });

              mergeRequestIid = mergeRequest.iid;
              mergeRequestUrl = `${event.project.web_url}/-/merge_requests/${mergeRequest.iid}`;
              await this.updateProgressComment(event, `Created merge request: ${mergeRequestUrl}`);
            } catch (mrError) {
              logger.error('Failed to create merge request for existing branch:', mrError);
              summaryWarnings.push(
                `合并请求创建失败：${mrError instanceof Error ? mrError.message : String(mrError)}`
              );
            }
          }

          const issueInfo = this.getIssueInfo(event) || this.getMergeRequestInfo(event);
          if (sessionIdForUpdate && issueInfo) {
            this.sessionManager.setSession(
              sessionContext.issueKey,
              sessionIdForUpdate,
              {
                projectId: event.project.id,
                issueIid: issueInfo.iid,
                discussionId: this.discussionContext.discussionId || undefined,
                branchName: workingBranch,
                baseBranch: effectiveBaseBranch,
                mergeRequestIid,
                mergeRequestUrl,
                ownerId: this.extractOwnerIdFromIssueKey(sessionContext.issueKey),
              },
              sessionContext.provider
            );
          }
        }
      } else {
        try {
          const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
          const randomSuffix = Math.random().toString(36).substring(2, 8);
          const aiBranch = `${branchPrefix}-${timestamp}-${randomSuffix}`;

          await this.gitlabService.createBranch(event.project.id, aiBranch, effectiveBaseBranch);
          await this.updateProgressComment(event, `Created branch: ${aiBranch}`);

          await this.commitAndPushToNewBranch(event, projectPath, aiBranch, mrInfo.commitMessage);
          workingBranch = aiBranch;

          const mergeRequest = await this.gitlabService.createMergeRequest(event.project.id, {
            sourceBranch: aiBranch,
            targetBranch: effectiveBaseBranch,
            title: mrInfo.title,
            description: mrInfo.description,
          });

          mergeRequestIid = mergeRequest.iid;
          mergeRequestUrl = `${event.project.web_url}/-/merge_requests/${mergeRequest.iid}`;
          await this.updateProgressComment(event, `Created merge request: ${mergeRequestUrl}`);
        } catch (error) {
          logger.error('Failed to create branch or merge request:', error);
          summaryWarnings.push(
            `分支/MR 处理失败：${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    if (activeSpecKitStage) {
      const nonDeletedChanges = Array.isArray(result.changes)
        ? result.changes.filter((change: any) => change.type !== 'deleted')
        : [];
      const specsPrefix = 'specs/';

      if (nonDeletedChanges.length > 0) {
        const specsChanges = nonDeletedChanges.filter((change: any) => {
          const lowerPath = change.path.toLowerCase();
          return lowerPath.startsWith(specsPrefix) && lowerPath.endsWith('.md');
        });

        if (specsChanges.length > 0) {
          await collectDocuments(specsChanges.map((change: any) => change.path));
        }
      }

      if (stageDocuments.length === 0) {
        const storedDocs = sessionContext?.existingSession?.specKitDocuments?.[activeSpecKitStage]?.filter(path =>
          path.toLowerCase().startsWith(specsPrefix) && path.toLowerCase().endsWith('.md')
        );
        if (storedDocs?.length) {
          await collectDocuments(storedDocs);
        }
      }

      if (sessionContext?.issueKey) {
        this.sessionManager.updateSpecKitState(
          sessionContext.issueKey,
          activeSpecKitStage,
          stageDocumentPaths
        );
      }
    }

    const responseMessage = this.buildSuccessResponse({
      command: instruction.command,
      changes: Array.isArray(result.changes) ? result.changes : [],
      output: typeof result.output === 'string' ? result.output : '',
      sessionMode,
      baseBranch: effectiveBaseBranch,
      branchName: workingBranch,
      mergeRequestUrl,
      mergeRequestIid,
      warnings: summaryWarnings,
      scenario: instruction.scenario,
      specKitStage: activeSpecKitStage,
      stageDocuments,
    });

    await this.postComment(event, responseMessage);
  }

  private async commitAndPushToNewBranch(
    event: GitLabWebhookEvent,
    projectPath: string,
    aiBranch: string,
    commitMessage: string
  ): Promise<void> {
    try {
      // Switch to the new branch in local git
      await this.projectManager.switchToAndPushBranch(projectPath, aiBranch, commitMessage);
    } catch (error) {
      logger.error('Failed to commit and push to new branch:', error);
      throw error;
    }
  }

  private async prepareSpecKitWorkspace(projectPath: string, event: GitLabWebhookEvent): Promise<void> {
    const specDir = path.join(projectPath, '.specify');

    try {
      logger.info('Spec Kit workspace check', {
        projectId: event.project.id,
        workspaceDir: projectPath,
        specDir,
      });

      const specExists = await this.pathExists(specDir);
      if (specExists) {
        logger.info('Spec Kit workspace already initialized', {
          projectId: event.project.id,
          workspaceDir: projectPath,
        });
        return;
      }

      await this.ensureSpecifyCliAvailable(event);

      await this.updateProgressComment(event, '📘 未检测到 Spec Kit 工作区，正在项目根目录执行 `specify init --here`...');
      const initResult = await this.runSpecifyInit(projectPath);
      logger.info('Spec Kit initialization completed', {
        projectId: event.project.id,
        workspaceDir: projectPath,
        durationMs: initResult.elapsedMs,
        stdoutPreview: initResult.stdout.slice(0, 500),
        stderrPreview: initResult.stderr.slice(0, 500),
      });
      await this.updateProgressComment(event, '📘 Spec Kit 工作区初始化完成。');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to prepare Spec Kit workspace', {
        projectId: event.project.id,
        projectPath,
        error: message,
      });

      await this.updateProgressComment(
        event,
        `Spec Kit 初始化失败：${message}`,
        true,
        true
      );

      throw error instanceof Error ? error : new Error(message);
    }
  }

  private async ensureSpecifyCliAvailable(event: GitLabWebhookEvent): Promise<void> {
    const checkCommandDescription = '`specify --help`';
    try {
      await this.updateProgressComment(event, `📘 检查 Spec Kit CLI（运行 ${checkCommandDescription}）...`);
    } catch {
      // Ignore progress update errors (e.g., comment already removed)
    }

    const checkTimeoutMs = 10_000;

    try {
      const specifyEnv = await this.getSpecifySpawnEnv();
      const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('specify', ['--help'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: specifyEnv,
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timeoutHandle = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          child.kill('SIGTERM');
          reject(new Error(`${checkCommandDescription} 超时，请确认 Spec Kit CLI 已安装`));
        }, checkTimeoutMs);

        child.stdout?.on('data', data => {
          const chunk = data.toString();
          stdout += chunk;
        });

        child.stderr?.on('data', data => {
          const chunk = data.toString();
          stderr += chunk;
        });

        child.on('error', err => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutHandle);
          const errno = (err as NodeJS.ErrnoException).code;
          if (errno === 'ENOENT') {
            reject(
              new Error(
                '未检测到 Spec Kit CLI，请在服务器上执行 `uv tool install specify-cli --from git+https://github.com/github/spec-kit.git` 并确认 `specify` 已加入 PATH。'
              )
            );
          } else {
            reject(new Error(`无法执行 specify CLI：${err.message}`));
          }
        });

        child.on('close', code => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutHandle);
          if (code === 0) {
            resolve({ stdout, stderr });
          } else {
            const tail = (stderr || stdout || '').trim();
            reject(
              new Error(
                `${checkCommandDescription} 失败（退出码 ${code}）${tail ? `：${tail}` : ''}`
              )
            );
          }
        });
      });

      const preview = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 3);
      logger.info('Spec Kit CLI detected', {
        helpPreview: preview,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Spec Kit CLI unavailable', { error: message });
      await this.updateProgressComment(
        event,
        `Spec Kit CLI 检查失败：${message}`,
        true,
        true
      );
      throw error instanceof Error ? error : new Error(message);
    }
  }

  private async runSpecifyInit(
    cwd: string
  ): Promise<{ stdout: string; stderr: string; elapsedMs: number }> {
    const specifyEnv = await this.getSpecifySpawnEnv();
    const args = [
      'init',
      '--here',
      '--force',
      '--no-git',
      '--ignore-agent-tools',
      '--ai',
      'claude',
      '--script',
      process.platform === 'win32' ? 'ps' : 'sh',
    ];

    const env: NodeJS.ProcessEnv = {
      ...specifyEnv,
      SPECIFY_NON_INTERACTIVE: '1',
    };

    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn('specify', args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill('SIGTERM');
        reject(new Error('specify init 超时（超过 5 分钟未完成）'));
      }, this.specKitInitTimeoutMs);

      child.stdout?.on('data', data => {
        const chunk = data.toString();
        stdout += chunk;
        logger.debug('specify init stdout', {
          cwd,
          chunk: chunk.slice(0, 200),
        });
      });

      child.stderr?.on('data', data => {
        const chunk = data.toString();
        stderr += chunk;
        logger.debug('specify init stderr', {
          cwd,
          chunk: chunk.slice(0, 200),
        });
      });

      child.on('error', err => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        reject(err);
      });

      child.on('close', code => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        const elapsedMs = Date.now() - startedAt;

        if (code === 0) {
          resolve({
            stdout,
            stderr,
            elapsedMs,
          });
        } else {
          const tail = (stderr || stdout || '').trim();
          reject(
            new Error(
              `specify init 失败（退出码 ${code}）${tail ? `：${tail}` : ''}`
            )
          );
        }
      });
    });
  }

  private async getSpecifySpawnEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const existingPath = env.PATH || '';
    const separator = path.delimiter;
    const segments = existingPath ? existingPath.split(separator) : [];
    const extraPaths: string[] = [];

    const homeDir = process.env.HOME || os.homedir?.();
    if (homeDir) {
      const uvBin = path.join(homeDir, '.local', 'share', 'uv', 'tools', 'specify-cli', 'bin');
      if (await this.pathExists(uvBin) && !segments.includes(uvBin) && !extraPaths.includes(uvBin)) {
        extraPaths.push(uvBin);
      }

      const localBin = path.join(homeDir, '.local', 'bin');
      if (await this.pathExists(localBin) && !segments.includes(localBin) && !extraPaths.includes(localBin)) {
        extraPaths.push(localBin);
      }
    }

    const combined = [...extraPaths, ...segments].filter(Boolean);
    env.PATH = combined.join(separator);
    return env;
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await fs.access(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  private async handleFailure(
    event: GitLabWebhookEvent,
    instruction: AiInstruction,
    result: any
  ): Promise<void> {
    const executorName = this.getExecutorDisplayName(instruction.provider);
    this.discussionContext.executorName = executorName;
    logger.warn(`${executorName} instruction failed`, {
      projectId: event.project.id,
      error: result.error,
    });

    const responseMessage = this.buildFailureResponse({
      command: instruction.command,
      error: result.error,
    });

    await this.postComment(event, responseMessage);
  }

  private async reportError(event: GitLabWebhookEvent, error: any): Promise<void> {
    const executorName = this.discussionContext.executorName;
    const errorMessage = error instanceof Error
      ? [error.message, error.stack]
          .filter(Boolean)
          .join('\n')
      : String(error);
    const responseMessage = this.buildFailureResponse({
      command: `${executorName} internal error`,
      error: errorMessage,
    });

    try {
      await this.postComment(event, responseMessage);
    } catch (commentError) {
      logger.error('Failed to post error comment:', commentError);
    }
  }

  private async postComment(event: GitLabWebhookEvent, message: string): Promise<void> {
    const issueInfo = this.getIssueInfo(event);
    const mrInfo = this.getMergeRequestInfo(event);
    const body = this.formatCommentBody(message);

    // If we have a discussion ID, try to post as a reply to that discussion
    // We don't need to check for discussionNoteId here because this might be the first reply
    if (this.discussionContext.discussionId) {
      try {
        switch (event.object_kind) {
          case 'issue':
            if (issueInfo) {
              const comment = await this.gitlabService.replyToIssueDiscussion(
                event.project.id,
                issueInfo.iid,
                this.discussionContext.discussionId,
                body
              );
              this.discussionContext.discussionReplySucceeded = true;
              const parsedId = this.parseDiscussionNoteId(comment?.id);
              this.discussionContext.discussionNoteId = parsedId;
              if (parsedId !== null) {
                this.discussionContext.currentCommentId = parsedId;
              }
              logger.info('Posted comment as issue discussion reply', {
                discussionId: this.discussionContext.discussionId,
                noteId: parsedId,
              });
              return;
            }
            break;

          case 'note':
            // For note events, check if it's an issue note or MR note
            if (issueInfo) {
              const comment = await this.gitlabService.replyToIssueDiscussion(
                event.project.id,
                issueInfo.iid,
                this.discussionContext.discussionId,
                body
              );
              this.discussionContext.discussionReplySucceeded = true;
              const parsedId = this.parseDiscussionNoteId(comment?.id);
              this.discussionContext.discussionNoteId = parsedId;
              if (parsedId !== null) {
                this.discussionContext.currentCommentId = parsedId;
              }
              logger.info('Posted comment as issue discussion reply (note)', {
                discussionId: this.discussionContext.discussionId,
                noteId: parsedId,
              });
              return;
            } else if (mrInfo) {
              const comment = await this.gitlabService.replyToMergeRequestDiscussion(
                event.project.id,
                mrInfo.iid,
                this.discussionContext.discussionId,
                body
              );
              this.discussionContext.discussionReplySucceeded = true;
              const parsedId = this.parseDiscussionNoteId(comment?.id);
              this.discussionContext.discussionNoteId = parsedId;
              if (parsedId !== null) {
                this.discussionContext.currentCommentId = parsedId;
              }
              logger.info('Posted comment as MR discussion reply (note)', {
                discussionId: this.discussionContext.discussionId,
                noteId: parsedId,
              });
              return;
            }
            break;

          case 'merge_request':
            if (mrInfo) {
              const comment = await this.gitlabService.replyToMergeRequestDiscussion(
                event.project.id,
                mrInfo.iid,
                this.discussionContext.discussionId,
                body
              );
              this.discussionContext.discussionReplySucceeded = true;
              const parsedId = this.parseDiscussionNoteId(comment?.id);
              this.discussionContext.discussionNoteId = parsedId;
              if (parsedId !== null) {
                this.discussionContext.currentCommentId = parsedId;
              }
              logger.info('Posted comment as MR discussion reply', {
                discussionId: this.discussionContext.discussionId,
                noteId: parsedId,
              });
              return;
            }
            break;
        }
      } catch (error) {
        // Silently fallback for known unimplemented features
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!errorMessage.includes('Discussion reply not implemented')) {
          logger.warn('Failed to post discussion reply, falling back to regular comment:', error);
        }
        this.discussionContext.discussionReplySucceeded = false;
        this.discussionContext.discussionId = null;
        this.discussionContext.discussionResolvable = false;
        this.discussionContext.discussionNoteId = null;
        this.discussionContext.threadContext = null;
        // Continue to fallback posting method
      }
    }

    // Fallback to regular comment posting
    switch (event.object_kind) {
      case 'issue':
        if (issueInfo) {
          await this.gitlabService.addIssueComment(event.project.id, issueInfo.iid, body);
        }
        break;

      case 'merge_request':
        if (mrInfo) {
          await this.gitlabService.addMergeRequestComment(
            event.project.id,
            mrInfo.iid,
            body
          );
        }
        break;

      case 'note':
        if (issueInfo) {
          await this.gitlabService.addIssueComment(event.project.id, issueInfo.iid, body);
        } else if (mrInfo) {
          await this.gitlabService.addMergeRequestComment(
            event.project.id,
            mrInfo.iid,
            body
          );
        }
        break;
    }
  }

  private async createProgressComment(
    event: GitLabWebhookEvent,
    message: string
  ): Promise<number | null> {
    try {
      const body = this.formatCommentBody(message);
      let commentId: number | null = null;
      const issueInfo = this.getIssueInfo(event);
      const mrInfo = this.getMergeRequestInfo(event);

      logger.info('Creating progress comment', {
        hasDiscussionId: !!this.discussionContext.discussionId,
        discussionId: this.discussionContext.discussionId,
        eventType: event.object_kind,
        mrIid: mrInfo?.iid,
        issueIid: issueInfo?.iid,
      });

      // If we have a discussion ID, try to create progress comment as a reply to that discussion
      // We don't need to check for discussionNoteId here because this might be the first reply
      if (this.discussionContext.discussionId) {
        try {
          switch (event.object_kind) {
            case 'issue':
              if (issueInfo) {
                const comment = await this.gitlabService.replyToIssueDiscussion(
                  event.project.id,
                  issueInfo.iid,
                  this.discussionContext.discussionId,
                  body
                );
                const parsedId = this.parseDiscussionNoteId(comment?.id);
                this.discussionContext.discussionNoteId = parsedId;
                commentId = parsedId ?? null;
                this.discussionContext.currentCommentId = parsedId ?? this.discussionContext.currentCommentId;
                logger.info('Created progress comment as issue discussion reply', {
                  discussionId: this.discussionContext.discussionId,
                  noteId: parsedId,
                });
                return commentId;
              }
              break;

            case 'note':
              // For note events, check if it's an issue note or MR note
              if (issueInfo) {
                const comment = await this.gitlabService.replyToIssueDiscussion(
                  event.project.id,
                  issueInfo.iid,
                  this.discussionContext.discussionId,
                  body
                );
                const parsedId = this.parseDiscussionNoteId(comment?.id);
                this.discussionContext.discussionNoteId = parsedId;
                commentId = parsedId ?? null;
                this.discussionContext.currentCommentId = parsedId ?? this.discussionContext.currentCommentId;
                logger.info('Created progress comment as issue discussion reply (note)', {
                  discussionId: this.discussionContext.discussionId,
                  noteId: parsedId,
                });
                return commentId;
              } else if (mrInfo) {
                const comment = await this.gitlabService.replyToMergeRequestDiscussion(
                  event.project.id,
                  mrInfo.iid,
                  this.discussionContext.discussionId,
                  body
                );
                const parsedId = this.parseDiscussionNoteId(comment?.id);
                this.discussionContext.discussionNoteId = parsedId;
                commentId = parsedId ?? null;
                this.discussionContext.currentCommentId = parsedId ?? this.discussionContext.currentCommentId;
                logger.info('Created progress comment as MR discussion reply (note)', {
                  discussionId: this.discussionContext.discussionId,
                  noteId: parsedId,
                });
                return commentId;
              }
              break;

            case 'merge_request':
              if (mrInfo) {
                const comment = await this.gitlabService.replyToMergeRequestDiscussion(
                  event.project.id,
                  mrInfo.iid,
                  this.discussionContext.discussionId,
                  body
                );
                const parsedId = this.parseDiscussionNoteId(comment?.id);
                this.discussionContext.discussionNoteId = parsedId;
                commentId = parsedId ?? null;
                this.discussionContext.currentCommentId = parsedId ?? this.discussionContext.currentCommentId;
                logger.info('Created progress comment as MR discussion reply', {
                  discussionId: this.discussionContext.discussionId,
                  noteId: parsedId,
                });
                return commentId;
              }
              break;
          }
        } catch (error) {
          // Silently fallback for known unimplemented features
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (!errorMessage.includes('Discussion reply not implemented')) {
            logger.warn(
              'Failed to create discussion reply progress comment, falling back to regular comment:',
              error
            );
          }
          // Continue to fallback comment creation method
          this.discussionContext.discussionNoteId = null;
          this.discussionContext.threadContext = null;
        }
      }

      // Fallback to regular comment creation
      switch (event.object_kind) {
        case 'issue':
          if (issueInfo) {
            const comment = await this.gitlabService.createIssueComment(
              event.project.id,
              issueInfo.iid,
              body
            );
            commentId = comment?.id || null;
          }
          break;

        case 'merge_request':
          if (mrInfo) {
            const comment = await this.gitlabService.createMergeRequestComment(
              event.project.id,
              mrInfo.iid,
              body
            );
            commentId = comment?.id || null;
          }
          break;

        case 'note':
          if (issueInfo) {
            const comment = await this.gitlabService.createIssueComment(
              event.project.id,
              issueInfo.iid,
              body
            );
            commentId = comment?.id || null;
          } else if (mrInfo) {
            const comment = await this.gitlabService.createMergeRequestComment(
              event.project.id,
              mrInfo.iid,
              body
            );
            commentId = comment?.id || null;
          }
          break;
      }

      return commentId;
    } catch (error) {
      logger.error('Failed to create progress comment:', error);
      return null;
    }
  }

  private async updateProgressComment(
    event: GitLabWebhookEvent,
    message: string,
    isComplete?: boolean,
    isError?: boolean
  ): Promise<void> {
    if (!this.discussionContext.currentCommentId) {
      logger.debug('No currentCommentId set, skipping progress update');
      return;
    }

    logger.debug('Updating progress comment', {
      commentId: this.discussionContext.currentCommentId,
      message: message.substring(0, 100),
      isComplete,
      isError
    });

    const executorName = this.discussionContext.executorName;
    const now = new Date();
    let commentBody = '';

    try {
      // Add new message to the progress log
      const timestamp = this.formatLocalTime(now);
      const formattedMessage = `[${timestamp}] ${message}`;
      const newMessageContent = this.stripTimestampPrefix(formattedMessage);

      // Check for duplicate messages (ignore timestamp, only check the message content)
      const isDuplicate = this.discussionContext.progressMessages.some(existingMsg => {
        const existingMessageContent = this.stripTimestampPrefix(existingMsg);
        return existingMessageContent === newMessageContent;
      });

      // Only add if not duplicate
      if (!isDuplicate) {
        this.discussionContext.progressMessages.push(formattedMessage);
      }

      // Build the complete comment body
      commentBody = `🤖 **${executorName} Progress Report**\n\n`;

      // Add the latest messages (keep last 10 to avoid too long comments)
      const recentMessages = this.discussionContext.progressMessages.slice(-10);
      recentMessages.forEach(msg => {
        commentBody += `- ${msg}\n`;
      });

      if (isComplete) {
        commentBody += '\n---\n\n';
        if (isError) {
          commentBody += '❌ **Task completed with errors**';
        } else {
          commentBody += '✅ **Task completed successfully!**';
        }
      } else {
        commentBody += '\n⏳ *Processing...*';
      }

      commentBody += `\n\n---\n*Last updated: ${this.formatLocalDateTime(now)} (UTC+08:00)*`;

      // Update the comment
      const constrainedBody = this.formatCommentBody(commentBody);
      await this.updateComment(event, this.discussionContext.currentCommentId, constrainedBody);
    } catch (error) {
      logger.error('Failed to update progress comment:', error);

      // If update failed and currentCommentId was reset, try to create a new progress comment
      if (!this.discussionContext.currentCommentId) {
        try {
          logger.info('Attempting to create new progress comment after update failure');
          this.discussionContext.currentCommentId = await this.createProgressComment(event, commentBody);
        } catch (createError) {
          logger.error('Failed to create new progress comment after update failure:', createError);
        }
      }
    }
  }

  private async updateComment(
    event: GitLabWebhookEvent,
    commentId: number,
    body: string
  ): Promise<void> {
    try {
      const bodyWithMarker = this.formatCommentBody(body);
      const issueInfo = this.getIssueInfo(event);
      const mrInfo = this.getMergeRequestInfo(event);
      const discussionId = this.discussionContext.discussionId;
      const discussionNoteId = this.getValidDiscussionNoteId();

      if (discussionId && discussionNoteId !== null) {
        try {
          if (issueInfo) {
            const updatedNote = await this.gitlabService.updateIssueDiscussionNote(
              event.project.id,
              issueInfo.iid,
              discussionId,
              discussionNoteId,
              bodyWithMarker
            );

            const updatedNoteId = this.parseDiscussionNoteId(updatedNote?.id);
            if (updatedNoteId !== null) {
              this.discussionContext.discussionNoteId = updatedNoteId;
              this.discussionContext.currentCommentId = updatedNoteId;
            }
            logger.info('Progress discussion note updated successfully', {
              discussionId,
              noteId: updatedNoteId ?? discussionNoteId,
            });
            return;
          }

          if (mrInfo) {
            const updatedNote = await this.gitlabService.updateMergeRequestDiscussionNote(
              event.project.id,
              mrInfo.iid,
              discussionId,
              discussionNoteId,
              bodyWithMarker
            );

            const updatedNoteId = this.parseDiscussionNoteId(updatedNote?.id);
            if (updatedNoteId !== null) {
              this.discussionContext.discussionNoteId = updatedNoteId;
              this.discussionContext.currentCommentId = updatedNoteId;
            }
            logger.info('Progress discussion note updated successfully', {
              discussionId,
              noteId: updatedNoteId ?? discussionNoteId,
            });
            return;
          }
        } catch (discussionError) {
          logger.warn('Failed to update discussion note, falling back to regular comment update', {
            error: discussionError instanceof Error ? discussionError.message : String(discussionError),
            discussionId,
            discussionNoteId,
          });
        }
      }

      switch (event.object_kind) {
        case 'issue':
          if (issueInfo) {
            await this.gitlabService.updateIssueComment(
              event.project.id,
              issueInfo.iid,
              commentId,
              bodyWithMarker
            );
          }
          break;

        case 'merge_request':
          if (mrInfo) {
            await this.gitlabService.updateMergeRequestComment(
              event.project.id,
              mrInfo.iid,
              commentId,
              bodyWithMarker
            );
          }
          break;

        case 'note':
          if (issueInfo) {
            await this.gitlabService.updateIssueComment(
              event.project.id,
              issueInfo.iid,
              commentId,
              bodyWithMarker
            );
          } else if (mrInfo) {
            await this.gitlabService.updateMergeRequestComment(
              event.project.id,
              mrInfo.iid,
              commentId,
              bodyWithMarker
            );
          }
          break;
      }

      logger.info('Progress comment updated successfully', {
        commentId,
        messageLength: bodyWithMarker.length,
      });
    } catch (error) {
      logger.error('Failed to update progress comment:', error);
      // Don't create a new comment as fallback - this causes multiple comments
      // Instead, reset currentCommentId so future updates will create a new initial comment
      logger.warn('Resetting currentCommentId due to update failure, next update will create new comment');
      this.discussionContext.currentCommentId = null;
      throw error; // Re-throw so the caller knows the update failed
    }
  }

  // Public methods for session management

  /**
   * Get session statistics
   */
  public getSessionStats() {
    return this.sessionManager.getStats();
  }

  /**
   * Clean expired sessions manually
   */
  public cleanExpiredSessions(maxAge?: number): number {
    return this.sessionManager.cleanExpiredSessions(maxAge);
  }

  /**
   * Get all active sessions (for debugging)
   */
  public getAllSessions() {
    return this.sessionManager.getAllSessions();
  }

  /**
   * Remove a specific session
   */
  public removeSession(projectId: number, issueIid: number, ownerId?: string, provider?: ProviderType): boolean {
    const sessionKey = this.sessionManager.generateSessionKey(projectId, issueIid, ownerId);
    return provider
      ? this.sessionManager.removeSession(sessionKey, provider)
      : this.sessionManager.removeSession(sessionKey);
  }

  /**
   * Get the session manager instance (used by cleanup service)
   */
  public getSessionManager() {
    return this.sessionManager;
  }

  private isAiGeneratedComment(event: GitLabWebhookEvent): boolean {
    if (event.object_kind !== 'note') {
      return false;
    }

    const note = (event.object_attributes as { note?: string } | undefined)?.note ?? '';
    return note.includes(AI_RESPONSE_MARKER);
  }

  private ensureAiMarker(body: string): string {
    const trimmed = body?.trimEnd() ?? '';
    if (!trimmed) {
      return AI_RESPONSE_MARKER;
    }

    return trimmed.includes(AI_RESPONSE_MARKER) ? trimmed : `${trimmed}\n\n${AI_RESPONSE_MARKER}`;
  }

  private formatCommentBody(message: string): string {
    const raw = message ?? '';
    const withMarker = this.ensureAiMarker(raw);
    if (withMarker.length <= MAX_GITLAB_NOTE_LENGTH) {
      return withMarker;
    }

    const sanitized = raw.replace(AI_RESPONSE_MARKER, '').trimEnd();
    const suffix = `${TRUNCATION_NOTICE}\n\n${AI_RESPONSE_MARKER}`;
    const available = Math.max(MAX_GITLAB_NOTE_LENGTH - suffix.length, 0);
    const truncated = sanitized.slice(0, available).trimEnd();
    const truncatedBody = `${truncated}${suffix}`;

    return truncatedBody.length <= MAX_GITLAB_NOTE_LENGTH
      ? truncatedBody
      : truncatedBody.slice(0, MAX_GITLAB_NOTE_LENGTH);
  }

  private async buildMergeRequestCommentContext(
    event: GitLabWebhookEvent,
    baseContext: string | undefined,
    projectPath: string
  ): Promise<string> {
    const sections: string[] = [];

    if (baseContext && baseContext.trim()) {
      sections.push(baseContext.trim());
    }

    const attrs = (event.object_attributes ?? {}) as {
      note?: string;
      url?: string;
      position?: { new_path?: string; new_line?: number | null } | null;
      original_position?: { new_path?: string; new_line?: number | null } | null;
    };

    const commentLines: string[] = [];
    const filePath = attrs.position?.new_path || attrs.original_position?.new_path || '';
    const lineNumber = attrs.position?.new_line || attrs.original_position?.new_line || null;
    const commentBody = attrs.note?.trim();

    if (filePath) {
      const location = lineNumber ? `${filePath}:${lineNumber}` : filePath;
      commentLines.push(`文件位置：${location}`);
    }

    if (attrs.url) {
      commentLines.push(`评论链接：${attrs.url}`);
    }

    if (commentBody) {
      commentLines.push(`评论内容：${commentBody}`);
    }

    if (commentLines.length > 0) {
      sections.push('**Comment Context:**\n' + commentLines.join('\n'));
    }

    if (this.discussionContext.threadContext && this.discussionContext.threadContext.trim()) {
      sections.push(this.discussionContext.threadContext.trim());
    }

    if (filePath) {
      const snippet = await this.readFileSnippet(projectPath, filePath, lineNumber ?? undefined);
      if (snippet) {
        const header = lineNumber ? `${filePath}:${lineNumber}` : filePath;
        sections.push(`**代码片段 (${header})**\n\n\`\`\`\n${snippet}\n\`\`\``);
      }
    }

    return sections.filter(Boolean).join('\n\n');
  }

  private async readFileSnippet(
    projectPath: string,
    relativePath: string,
    lineNumber?: number,
    contextRadius = 5
  ): Promise<string | null> {
    try {
      const absolutePath = path.join(projectPath, relativePath);
      const fileBuffer = await fs.readFile(absolutePath, 'utf-8');
      const lines = fileBuffer.split(/\r?\n/);

      if (lines.length === 0) {
        return null;
      }

      if (!lineNumber || lineNumber <= 0 || lineNumber > lines.length) {
        const limited = lines.slice(0, Math.min(lines.length, contextRadius * 2 + 1));
        return limited
          .map((line, index) => `${index + 1}: ${line}`)
          .join('\n');
      }

      const targetIndex = lineNumber - 1;
      const start = Math.max(0, targetIndex - contextRadius);
      const end = Math.min(lines.length, targetIndex + contextRadius + 1);

      return lines
        .slice(start, end)
        .map((line, index) => `${start + index + 1}: ${line}`)
        .join('\n');
    } catch (error) {
      logger.warn('Failed to read code snippet for comment', {
        projectPath,
        relativePath,
        lineNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async delayBeforeAiExecution(): Promise<void> {
    if (this.aiExecutionDelayMs <= 0) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, this.aiExecutionDelayMs));
  }

  private logAiPrompt(params: {
    action: string;
    prompt: string;
    provider?: 'claude' | 'codex';
    projectId: number;
    scenario?: string;
  }): void {
    const { action, prompt, provider, projectId, scenario } = params;
    logger.info('Dispatching AI prompt', {
      action,
      provider: this.getExecutorDisplayName(provider),
      projectId,
      scenario,
      prompt,
    });
  }

  private parseDiscussionNoteId(id: unknown): number | null {
    if (typeof id === 'number' && Number.isFinite(id)) {
      return id;
    }
    if (typeof id === 'string' && id.trim()) {
      const parsed = Number(id.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }

  private getValidDiscussionNoteId(): number | null {
    return this.parseDiscussionNoteId(this.discussionContext.discussionNoteId ?? undefined);
  }

  private isRecoverableSessionError(error?: string): boolean {
    if (!error) {
      return false;
    }

    const lower = error.toLowerCase();
    return (
      lower.includes('no conversation found') ||
      lower.includes('session not found') ||
      lower.includes('conversation not found')
    );
  }

  private buildChangeSummary(
    changes: Array<{ path: string; type: string }>,
    limit = 5
  ): string[] {
    if (!changes || changes.length === 0) {
      return [];
    }

    const displayChanges = changes.slice(0, limit);
    const lines = displayChanges.map(change => {
      const action = change.type === 'created'
        ? '新增'
        : change.type === 'deleted'
          ? '删除'
          : '修改';
      return `- ${action} \`${change.path}\``;
    });

    if (changes.length > limit) {
      lines.push(`- ... 其余 ${changes.length - limit} 个文件`);
    }

    return lines;
  }

  private buildLogicChangeHighlights(
    changes: Array<{ path: string; type: string }>
  ): string[] {
    if (!changes || changes.length === 0) {
      return [];
    }

    const highlights: string[] = [];
    highlights.push(
      ...this.describeChangeGroups(changes, 'created', '新增', 2),
      ...this.describeChangeGroups(changes, 'modified', '优化', 2),
      ...this.describeChangeGroups(changes, 'deleted', '清理', 1)
    );

    return highlights.slice(0, 5);
  }

  private describeChangeGroups(
    changes: Array<{ path: string; type: string }>,
    type: 'created' | 'modified' | 'deleted',
    verb: string,
    limit: number
  ): string[] {
    const filtered = changes.filter(change => change.type === type);
    if (filtered.length === 0) {
      return [];
    }

    const groups = this.groupChangesByPrefix(filtered);
    groups.sort((a, b) => b.files.length - a.files.length);

    return groups.slice(0, limit).map(group => {
      const label = this.formatGroupLabel(group.prefix, group.files);
      const examples = this.formatFileExamples(group.files, 3);
      return examples
        ? `- ${verb}${label}（示例：${examples}）`
        : `- ${verb}${label}`;
    });
  }

  private groupChangesByPrefix(
    changes: Array<{ path: string; type: string }>
  ): Array<{ prefix: string; files: string[] }> {
    const map = new Map<string, string[]>();

    for (const change of changes) {
      const prefix = this.extractChangeGroup(change.path);
      if (!map.has(prefix)) {
        map.set(prefix, []);
      }
      map.get(prefix)!.push(change.path);
    }

    return Array.from(map.entries()).map(([prefix, files]) => ({ prefix, files }));
  }

  private extractChangeGroup(pathname: string): string {
    if (!pathname) {
      return '项目';
    }
    const cleaned = pathname.replace(/^[./]+/, '');
    const segments = cleaned.split('/');
    if (segments.length === 1) {
      return segments[0] || '项目';
    }
    if (segments[0] === 'src' && segments.length >= 3) {
      return `src/${segments[1]}/${segments[2]}`;
    }
    return segments.slice(0, Math.min(2, segments.length - 1)).join('/');
  }

  private formatGroupLabel(prefix: string, files?: string[]): string {
    if (!prefix || prefix === '项目') {
      const sampleDir = files?.[0] ? path.dirname(files[0]) : '';
      if (!sampleDir || sampleDir === '.') {
        return '项目';
      }
      prefix = sampleDir;
    }

    const normalized = prefix.replace(/\\/g, '/');
    if (normalized === '' || normalized === '.') {
      return '项目';
    }
    return `\`${normalized}\` 模块`;
  }

  private formatFileExamples(files: string[], limit = 3): string | null {
    if (!files || files.length === 0) {
      return null;
    }

    const examples = files
      .slice(0, limit)
      .map(file => `\`${path.basename(file)}\``);

    if (files.length > limit) {
      examples.push(`... 共 ${files.length} 个文件`);
    }

    return examples.join('、');
  }

  private summarizeOutput(raw?: string, maxLength = 220): string | null {
    if (!raw) {
      return null;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }

    const summaryPattern = /(?:总结|梗概|概述|Summary|Overview|Result|Outcome)[:：]\s*([\s\S]+)/i;
    const match = trimmed.match(summaryPattern);
    let summary = match ? match[1] : trimmed;

    summary = summary
      .split(/\n{2,}/)[0]
      .replace(/\n+/g, ' ')
      .trim();

    if (!summary) {
      return null;
    }

    if (summary.length > maxLength) {
      return `${summary.slice(0, maxLength).trimEnd()}...`;
    }

    return summary;
  }

  private mapDiffsToFileChanges(
    diffs: Array<{
      new_file?: boolean;
      deleted_file?: boolean;
      renamed_file?: boolean;
      new_path?: string;
      old_path?: string;
    }>
  ): Array<{ path: string; type: string }> {
    if (!Array.isArray(diffs)) {
      return [];
    }

    const changes: Array<{ path: string; type: string }> = [];

    for (const diff of diffs) {
      const type = diff.new_file
        ? 'created'
        : diff.deleted_file
          ? 'deleted'
          : 'modified';

      const filePath =
        type === 'deleted'
          ? diff.old_path ?? diff.new_path
          : diff.new_path ?? diff.old_path;

      if (filePath) {
        changes.push({ path: filePath, type });
      }
    }

    return changes;
  }

  private buildCodeChangeSummaryText(
    changes: Array<{ path: string; type: string }>
  ): string | null {
    const highlights = this.buildLogicChangeHighlights(changes);
    if (highlights.length > 0) {
      return ['本次合并请求逻辑关键点：', ...highlights].join('\n');
    }

    const fallback = this.buildChangeSummary(changes, 8);
    if (fallback.length === 0) {
      return null;
    }
    return ['本次合并请求包含以下关键改动：', ...fallback].join('\n');
  }

  private async ensureMergeRequestTitleFormat(
    event: GitLabWebhookEvent,
    mrInfo: { iid: number },
    currentTitle: string,
    instruction: AiInstruction,
    changes: Array<{ path: string; type: string }>,
    suggestedTitle?: string | null
  ): Promise<void> {
    const desiredTitle =
      (suggestedTitle && suggestedTitle.trim()) ||
      this.buildFormattedMrTitle(instruction, changes);

    if (!desiredTitle) {
      logger.info('Skipping MR title update - no generated title available', {
        projectId: event.project.id,
        mrIid: mrInfo.iid,
      });
      return;
    }

    if (desiredTitle === (currentTitle || '').trim()) {
      logger.info('Skipping MR title update - already matches desired format', {
        projectId: event.project.id,
        mrIid: mrInfo.iid,
      });
      return;
    }

    try {
      await this.gitlabService.updateMergeRequestTitle(event.project.id, mrInfo.iid, desiredTitle);
      logger.info('Updated merge request title with formatted summary', {
        projectId: event.project.id,
        mrIid: mrInfo.iid,
        newTitle: desiredTitle,
      });
    } catch (error) {
      logger.error('Failed to update merge request title with formatted summary', {
        error: error instanceof Error ? error.message : String(error),
        projectId: event.project.id,
        mrIid: mrInfo.iid,
      });
    }
  }

  private buildFormattedMrTitle(
    instruction: AiInstruction,
    changes: Array<{ path: string; type: string }>
  ): string | null {
    const normalizedInstruction = (instruction.command || '').trim();
    const normalizedContext = instruction.context || '';
    const primary = this.detectPrimaryChangeFocus(changes);

    const focusSummary = primary ? this.describePrimaryChangeSummary(primary) : null;
    const fallback =
      focusSummary ||
      this.truncateText(normalizedInstruction || normalizedContext || '', 60) ||
      null;

    if (!fallback) {
      return null;
    }

    const category = this.detectChangeCategory(`${normalizedInstruction} ${normalizedContext}`);
    return `${category}: ${fallback}`;
  }

  private detectPrimaryChangeFocus(
    changes: Array<{ path: string; type: string }>
  ): { action: 'created' | 'modified' | 'deleted'; prefix: string; files: string[] } | null {
    if (!changes || changes.length === 0) {
      return null;
    }

    const order: Array<'created' | 'modified' | 'deleted'> = ['created', 'modified', 'deleted'];

    for (const action of order) {
      const filtered = changes.filter(change => change.type === action);
      if (filtered.length === 0) {
        continue;
      }

      const groups = this.groupChangesByPrefix(filtered);
      if (groups.length === 0) {
        continue;
      }

      groups.sort((a, b) => b.files.length - a.files.length);
      const top = groups[0];
      if (top) {
        return { action, prefix: top.prefix, files: top.files };
      }
    }

    return null;
  }

  private describePrimaryChangeSummary(group: {
    action: 'created' | 'modified' | 'deleted';
    prefix: string;
    files: string[];
  }): string {
    const verb =
      group.action === 'created' ? '新增' : group.action === 'modified' ? '优化' : '清理';
    const label = this.formatGroupLabel(group.prefix, group.files);
    const examples = this.formatFileExamples(group.files, 2);
    return examples ? `${verb}${label}（${examples}）` : `${verb}${label}`;
  }

  private detectChangeCategory(source?: string): string {
    const text = (source || '').toLowerCase();
    const bugKeywords = ['fix', 'bug', 'issue', 'error', 'fault', 'repair', 'patch'];
    if (bugKeywords.some(keyword => text.includes(keyword))) {
      return 'bugfix';
    }
    return 'feature';
  }

  private buildSuccessResponse(params: {
    command: string;
    changes: Array<{ path: string; type: string }>;
    output?: string;
    sessionMode: 'new' | 'continuation' | 'none';
    baseBranch: string;
    branchName?: string;
    mergeRequestUrl?: string;
    mergeRequestIid?: number;
    warnings?: string[];
    scenario?: ExecutionScenario;
    specKitStage?: SpecKitStage | null;
    stageDocuments?: Array<{ path: string; content: string }>;
  }): string {
    const {
      command,
      changes,
      output,
      sessionMode,
      baseBranch,
      branchName,
      mergeRequestUrl,
      mergeRequestIid,
      warnings = [],
      scenario,
      specKitStage = null,
      stageDocuments = [],
    } = params;

    const commandSummary = this.truncateText(command.trim(), 200) || '（空指令）';
    const sessionLabel = this.getSessionModeLabel(sessionMode);
    const changeCount = changes.length;
    const hasMrWarning = warnings.some(message => message.includes('合并请求'));

    const mrSummary = mergeRequestUrl
      ? mergeRequestIid
        ? `合并请求状态：已更新 [!${mergeRequestIid}](${mergeRequestUrl})`
        : `合并请求状态：已更新 [查看](${mergeRequestUrl})`
      : hasMrWarning
        ? '合并请求状态：创建失败（详见附加说明）'
        : '合并请求状态：尚未创建';

    const summaryItems = [
      `指令摘要：${commandSummary}`,
      `执行模式：${sessionLabel}`,
      `代码变更：${changeCount} 个文件`,
      mrSummary,
    ];

    const lines: string[] = [];
    lines.push('### ✅ 工作完成', '');
    lines.push('**梗概**');
    const conciseOutput = this.summarizeOutput(output);
    const changeSummary = this.buildChangeSummary(changes);
    if (changeSummary.length > 0) {
      lines.push(...changeSummary);
    }
    if (conciseOutput) {
      lines.push(`- ${conciseOutput}`);
    }
    if (changeSummary.length === 0 && !conciseOutput) {
      lines.push('- (无摘要)');
    }
    lines.push('');
    lines.push('**执行摘要**');
    summaryItems.forEach(item => lines.push(`- ${item}`));
    if (warnings.length > 0) {
      warnings.forEach(message => lines.push(`- 警告：${message}`));
    }
    lines.push('');

    lines.push(this.buildFileChangesSection(changes));
    lines.push('');

    lines.push('**分支 & MR**', '');
    const branchLine =
      specKitStage
        ? '- 工作分支：由 Spec Kit 自动创建和管理'
        : branchName
          ? `- 工作分支：\`${branchName}\` → \`${baseBranch}\``
          : `- 工作分支：直接在 \`${baseBranch}\` 上执行`;
    lines.push(branchLine);
    lines.push(
      mergeRequestUrl
        ? mergeRequestIid
          ? `- 合并请求：已更新 [!${mergeRequestIid}](${mergeRequestUrl})`
          : `- 合并请求：已更新 [查看](${mergeRequestUrl})`
        : hasMrWarning
          ? '- 合并请求：创建失败（详见附加说明）'
          : '- 合并请求：尚未创建'
    );
    lines.push('');

    lines.push('**需要澄清的问题**', '');
    lines.push('- 暂无疑问');
    lines.push('');

    if (stageDocuments.length > 0 && specKitStage) {
      const stageLabelMap: Record<SpecKitStage, string> = {
        spec: '文档正文',
        plan: 'Plan 文档',
        tasks: 'Tasks 文档',
      };
      const stageLabel = stageLabelMap[specKitStage] || '文档正文';
      lines.push(`**${stageLabel}**`, '');
      stageDocuments.forEach(doc => {
        lines.push(`> 文件：\`${doc.path}\``);
        lines.push('');
        lines.push(doc.content.trimEnd());
        lines.push('');
      });
    } else if (output && output.trim()) {
      lines.push('**AI 原始回复**', '');
      lines.push(output.trim());
      lines.push('');
    }

    lines.push('', AI_RESPONSE_MARKER);

    return lines.join('\n');
  }

  private buildFailureResponse(params: { command: string; error?: string }): string {
    const { command, error } = params;
    const commandSummary = this.truncateText(command.trim(), 200) || '（空指令）';
    const sanitizedError = error?.trim();
    const firstLine = sanitizedError?.split('\n').find(Boolean);

    const lines: string[] = [];
    lines.push('### ❌ 工作失败', '');
    lines.push('**指令摘要**');
    lines.push(`> ${commandSummary}`, '');

    lines.push('**核心业务逻辑**');
    lines.push('- 执行未完成，未产出业务结果');
    lines.push('');

    lines.push('**执行摘要**');
    if (firstLine) {
      lines.push(`- 执行失败：${firstLine}`);
      if (sanitizedError && sanitizedError !== firstLine) {
        lines.push('- 详见附加说明中的诊断信息');
      }
    } else {
      lines.push('- 执行失败，未提供具体错误原因');
    }
    lines.push('- 未生成有效代码变更');
    lines.push('');

    lines.push('**代码变更**');
    lines.push('- 本次未对仓库做任何修改');
    lines.push('');

    lines.push('**分支 & MR**');
    lines.push('- 工作分支：未创建');
    lines.push('- 合并请求：尚未创建');
    lines.push('');

    lines.push('**需要澄清的问题**');
    lines.push('- 暂无疑问');
    lines.push('');

    lines.push('**附加说明**', '');
    if (sanitizedError) {
      lines.push('```');
      lines.push(sanitizedError);
      lines.push('```');
    } else {
      lines.push('- 无');
    }

    lines.push('', AI_RESPONSE_MARKER);

    return lines.join('\n');
  }

  private buildFileChangesSection(changes: Array<{ path: string; type: string }>): string {
    if (!changes || changes.length === 0) {
      return '**代码变更**\n- 本次未对仓库做任何修改';
    }

    const rows = changes.map(change => {
      const typeLabel = this.toTitleCase(change.type || 'updated');
      const pathLabel = change.path ? `\`${change.path}\`` : '`(未知路径)`';
      return `| ${typeLabel} | ${pathLabel} |`;
    });

    const tableLines = ['**代码变更**', '', '| 类型 | 文件 |', '| --- | --- |', ...rows];
    return tableLines.join('\n');
  }

  private truncateText(text: string, maxLength: number): string {
    if (!text) {
      return '';
    }
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
  }

  private toTitleCase(input: string): string {
    if (!input) {
      return '';
    }
    const lower = input.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }

  private getSessionModeLabel(mode: 'new' | 'continuation' | 'none'): string {
    switch (mode) {
      case 'new':
        return '新建会话';
      case 'continuation':
        return '延续会话';
      default:
        return '单次执行';
    }
  }
}
