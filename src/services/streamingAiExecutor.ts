import { spawn } from 'child_process';
import { config } from '../utils/config';
import logger from '../utils/logger';
import { ProcessResult, FileChange } from '../types/common';
import { ProjectManager } from './projectManager';
import { PromptBuilder } from './promptBuilder';
import {
  ProviderAdapter,
  ProviderExecutionConfig,
  ProviderId,
  ParsedExecutionResult,
} from './providers/providerAdapter';
import { CodexAdapter } from './providers/codexAdapter';
import { ClaudeAdapter } from './providers/claudeAdapter';

import {
  AiExecutionContext,
  ExecutionOptions,
  SessionExecutionResult,
  StreamingProgressCallback,
} from '../types/aiExecution';

export type {
  AiExecutionContext,
  ExecutionOptions,
  SessionExecutionResult,
  StreamingProgressCallback,
} from '../types/aiExecution';

interface RunCliProcessParams {
  commandLabel: string;
  projectPath: string;
  adapter: ProviderAdapter;
  callback: StreamingProgressCallback;
  cliArgs: string[];
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

interface ProviderRegistry {
  [key: string]: ProviderAdapter;
}

export class StreamingAiExecutor {
  private readonly projectManager: ProjectManager;
  private readonly promptBuilder: PromptBuilder;
  private readonly adapters: ProviderRegistry;
  private readonly defaultTimeoutMs = 1200000; // 20 minutes

  constructor(adapters?: ProviderAdapter[]) {
    this.projectManager = new ProjectManager();
    this.promptBuilder = new PromptBuilder();
    this.adapters = this.buildAdapterRegistry(adapters);
  }

  public async executeWithSession(
    command: string,
    projectPath: string,
    context: AiExecutionContext,
    callback: StreamingProgressCallback,
    options: ExecutionOptions
  ): Promise<SessionExecutionResult> {
    try {
      const adapter = this.getAdapter(context.provider);
      const executorName = adapter.getDisplayName();

      logger.info(`Starting streaming ${executorName} execution with session support`, {
        command: command.substring(0, 100),
        projectPath,
        context: context.context,
        sessionId: options.sessionId,
        isNewSession: options.isNewSession,
        outputFormat: options.outputFormat,
      });

      await this.checkCliAvailability(adapter);

      const sessionInfo = options.sessionId ? ` (Session: ${options.sessionId.substring(0, 8)}...)` : '';
      await callback.onProgress(`🚀 ${executorName} is analyzing your request${sessionInfo}...`, false);

      const executionResult = await this.runStreamingCommand({
        command,
        projectPath,
        context,
        callback,
        adapter,
        options,
      });

      const changes = await this.getFileChanges(projectPath);
      if (changes.length > 0) {
        await callback.onProgress(`📝 ${executorName} made changes to ${changes.length} file(s)`, false);
      }

      await callback.onProgress(`✅ ${executorName} execution completed successfully!`, true);

      return {
        success: true,
        output: executionResult.text,
        sessionId: executionResult.sessionId ?? options.sessionId,
        changes,
      };
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      const adapter = this.getAdapter(context.provider);
      const executorName = adapter.getDisplayName();

      logger.error(`Streaming ${executorName} execution failed:`, error);
      await callback.onError(`❌ ${executorName} execution failed: ${errMessage}`);

      return {
        success: false,
        error: errMessage,
      };
    }
  }

  public async executeWithStreaming(
    command: string,
    projectPath: string,
    context: AiExecutionContext,
    callback: StreamingProgressCallback
  ): Promise<ProcessResult> {
    try {
      const adapter = this.getAdapter(context.provider);
      const executorName = adapter.getDisplayName();

      logger.info(`Starting streaming ${executorName} execution`, {
        command: command.substring(0, 100),
        projectPath,
        context: context.context,
      });

      await this.checkCliAvailability(adapter);
      await callback.onProgress(`🚀 ${executorName} is analyzing your request...`, false);

      const executionResult = await this.runStreamingCommand({
        command,
        projectPath,
        context,
        callback,
        adapter,
      });

      const changes = await this.getFileChanges(projectPath);
      if (changes.length > 0) {
        await callback.onProgress(`📝 ${executorName} made changes to ${changes.length} file(s)`, false);
      }

      await callback.onProgress(`✅ ${executorName} execution completed successfully!`, true);

      return {
        success: true,
        output: executionResult.text,
        changes,
      };
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      const adapter = this.getAdapter(context.provider);
      const executorName = adapter.getDisplayName();

      logger.error(`Streaming ${executorName} execution failed:`, error);
      await callback.onError(`❌ ${executorName} execution failed: ${errMessage}`);

      return {
        success: false,
        error: errMessage,
      };
    }
  }

