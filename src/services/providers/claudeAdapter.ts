import { config } from '../../utils/config';
import { AiExecutionContext, ExecutionOptions } from '../../types/aiExecution';
import {
  ProviderAdapter,
  ProviderExecutionConfig,
  PromptPayload,
  ParsedExecutionResult,
} from './providerAdapter';

export class ClaudeAdapter implements ProviderAdapter {
  public readonly id = 'claude' as const;

  public getBinary(): string {
    return 'claude';
  }

  public getDisplayName(): string {
    return 'Claude';
  }

  public buildEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      ANTHROPIC_BASE_URL: config.anthropic.baseUrl,
    };

    if (config.anthropic.authToken) {
      env.ANTHROPIC_AUTH_TOKEN = config.anthropic.authToken;
    }

    return env;
  }

  public createExecutionConfig(
    payload: PromptPayload,
    _context: AiExecutionContext,
    options?: ExecutionOptions
  ): ProviderExecutionConfig {
    const args = ['--print', '--model', 'sonnet'];

    const isSpecScenario = _context.scenario === 'spec-doc';

    if (!options || options.outputFormat === 'text') {
      args.push('--output-format', 'text');
    } else {
      args.push('--output-format', 'json');
    }

    if (isSpecScenario) {
      args.push('--permission-mode', 'acceptEdits');
    } else {
      args.push('--dangerously-skip-permissions');
    }

    if (options?.sessionId && !options.isNewSession) {
      args.push('--resume', options.sessionId);
    }

    if (payload.systemPrompt) {
      args.push('--append-system-prompt', payload.systemPrompt);
    }

    let allowedTools = 'Bash,Read,Write,Edit,Glob,Grep,LS,MultiEdit,NotebookEdit';
    if (isSpecScenario) {
      const slashCommand = this.extractSlashCommand(payload.prompt) ?? '/speckit.specify';
      allowedTools = [`SlashCommand:${slashCommand}`, 'Read', 'Bash', 'Git'].join(',');
    }

    args.push(`--allowedTools=${allowedTools}`);
    args.push(payload.prompt);

    return { args };
  }

  public parseResult(rawOutput: string): ParsedExecutionResult {
    const trimmed = rawOutput?.trim() ?? '';
    if (!trimmed) {
      return { text: '', raw: '' };
    }

    const parsedText = this.extractTextFromJson(trimmed) ?? trimmed;
    const sessionId = this.extractSessionId(trimmed);

    return {
      text: parsedText,
      raw: trimmed,
      sessionId: sessionId ?? undefined,
    };
  }

  public extractProgressMessage(buffer: string): string {
    const lines = buffer.split('\n').filter(line => line.trim());
    const lastLine = lines[lines.length - 1];

    if (
      lastLine &&
      !lastLine.includes('DEBUG') &&
      !lastLine.includes('INFO') &&
      lastLine.length > 10 &&
      lastLine.length < 200
    ) {
      const lower = lastLine.toLowerCase().trim();
      if (lower === 'execution error' || lower === 'error' || lower === 'failed') {
        return '';
      }

      const isError =
        lower.includes('error') || lower.includes('failed') || lower.includes('exception');

      if (isError) {
        return `❌ ${lastLine.trim()}`;
      }

      return `🤖 ${lastLine.trim()}`;
    }

    return '';
  }

  public extractSessionId(rawOutput: string): string | null {
    if (!rawOutput) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawOutput);
      if (parsed && typeof parsed.session_id === 'string') {
        return parsed.session_id;
      }
    } catch {
      // ignore
    }

    const match = rawOutput.match(/"session_id":\s*"([^"]+)"/);
    if (match) {
      return match[1];
    }

    return null;
  }

  private extractSlashCommand(prompt: string): string | null {
    if (!prompt) {
      return null;
    }

    const trimmed = prompt.trim();
    const match = trimmed.match(/^\/(\S+)/);
    if (match && match[1]) {
      return `/${match[1].replace(/[,\s]+$/, '')}`;
    }

    return null;
  }

  private extractTextFromJson(candidate: string): string | null {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed.result === 'string') {
        return parsed.result.trim();
      }
    } catch {
      // ignore
    }

    const lines = candidate
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .reverse();

    for (const line of lines) {
      if (!line.startsWith('{')) {
        continue;
      }

      try {
        const parsedLine = JSON.parse(line);
        if (parsedLine && typeof parsedLine.result === 'string') {
          return parsedLine.result.trim();
        }
      } catch {
        // ignore
      }
    }

    return null;
  }
}
