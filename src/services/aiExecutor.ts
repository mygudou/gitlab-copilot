import { spawn } from 'child_process';
import { config } from '../utils/config';
import logger from '../utils/logger';
import { ProcessResult, FileChange } from '../types/common';
import { ProjectManager } from './projectManager';

export interface AiExecutionContext {
  context: string;
  projectUrl: string;
  branch: string;
  timeoutMs?: number;
  provider?: 'claude' | 'codex';
}

export class AiExecutor {
  private projectManager: ProjectManager;
  private defaultTimeoutMs = 1800000; // 30 minutes

  constructor() {
    this.projectManager = new ProjectManager();
  }

  private resolveProvider(provider?: 'claude' | 'codex'): 'claude' | 'codex' {
    return provider ?? config.ai.executor;
  }

  private getExecutorBinary(provider?: 'claude' | 'codex'): 'claude' | 'codex' {
    return this.resolveProvider(provider);
  }

  private getExecutorName(provider?: 'claude' | 'codex'): string {
    const resolved = this.resolveProvider(provider);
    return resolved === 'codex' ? 'Codex' : 'Claude';
  }

  public async execute(
    command: string,
    projectPath: string,
    context: AiExecutionContext
  ): Promise<ProcessResult> {
    const provider = this.resolveProvider(context.provider);
    const executorName = this.getExecutorName(provider);
    try {
      logger.info(`Executing ${executorName} command`, {
        command: command.substring(0, 100),
        projectPath,
        context: context.context,
      });

      // Check if CLI is available
      await this.checkCliAvailability(provider);

      // Execute command with configured AI CLI
      const result = await this.runCommand(command, projectPath, context, provider);

      // Check for file changes
      const changes = await this.getFileChanges(projectPath);

      return {
        success: true,
        output: result.output,
        changes,
      };
    } catch (error) {
      logger.error(`${executorName} execution failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async checkCliAvailability(provider: 'claude' | 'codex'): Promise<void> {
    return new Promise((resolve, reject) => {
      const binary = this.getExecutorBinary(provider);
      const process = spawn(binary, ['--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let error = '';

      process.stdout?.on('data', data => {
        output += data.toString();
      });

      process.stderr?.on('data', data => {
        error += data.toString();
      });

      process.on('close', code => {
        if (code === 0) {
          logger.debug(`${this.getExecutorName(provider)} CLI is available`, { version: output.trim() });
          resolve();
        } else {
          reject(
            new Error(
              `${this.getExecutorName(provider)} CLI not found or not working: ${error || 'Unknown error'}`
            )
          );
        }
      });

      process.on('error', err => {
        reject(new Error(`Failed to check ${this.getExecutorName(provider)} CLI: ${err.message}`));
      });
    });
  }

  private buildCliArgs(command: string, provider: 'claude' | 'codex'): string[] {
    if (provider === 'codex') {
      // Codex CLI parameters for non-interactive execution
      return [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--color', 'never',
        command
      ];
    }

    return ['--non-interactive', command];
  }

  private buildCliEnv(provider: 'claude' | 'codex'): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
    };

    // Only set Anthropic environment variables when the Claude CLI is in use
    if (provider === 'claude') {
      env.ANTHROPIC_BASE_URL = config.anthropic.baseUrl;

      if (config.anthropic.authToken) {
        env.ANTHROPIC_AUTH_TOKEN = config.anthropic.authToken;
      }
    }

    // Codex uses local authentication from ~/.codex/auth.json
    // No additional environment variables needed

    return env;
  }

  private async runCommand(
    command: string,
    projectPath: string,
    context: AiExecutionContext,
    provider: 'claude' | 'codex'
  ): Promise<{ output: string; error?: string }> {
    return new Promise((resolve, reject) => {
      const env = this.buildCliEnv(provider);
      const cliBinary = this.getExecutorBinary(provider);
      const cliArgs = this.buildCliArgs(command, provider);

      const cliProcess = spawn(cliBinary, cliArgs, {
        cwd: projectPath,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let errorOutput = '';
      // eslint-disable-next-line prefer-const
      let timeoutHandle: NodeJS.Timeout;

      // Set timeout
      const timeoutMs = context.timeoutMs || this.defaultTimeoutMs;
      // eslint-disable-next-line prefer-const
      timeoutHandle = setTimeout(() => {
        cliProcess.kill('SIGTERM');
        reject(new Error(`${this.getExecutorName(provider)} execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      cliProcess.stdout?.on('data', data => {
        output += data.toString();
      });

      cliProcess.stderr?.on('data', data => {
        errorOutput += data.toString();
      });

      cliProcess.on('close', code => {
        clearTimeout(timeoutHandle);

        if (code === 0) {
          logger.info(`${this.getExecutorName(provider)} command executed successfully`, {
            outputLength: output.length,
            projectPath,
          });
          resolve({ output: output.trim() });
        } else {
          logger.warn(`${this.getExecutorName(provider)} command failed with non-zero exit code`, {
            code,
            error: errorOutput,
            projectPath,
          });
          reject(
            new Error(
              `${this.getExecutorName(provider)} execution failed (code ${code}): ${
                errorOutput || 'No error output'
              }`
            )
          );
        }
      });

      cliProcess.on('error', err => {
        clearTimeout(timeoutHandle);
        reject(new Error(`Failed to execute ${this.getExecutorName(provider)}: ${err.message}`));
      });

      // Provide context to claude if needed
      if (context.context) {
        const contextMessage = `Context: ${context.context}\\nProject: ${context.projectUrl}\\nBranch: ${context.branch}\\n\\n`;
        cliProcess.stdin?.write(contextMessage);
      }

      cliProcess.stdin?.end();
    });
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

  public async executeWithCommit(
    command: string,
    projectPath: string,
    context: AiExecutionContext,
    commitMessage?: string
  ): Promise<ProcessResult> {
    const provider = this.resolveProvider(context.provider);
    const result = await this.execute(command, projectPath, { ...context, provider });

    if (result.success && result.changes && result.changes.length > 0) {
      try {
        const executorName = this.getExecutorName(provider);
        const message =
          commitMessage ||
          `${executorName}: ${command.substring(0, 50)}${command.length > 50 ? '...' : ''}`;

        await this.projectManager.commitAndPush(projectPath, message, context.branch);

        logger.info('Changes committed and pushed', {
          changesCount: result.changes.length,
          branch: context.branch,
        });
      } catch (error) {
        logger.error('Failed to commit and push changes:', error);
        result.error = `Execution successful but failed to push changes: ${
          error instanceof Error ? error.message : String(error)
        }`;
        result.success = false;
      }
    }

    return result;
  }
}
