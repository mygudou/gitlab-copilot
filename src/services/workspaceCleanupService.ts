import fs from 'fs/promises';
import path from 'path';
import { config } from '../utils/config';
import logger from '../utils/logger';
import { getWorkspaceMetadata, removeWorkspaceMetadata } from './storage/workspaceMetadataRepository';

interface CleanupStats {
  removed: number;
  skipped: number;
  errors: number;
  cleanupDuration: number;
}

export class WorkspaceCleanupService {
  private cleanupTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private cleanupInProgress = false;
  private readonly cleanupInterval: number;
  private readonly maxIdleTime: number;

  constructor(
    private readonly workDir: string = config.workDir,
    options?: { cleanupInterval?: number; maxIdleTime?: number }
  ) {
    this.cleanupInterval = options?.cleanupInterval ?? config.workspace.cleanupInterval;
    this.maxIdleTime = options?.maxIdleTime ?? config.workspace.maxIdleTime;
  }

  public start(): void {
    if (this.isRunning) {
      logger.warn('WorkspaceCleanupService is already running');
      return;
    }

    this.isRunning = true;

    logger.info('Starting WorkspaceCleanupService', {
      workDir: this.workDir,
      cleanupInterval: this.cleanupInterval,
      maxIdleTime: this.maxIdleTime,
    });

    void this.runCleanup();

    this.cleanupTimer = setInterval(() => {
      void this.runCleanup();
    }, this.cleanupInterval);
  }

  public stop(): void {
    if (!this.isRunning) {
      logger.warn('WorkspaceCleanupService is not running');
      return;
    }

    this.isRunning = false;

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    logger.info('WorkspaceCleanupService stopped');
  }

  public isServiceRunning(): boolean {
    return this.isRunning;
  }

  public getStatus(): {
    isRunning: boolean;
    cleanupInterval: number;
    maxIdleTime: number;
    nextCleanup?: Date;
  } {
    if (this.isRunning && this.cleanupTimer) {
      return {
        isRunning: true,
        cleanupInterval: this.cleanupInterval,
        maxIdleTime: this.maxIdleTime,
        nextCleanup: new Date(Date.now() + this.cleanupInterval),
      };
    }

    return {
      isRunning: this.isRunning,
      cleanupInterval: this.cleanupInterval,
      maxIdleTime: this.maxIdleTime,
    };
  }

  public async runManualCleanup(): Promise<CleanupStats> {
    return this.executeCleanup();
  }

  private async runCleanup(): Promise<void> {
    try {
      await this.executeCleanup();
    } catch (error) {
      logger.error('Workspace cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }

  private async executeCleanup(): Promise<CleanupStats> {
    if (this.cleanupInProgress) {
      logger.debug('Workspace cleanup already in progress, skipping execution');
      return {
        removed: 0,
        skipped: 0,
        errors: 0,
        cleanupDuration: 0,
      };
    }

    this.cleanupInProgress = true;

    const startTime = Date.now();
    let removed = 0;
    let skipped = 0;
    let errors = 0;

    try {
      const entries = await fs.readdir(this.workDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const workspacePath = path.join(this.workDir, entry.name);
        const workspaceId = entry.name;

        try {
          const shouldRemove = await this.shouldRemoveWorkspace(workspacePath, workspaceId);

          if (shouldRemove) {
            await fs.rm(workspacePath, { recursive: true, force: true });
            await removeWorkspaceMetadata(workspaceId);
            removed++;

            logger.info('Removed expired workspace', {
              workspace: workspaceId,
              path: workspacePath,
            });
          } else {
            skipped++;
          }
        } catch (error) {
          errors++;
          logger.warn('Failed to evaluate workspace for cleanup', {
            workspace: entry.name,
            path: workspacePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        // Work directory does not exist yet
        skipped = 0;
        removed = 0;
        errors = 0;
      } else {
        errors++;
        throw err;
      }
    } finally {
      this.cleanupInProgress = false;
    }

    const cleanupDuration = Date.now() - startTime;

    logger.info('Workspace cleanup completed', {
      removed,
      skipped,
      errors,
      cleanupDuration,
    });

    return { removed, skipped, errors, cleanupDuration };
  }

  private async shouldRemoveWorkspace(workspacePath: string, workspaceId: string): Promise<boolean> {
    const now = Date.now();
    let lastUsed = NaN;
    const metadata = await getWorkspaceMetadata(workspaceId);

    if (metadata?.lastUsed instanceof Date) {
      lastUsed = metadata.lastUsed.getTime();
    }

    if (Number.isNaN(lastUsed)) {
      try {
        const stats = await fs.stat(workspacePath);
        lastUsed = stats.mtimeMs;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        logger.debug('Failed to read workspace stats', {
          workspacePath,
          error: err.message,
        });
        lastUsed = now;
      }
    }

    const ageMs = now - lastUsed;

    if (ageMs < 0) {
      return false;
    }

    if (ageMs > this.maxIdleTime) {
      logger.debug('Workspace marked for cleanup', {
        workspacePath,
        workspaceId,
        ageMs,
        metadata,
      });
      return true;
    }

    return false;
  }
}
