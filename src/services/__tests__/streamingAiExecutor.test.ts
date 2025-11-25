import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { StreamingAiExecutor } from '../streamingAiExecutor';
import { PromptPayload, ProviderAdapter, ParsedExecutionResult } from '../providers/providerAdapter';
import { AiExecutionContext, ExecutionOptions } from '../../types/aiExecution';
import { CodexAdapter } from '../providers/codexAdapter';
import { ClaudeAdapter } from '../providers/claudeAdapter';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

jest.mock('../projectManager', () => ({
  ProjectManager: jest.fn().mockImplementation(() => ({
    getChangedFiles: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../utils/config', () => ({
  config: {
    ai: {
      executor: 'codex',
    },
    anthropic: {
      baseUrl: 'https://api.anthropic.com',
      authToken: 'test-token',
    },
    session: {
      enabled: true,
      maxIdleTime: 0,
      maxSessions: 10,
      cleanupInterval: 0,
      storagePath: '/tmp/test-sessions.json',
    },
  },
}));

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

class MockAdapter implements ProviderAdapter {
  public readonly id = 'codex' as const;
  public parseResultImpl = jest.fn<ParsedExecutionResult, [string]>();
  public createExecutionConfigImpl = jest.fn();

  getBinary(): string {
    return 'mock-cli';
  }

  getDisplayName(): string {
    return 'MockAI';
  }

  buildEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...baseEnv };
  }

  createExecutionConfig(payload: PromptPayload, _context: AiExecutionContext, options?: ExecutionOptions) {
    this.createExecutionConfigImpl(payload, options);
    return {
      args: ['run', payload.prompt],
    };
  }

  parseResult(rawOutput: string): ParsedExecutionResult {
    return this.parseResultImpl(rawOutput);
  }

  extractProgressMessage(buffer: string): string {
    return buffer.trim() ? `progress:${buffer.trim()}` : '';
  }
}

const createMockProcess = () => {
  const mockProcess = new EventEmitter() as any;
  mockProcess.stdout = new EventEmitter();
  mockProcess.stderr = new EventEmitter();
  mockProcess.stdin = { end: jest.fn() };
  mockProcess.kill = jest.fn();
  return mockProcess;
};

const createContext = (): AiExecutionContext => ({
  context: 'Sample context',
  projectUrl: 'https://example.com/project',
  branch: 'main',
  instruction: 'Do something',
  event: {} as any,
  provider: 'codex',
});

describe('StreamingAiExecutor', () => {
  let executor: StreamingAiExecutor;
  let adapter: MockAdapter;
  let callback: { onProgress: jest.Mock; onError: jest.Mock };
  let context: AiExecutionContext;

  beforeEach(() => {
    adapter = new MockAdapter();
    executor = new StreamingAiExecutor([adapter]);
    callback = {
      onProgress: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn().mockResolvedValue(undefined),
    };
    context = createContext();

    jest.spyOn(executor as any, 'checkCliAvailability').mockResolvedValue(undefined);
    jest.clearAllMocks();
  });

  describe('executeWithStreaming', () => {
    it('returns parsed output on success', async () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      adapter.parseResultImpl.mockReturnValue({
        text: 'Parsed output',
        raw: 'Parsed output',
      });

      const executionPromise = executor.executeWithStreaming(
        'test command',
        '/tmp/project',
        context,
        callback
      );

      process.nextTick(() => {
        mockProcess.stdout.emit('data', 'raw output');
        mockProcess.emit('close', 0);
      });

      const result = await executionPromise;
      expect(result.success).toBe(true);
      expect(result.output).toBe('Parsed output');
      expect(adapter.createExecutionConfigImpl).toHaveBeenCalled();
      expect(callback.onProgress).toHaveBeenCalled();
    });

    it('propagates errors from CLI execution', async () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      adapter.parseResultImpl.mockReturnValue({
        text: '',
        raw: '',
      });

      const executionPromise = executor.executeWithStreaming(
        'test command',
        '/tmp/project',
        context,
        callback
      );

      process.nextTick(() => {
        mockProcess.stderr.emit('data', 'Critical failure');
        mockProcess.emit('close', 1);
      });

      const result = await executionPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Critical failure');
      expect(callback.onError).toHaveBeenCalled();
    });
  });

  describe('executeWithSession', () => {
    it('resolves session id from adapter result', async () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      adapter.parseResultImpl.mockReturnValue({
        text: 'Handled',
        raw: 'Handled',
        sessionId: 'session-123',
      });

      const options: ExecutionOptions = {
        isNewSession: true,
        outputFormat: 'json',
      };

      const promise = executor.executeWithSession(
        'session command',
        '/tmp/project',
        context,
        callback,
        options
      );

      process.nextTick(() => {
        mockProcess.stdout.emit('data', 'session output');
        mockProcess.emit('close', 0);
      });

      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.sessionId).toBe('session-123');
    });

    it('falls back to provided session id when adapter returns none', async () => {
      const mockProcess = createMockProcess();
      mockSpawn.mockReturnValue(mockProcess);

      adapter.parseResultImpl.mockReturnValue({
        text: 'Handled',
        raw: 'Handled',
      });

      const options: ExecutionOptions = {
        sessionId: 'existing-session',
        isNewSession: false,
        outputFormat: 'text',
      };

      const promise = executor.executeWithSession(
        'session command',
        '/tmp/project',
        context,
        callback,
        options
      );

      process.nextTick(() => {
        mockProcess.stdout.emit('data', 'session output');
        mockProcess.emit('close', 0);
      });

      const result = await promise;
      expect(result.success).toBe(true);
      expect(result.sessionId).toBe('existing-session');
    });
  });
});

