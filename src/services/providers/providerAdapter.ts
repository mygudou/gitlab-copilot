import { AiExecutionContext, ExecutionOptions } from '../../types/aiExecution';

export type ProviderId = 'claude' | 'codex';

export interface PromptPayload {
  prompt: string;
  systemPrompt?: string | null;
}

export interface ProviderExecutionConfig {
  args: string[];
}

export interface ParsedExecutionResult {
  text: string;
  raw: string;
  sessionId?: string | null;
}

export interface ProviderAdapter {
  readonly id: ProviderId;

  getBinary(): string;
  getDisplayName(): string;
  buildEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

  createExecutionConfig(
    payload: PromptPayload,
    context: AiExecutionContext,
    options?: ExecutionOptions
  ): ProviderExecutionConfig;

  parseResult(rawOutput: string): ParsedExecutionResult;
  extractProgressMessage(buffer: string): string;
  extractSessionId?(rawOutput: string): string | null;
}
