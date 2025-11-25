import { GitLabWebhookEvent } from './gitlab';
import { ProcessResult } from './common';

export type ExecutionScenario = 'issue-session' | 'mr-fix' | 'code-review' | 'spec-doc';

export interface AiExecutionContext {
  context: string;
  fullContext?: string;
  projectUrl: string;
  branch: string;
  timeoutMs?: number;
  event: GitLabWebhookEvent;
  instruction: string;
  provider?: 'claude' | 'codex';
  isIssueScenario?: boolean;
  scenario?: ExecutionScenario;
}

export interface StreamingProgressCallback {
  onProgress: (message: string, isComplete?: boolean) => Promise<void>;
  onError: (error: string) => Promise<void>;
}

export interface ExecutionOptions {
  sessionId?: string;
  isNewSession: boolean;
  outputFormat: 'text' | 'json';
}

export interface SessionExecutionResult extends ProcessResult {
  sessionId?: string;
}