  private buildAdapterRegistry(adapters?: ProviderAdapter[]): ProviderRegistry {
    const providerAdapters = adapters ?? [new CodexAdapter(), new ClaudeAdapter()];
    return providerAdapters.reduce<ProviderRegistry>((registry, adapter) => {
      registry[adapter.id] = adapter;
      return registry;
    }, {});
  }

  private resolveProviderId(provider?: ProviderId): ProviderId {
    return provider ?? (config.ai.executor as ProviderId);
  }

  private getAdapter(provider?: ProviderId): ProviderAdapter {
    const id = this.resolveProviderId(provider);
    const adapter = this.adapters[id];
    if (!adapter) {
      throw new Error(`Unsupported AI provider: ${id}`);
    }
    return adapter;
  }

  private async runStreamingCommand(params: {
    command: string;
    projectPath: string;
    context: AiExecutionContext;
    callback: StreamingProgressCallback;
    adapter: ProviderAdapter;
    options?: ExecutionOptions;
  }): Promise<ParsedExecutionResult> {
    const { command, projectPath, context, callback, adapter, options } = params;
    const timeoutMs = context.timeoutMs || this.defaultTimeoutMs;

    const promptPayload = this.promptBuilder.buildPrompt(adapter.id, command, context);
    const executionConfig: ProviderExecutionConfig = adapter.createExecutionConfig(
      promptPayload,
      context,
      options
    );

    const env = adapter.buildEnv(process.env ?? {});

    const result = await this.runCliProcess({
      commandLabel: command.substring(0, 100),
      projectPath,
      adapter,
      callback,
      cliArgs: executionConfig.args,
      timeoutMs,
      env,
    });

    const parsedResult = adapter.parseResult(result.output);
    if (!parsedResult.sessionId && options?.sessionId) {
      parsedResult.sessionId = options.sessionId;
    }

    return parsedResult;
  }