describe('CodexAdapter', () => {
  const adapter = new CodexAdapter();
  const context = createContext();

  it('builds CLI args for streaming execution', () => {
    const payload: PromptPayload = { prompt: 'user prompt' };
    const config = adapter.createExecutionConfig(payload, context);

    expect(config.args[0]).toBe('exec');
    expect(config.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(config.args[config.args.length - 1]).toBe('user prompt');
  });

  it('builds CLI args for session resume', () => {
    const payload: PromptPayload = { prompt: 'user prompt' };
    const options: ExecutionOptions = {
      sessionId: 'resume-id',
      isNewSession: false,
      outputFormat: 'json',
    };

    const config = adapter.createExecutionConfig(payload, context, options);
    expect(config.args).toContain('resume');
    expect(config.args).toContain('resume-id');
    expect(config.args[0]).toBe('exec');
    expect(config.args).toContain('--experimental-json');
  });

  it('omits experimental json flag when requesting text output', () => {
    const payload: PromptPayload = { prompt: 'user prompt' };
    const options: ExecutionOptions = {
      sessionId: 'resume-id',
      isNewSession: false,
      outputFormat: 'text',
    };

    const config = adapter.createExecutionConfig(payload, context, options);
    expect(config.args).toContain('resume');
    expect(config.args).toContain('resume-id');
    expect(config.args).not.toContain('--experimental-json');
  });

  it('parses assistant message and session id from output', () => {
    const output = [
      '{"type":"session.created","session_id":"codex-session-xyz"}',
      '{"type":"item.completed","item":{"item_type":"assistant_message","text":"All done"}}',
    ].join('\n');

    const parsed = adapter.parseResult(output);
    expect(parsed.text).toBe('All done');
    expect(parsed.sessionId).toBe('codex-session-xyz');
  });

  it('extracts progress message from command execution event', () => {
    const message = adapter.extractProgressMessage(
      '{"type":"item.started","item":{"item_type":"command_execution","command":"ls"}}\n'
    );
    expect(message).toContain('执行命令');
  });
});

describe('ClaudeAdapter', () => {
  const adapter = new ClaudeAdapter();
  const context = { ...createContext(), provider: 'claude' as const };

  it('builds CLI args with system prompt and resume flag', () => {
    const payload: PromptPayload = {
      prompt: 'user prompt',
      systemPrompt: 'system instructions',
    };

    const options: ExecutionOptions = {
      sessionId: 'claude-session',
      isNewSession: false,
      outputFormat: 'text',
    };

    const config = adapter.createExecutionConfig(payload, context, options);

    expect(config.args).toContain('--print');
    expect(config.args).toContain('--resume');
    expect(config.args).toContain('claude-session');
    expect(config.args).toContain('--append-system-prompt');
    expect(config.args[config.args.length - 1]).toBe('user prompt');
  });

  it('parses result from JSON payload and extracts session id', () => {
    const json = JSON.stringify({
      session_id: 'claude-session-1',
      result: 'Completed response',
    });

    const parsed = adapter.parseResult(json);
    expect(parsed.text).toBe('Completed response');
    expect(parsed.sessionId).toBe('claude-session-1');
  });

  it('extracts progress message from informative line', () => {
    const message = adapter.extractProgressMessage('Processing file foo.ts\n');
    expect(message).toContain('Processing file');
  });
});
