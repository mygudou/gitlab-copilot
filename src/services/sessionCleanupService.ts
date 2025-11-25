import { SessionManager } from './sessionManager';
import { config } from '../utils/config';
import logger from '../utils/logger';

/**
 * Session cleanup service that periodically removes expired sessions
 */
export class SessionCleanupService {
  private sessionManager: SessionManager;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  /**
   * Start the cleanup service
   */
  public start(): void {
    if (this.isRunning) {
      logger.warn('SessionCleanupService is already running');
      return;
    }

    if (!config.session.enabled) {
      logger.info('Session cleanup disabled - sessions are disabled');
      return;
    }

    this.isRunning = true;

    logger.info('Starting SessionCleanupService', {
      cleanupInterval: config.session.cleanupInterval,
      maxIdleTime: config.session.maxIdleTime,
    });

    // Run initial cleanup
    this.runCleanup();

    // Schedule periodic cleanup
    this.cleanupTimer = setInterval(() => {
      this.runCleanup();
    }, config.session.cleanupInterval);

    logger.info('SessionCleanupService started successfully');
  }

  /**
   * Stop the cleanup service
   */
  public stop(): void {
    if (!this.isRunning) {
      logger.warn('SessionCleanupService is not running');
      return;
    }

    this.isRunning = false;

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    logger.info('SessionCleanupService stopped');
  }

  /**
   * Run cleanup manually (for testing or manual maintenance)
   */
  public async runManualCleanup(): Promise<{
    expiredSessions: number;
    totalSessions: number;
    cleanupDuration: number;
  }> {
    const startTime = Date.now();
    const stats = this.sessionManager.getStats();
    const expiredSessions = this.sessionManager.cleanExpiredSessions();
    const finalStats = this.sessionManager.getStats();
    const cleanupDuration = Date.now() - startTime;

    logger.info('Manual session cleanup completed', {
      expiredSessions,
      totalSessionsBefore: stats.totalSessions,
      totalSessionsAfter: finalStats.totalSessions,
      cleanupDuration,
    });

    return {
      expiredSessions,
      totalSessions: finalStats.totalSessions,
      cleanupDuration,
    };
  }

  /**
   * Get cleanup service status
   */
  public getStatus(): {
    isRunning: boolean;
    cleanupInterval: number;
    maxIdleTime: number;
    nextCleanup?: Date;
  } {
    const status = {
      isRunning: this.isRunning,
      cleanupInterval: config.session.cleanupInterval,
      maxIdleTime: config.session.maxIdleTime,
    };

    // Estimate next cleanup time if running
    if (this.isRunning && this.cleanupTimer) {
      return {
        ...status,
        nextCleanup: new Date(Date.now() + config.session.cleanupInterval),
      };
    }

    return status;
  }

  /**
   * Check if the service is running
   */
  public isServiceRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Perform the actual cleanup
   */
  private runCleanup(): void {
    try {
      const startTime = Date.now();
      const sessionStats = this.sessionManager.getStats();

      logger.debug('Starting periodic session cleanup', {
        totalSessions: sessionStats.totalSessions,
        activeSessions: sessionStats.activeSessions,
        expiredSessions: sessionStats.expiredSessions,
      });

      const cleanedCount = this.sessionManager.cleanExpiredSessions();
      const endTime = Date.now();
      const duration = endTime - startTime;

      const finalStats = this.sessionManager.getStats();

      logger.info('Periodic session cleanup completed', {
        cleanedSessions: cleanedCount,
        remainingSessions: finalStats.totalSessions,
        cleanupDuration: duration,
        memoryUsage: process.memoryUsage().heapUsed,
      });

      // Log warning if cleanup took too long
      if (duration > 5000) { // More than 5 seconds
        logger.warn('Session cleanup took longer than expected', {
          duration,
          sessionsBefore: sessionStats.totalSessions,
          cleanedSessions: cleanedCount,
        });
      }

      // Log warning if too many sessions remain
      const maxSessionsWarningThreshold = Math.floor(config.session.maxSessions * 0.8);
      if (finalStats.totalSessions > maxSessionsWarningThreshold) {
        logger.warn('High session count detected', {
          currentSessions: finalStats.totalSessions,
          maxSessions: config.session.maxSessions,
          warningThreshold: maxSessionsWarningThreshold,
        });
      }

    } catch (error) {
      logger.error('Error during session cleanup', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}