  private async checkCliAvailability(adapter: ProviderAdapter): Promise<void> {
    return new Promise((resolve, reject) => {
      const binary = adapter.getBinary();
      const cliProcess = spawn(binary, ['--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      cliProcess.stdout?.on('data', data => {
        stdout += data.toString();
      });

      cliProcess.stderr?.on('data', data => {
        stderr += data.toString();
      });

      cliProcess.on('close', code => {
        logger.info(`${adapter.getDisplayName()} CLI availability check`, {
          code,
          output: stdout.trim(),
          error: stderr.trim(),
          userId: process.getuid?.(),
          userName: process.env.USER || 'unknown',
        });

        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(`${adapter.getDisplayName()} CLI not found or not working: ${stderr || 'Unknown error'}`)
          );
        }
      });

      cliProcess.on('error', err => {
        reject(new Error(`Failed to check ${adapter.getDisplayName()} CLI: ${err.message}`));
      });
    });
  }

  private async runCliProcess(params: RunCliProcessParams): Promise<{ output: string }> {
    const { commandLabel, projectPath, adapter, callback, cliArgs, timeoutMs, env } = params;
    const cliBinary = adapter.getBinary();

    return new Promise((resolve, reject) => {
      const fullCommand = `${cliBinary} ${cliArgs
        .map(arg => (arg.includes(' ') ? `"${arg}"` : arg))
        .join(' ')}`;

      logger.debug(`[FULL ${adapter.getDisplayName().toUpperCase()} COMMAND] ${fullCommand}`);
      logger.info(`Executing ${adapter.getDisplayName()} CLI`, {
        command: cliBinary,
        args: cliArgs,
        fullCommand,
        cwd: projectPath,
        userId: process.getuid?.(),
        userName: process.env.USER || 'unknown',
      });

      const cliProcess = spawn(cliBinary, cliArgs, {
        cwd: projectPath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let outputBuffer = '';
      let errorBuffer = '';
      let progressBuffer = '';
      let lastProgressTime = Date.now();

      const timeoutHandle = setTimeout(() => {
        cliProcess.kill('SIGTERM');
        callback.onError(`⏰ ${adapter.getDisplayName()} execution timed out`);
        reject(new Error(`${adapter.getDisplayName()} execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      cliProcess.stdout?.on('data', async data => {
        const chunk = data.toString();
        outputBuffer += chunk;
        progressBuffer += chunk;

        console.log(`[${adapter.getDisplayName().toUpperCase()} STDOUT] ${chunk.trim()}`);
        logger.debug(`${adapter.getDisplayName()} stdout chunk`, {
          chunk: chunk.trim(),
          chunkLength: chunk.length,
        });

        const now = Date.now();
        if (now - lastProgressTime > 2000 || progressBuffer.length > 500) {
          const progressMessage = adapter.extractProgressMessage(progressBuffer);
          if (progressMessage) {
            await callback.onProgress(progressMessage, false);
          }
          progressBuffer = '';
          lastProgressTime = now;
        }
      });

      cliProcess.stderr?.on('data', async data => {
        const chunk = data.toString();
        errorBuffer += chunk;
        console.log(`[${adapter.getDisplayName().toUpperCase()} STDERR] ${chunk.trim()}`);
        logger.debug(`${adapter.getDisplayName()} stderr chunk`, chunk);

        if (chunk.trim()) {
          await callback.onProgress(`⚠️ ${adapter.getDisplayName()} error: ${chunk.trim()}`, false);
        }
      });

      cliProcess.on('close', async code => {
        clearTimeout(timeoutHandle);

        if (progressBuffer.trim()) {
          const finalMessage = adapter.extractProgressMessage(progressBuffer);
          if (finalMessage) {
            await callback.onProgress(finalMessage, false);
          }
        }

        const trimmedOutput = outputBuffer.trim();

        if (code === 0) {
          logger.info(`${adapter.getDisplayName()} command executed successfully`, {
            outputLength: outputBuffer.length,
            projectPath,
            commandLabel,
          });

          resolve({ output: trimmedOutput });
          return;
        }

        let errorMessage = errorBuffer.trim();
        if (!errorMessage) {
          errorMessage = this.deriveErrorMessage(trimmedOutput, code);
        }

        logger.warn(`${adapter.getDisplayName()} command failed`, {
          code,
          error: errorMessage,
          stdout: outputBuffer.slice(-500),
          fullOutput: outputBuffer,
          projectPath,
          commandLabel,
        });

        reject(new Error(`${adapter.getDisplayName()} execution failed (code ${code}): ${errorMessage}`));
      });

      cliProcess.on('error', err => {
        clearTimeout(timeoutHandle);
        reject(new Error(`Failed to execute ${adapter.getDisplayName()}: ${err.message}`));
      });

      cliProcess.stdin?.end();
    });
  }

  private deriveErrorMessage(output: string, code: number | null): string {
    if (!output) {
      return `Command exited with code ${code}. No output captured.`;
    }

    const lower = output.toLowerCase();
    if (lower.includes('error') || lower.includes('failed') || lower.includes('exception')) {
      const lines = output.split('\n');
      const relevant = lines.filter(line => {
        const lineLower = line.toLowerCase();
        return (
          lineLower.includes('error') ||
          lineLower.includes('failed') ||
          lineLower.includes('exception')
        );
      });

      if (relevant.length > 0) {
        return relevant.join('\n').trim();
      }

      const tail = output.slice(-500).trim();
      if (tail) {
        return tail;
      }
    }

    const fallback = output.slice(-200).trim();
    return fallback || `Command exited with code ${code}`;
  }

  private async getFileChanges(projectPath: string): Promise<FileChange[]> {
    try {
      const changedFiles = await this.projectManager.getChangedFiles(projectPath);

      return changedFiles.map(file => ({
        path: file.path,
        type: file.type as 'modified' | 'created' | 'deleted',
      }));
    } catch (error) {
      logger.error('Error getting file changes:', error);
      return [];
    }
  }
}
