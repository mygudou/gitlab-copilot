import { AiExecutionContext, ExecutionOptions } from '../../types/aiExecution';
import {
  ProviderAdapter,
  ProviderExecutionConfig,
  PromptPayload,
  ParsedExecutionResult,
} from './providerAdapter';
import logger from '../../utils/logger';

export class CodexAdapter implements ProviderAdapter {
  public readonly id = 'codex' as const;

  public getBinary(): string {
    return 'codex';
  }

  public getDisplayName(): string {
    return 'Codex';
  }

  public buildEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return {
      ...baseEnv,
    };
  }

  public createExecutionConfig(
    payload: PromptPayload,
    _context: AiExecutionContext,
    options?: ExecutionOptions
  ): ProviderExecutionConfig {
    if (options) {
      const args = ['exec'];

      if (options.outputFormat === 'json') {
        args.push('--experimental-json');
      }

      args.push(
        '--dangerously-bypass-approvals-and-sandbox',
        '--color',
        'never'
      );

      if (options.sessionId && !options.isNewSession) {
        args.push('resume', options.sessionId, payload.prompt);
      } else {
        args.push(payload.prompt);
      }

      return { args };
    }

    return {
      args: [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--color',
        'never',
        payload.prompt,
      ],
    };
  }

  public parseResult(rawOutput: string): ParsedExecutionResult {
    const trimmed = rawOutput?.trim() ?? '';
    if (!trimmed) {
      return { text: '', raw: '' };
    }

    const { text: streamText, sessionId: streamSession } = this.parseEventStream(trimmed);
    const message = streamText ?? this.extractAssistantMessage(trimmed);
    const textFromJson = this.extractTextFromJson(trimmed);
    const text = message ?? textFromJson ?? trimmed;
    const sessionId = streamSession ?? this.extractSessionId(trimmed);

    if (streamText) {
      logger.debug('Extracted Codex assistant message from streaming events', {
        snippet: streamText.substring(0, 200),
      });
    } else if (message) {
      logger.debug('Extracted Codex assistant message from JSON output', {
        snippet: message.substring(0, 200),
      });
    } else if (textFromJson) {
      logger.debug('Extracted Codex result text from JSON output', {
        snippet: textFromJson.substring(0, 200),
      });
    }

    return {
      text,
      raw: trimmed,
      sessionId: sessionId ?? undefined,
    };
  }

  public extractProgressMessage(buffer: string): string {
    const lines = buffer.split('\n').map(line => line.trim()).filter(Boolean);
    let message = '';

    for (const line of lines) {
      if (!line.startsWith('{')) {
        continue;
      }

      try {
        const event = JSON.parse(line);
        const formatted = this.formatProgressEvent(event);
        if (formatted) {
          message = formatted;
        }
      } catch {
        // ignore
      }
    }

    if (message) {
      return message;
    }

    const lastLine = lines[lines.length - 1];
    if (lastLine && lastLine.length > 5 && lastLine.length < 300) {
      return `🤖 ${lastLine.trim()}`;
    }

    return '';
  }

  public extractSessionId(rawOutput: string): string | null {
    if (!rawOutput) {
      return null;
    }

    const lines = rawOutput
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      if (!line.startsWith('{')) {
        continue;
      }

      try {
        const event = JSON.parse(line);
        if (typeof event?.session_id === 'string' && event.session_id.trim()) {
          return event.session_id.trim();
        }
        if (event?.type === 'session.created' && typeof event.session_id === 'string') {
          return event.session_id.trim();
        }
      } catch {
        // ignore
      }
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

  private extractAssistantMessage(output: string): string | null {
    const { text } = this.parseEventStream(output);
    if (text) {
      return text;
    }

    const lines = output
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    let lastMessage: string | null = null;

    for (const line of lines) {
      if (!line.startsWith('{')) {
        continue;
      }

      try {
        const event = JSON.parse(line);

        if (event?.type === 'item.completed' && event?.item?.item_type === 'assistant_message') {
          const text = this.normalizeText(event.item.text);
          if (text) {
            lastMessage = text;
          }
        } else if (event?.type === 'message' && typeof event?.content === 'string') {
          const content = event.content.trim();
          if (content) {
            lastMessage = content;
          }
        } else if (typeof event?.message === 'string') {
          const message = event.message.trim();
          if (message) {
            lastMessage = message;
          }
        }
      } catch {
        // ignore
      }
    }

    return lastMessage;
  }

  private formatProgressEvent(event: any): string | null {
    if (!event || typeof event !== 'object') {
      return null;
    }

    if (event.type === 'session.created' && typeof event.session_id === 'string') {
      return `🔄 会话 ID: ${event.session_id}`;
    }

    if ((event.type === 'item.completed' || event.type === 'item.started') && event.item) {
      const item = event.item;
      const itemType = item.item_type;

      if (itemType === 'reasoning' && typeof item.text === 'string') {
        return `🧠 ${this.normalizeText(item.text)}`;
      }

      if (itemType === 'plan' && typeof item.text === 'string') {
        return `🗺️ ${this.normalizeText(item.text)}`;
      }

      if (itemType === 'assistant_message') {
        return null;
      }

      if (itemType === 'command_execution') {
        const command = typeof item.command === 'string' ? item.command : undefined;
        if (event.type === 'item.started') {
          return command ? `🔄 执行命令: ${command}` : '🔄 正在执行命令';
        }

        const output = this.normalizeText(item.aggregated_output);
        if (item.status === 'completed') {
          if (output) {
            const truncated = this.truncateText(output, 400);
            return command ? `📄 ${command}\n${truncated}` : `📄 ${truncated}`;
          }
          return command ? `✅ 已完成命令: ${command}` : '✅ 命令执行完成';
        }

        if (item.status === 'failed') {
          if (output) {
            const truncated = this.truncateText(output, 400);
            return command ? `❌ 命令 ${command} 失败\n${truncated}` : `❌ 命令执行失败\n${truncated}`;
          }
          return command ? `❌ 命令 ${command} 失败` : '❌ 命令执行失败';
        }
      }
    }

    if (event.type === 'error') {
      const message = typeof event.message === 'string' ? event.message : event.error;
      if (typeof message === 'string' && message.trim()) {
        return `❌ ${message.trim()}`;
      }
    }

    if (typeof event.message === 'string' && event.message.trim()) {
      return `🤖 ${event.message.trim()}`;
    }

    return null;
  }

  private normalizeText(text?: string): string {
    if (!text || typeof text !== 'string') {
      return '';
    }

    return text.replace(/\r/g, '').replace(/ {2}\n/g, '\n').trim();
  }

  private parseEventStream(output: string): { text: string | null; sessionId: string | null } {
    if (!output || !output.includes('{')) {
      return { text: null, sessionId: null };
    }

    const lines = output
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    const deltas: string[] = [];
    const fallbacks: string[] = [];
    let sessionId: string | null = null;

    for (const line of lines) {
      if (!line.startsWith('{')) {
        continue;
      }

      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      if (!sessionId) {
        sessionId = this.extractSessionIdFromEvent(event);
      }

      const type = typeof event?.type === 'string' ? event.type : '';

      if (type === 'response.output_text.delta') {
        const deltaText = this.flattenText(event.delta, 0, true);
        if (deltaText) {
          deltas.push(deltaText);
        }
        continue;
      }

      if (type === 'response.output_text.done') {
        const doneText = this.flattenText(event.output_text ?? event.text);
        if (doneText) {
          fallbacks.push(doneText);
        }
        continue;
      }

      if (type === 'response.completed') {
        const completedText = this.flattenText(event.response?.output_text ?? event.response?.text ?? event.response?.content);
        if (completedText) {
          fallbacks.push(completedText);
        }
        continue;
      }

      if (type === 'item.completed' || type === 'item.updated' || type === 'item.created') {
        const itemType = this.normalizeItemType(event.item);
        if (itemType && this.isNonCommentItemType(itemType)) {
          continue;
        }

        const itemText = this.flattenText(event.item);
        if (itemText) {
          fallbacks.push(itemText);
        }
        continue;
      }

      if (type === 'message' && typeof event.content === 'string') {
        fallbacks.push(this.normalizeText(event.content));
        continue;
      }

      if (typeof event.message === 'string') {
        fallbacks.push(this.normalizeText(event.message));
        continue;
      }

      const genericText = this.flattenText(event.text ?? event.content ?? event.output_text ?? event.result);
      if (genericText) {
        fallbacks.push(genericText);
      }
    }

    const combinedDelta = deltas.join('');
    const deltaText = this.normalizeText(combinedDelta);
    const fallbackText = fallbacks.length > 0 ? this.normalizeText(fallbacks[fallbacks.length - 1]) : '';

    const text = deltaText || fallbackText || null;

    return {
      text,
      sessionId,
    };
  }

  private flattenText(value: unknown, depth = 0, preserveWhitespace = false): string {
    if (value == null) {
      return '';
    }

    if (typeof value === 'string') {
      const normalized = value.replace(/\r/g, '');
      return preserveWhitespace ? normalized : this.normalizeText(normalized);
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    if (Array.isArray(value)) {
      return value.map(item => this.flattenText(item, depth + 1, preserveWhitespace)).join('');
    }

    if (typeof value === 'object') {
      if (depth > 5) {
        return '';
      }

      const obj = value as Record<string, unknown>;
      const keys = ['text', 'delta', 'content', 'output_text', 'message', 'value'];
      let buffer = '';

      for (const key of keys) {
        if (key in obj) {
          buffer += this.flattenText(obj[key], depth + 1, preserveWhitespace);
        }
      }

      return buffer;
    }

    return '';
  }

  private normalizeItemType(item: any): string {
    if (!item || typeof item !== 'object') {
      return '';
    }

    const rawType = (item.type ?? item.item_type ?? item.kind ?? '') as string;
    return typeof rawType === 'string' ? rawType.toLowerCase() : '';
  }

  private isNonCommentItemType(itemType: string): boolean {
    if (!itemType) {
      return false;
    }

    const disallowed = ['reasoning', 'analysis', 'plan', 'tool', 'command', 'execution'];
    return disallowed.some(disallowedType => itemType.includes(disallowedType));
  }

  private extractSessionIdFromEvent(event: any): string | null {
    if (!event || typeof event !== 'object') {
      return null;
    }

    const candidates: Array<unknown> = [
      event.session_id,
      event.sessionId,
      event.session?.id,
      event.session?.session_id,
      event.response?.session_id,
      event.metadata?.session_id,
      event?.data?.session_id,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    if (typeof event.type === 'string') {
      if (event.type === 'session.created' && typeof event.session?.id === 'string') {
        return event.session.id.trim();
      }

      if (event.type === 'response.session.created' && typeof event.session_id === 'string') {
        return event.session_id.trim();
      }
    }

    return null;
  }

  private truncateText(text: string, maxLength = 400): string {
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.slice(0, maxLength)}…`;
  }
}
