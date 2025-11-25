import { Router, Request, Response } from 'express';
import { UsageStatsService, UsageStatsRequest } from '../services/usageStatsService';
import { GitLabConfigService } from '../services/gitlabConfigService';
import { EventContext } from '../services/storage/eventRepository';
import {
  addRequestId,
  authenticateJWT,
  sendErrorResponse
} from '../middleware/auth';
import logger from '../utils/logger';

const usageStatsRouter = Router();
const usageStatsService = new UsageStatsService();
const gitlabConfigService = new GitLabConfigService();

async function ensureConfigAccess(
  configId: string,
  userId: string,
  requestId: string,
  res: Response
): Promise<boolean> {
  const config = await gitlabConfigService.getConfigById(configId);

  if (!config) {
    sendErrorResponse(res, {
      type: 'NotFound',
      message: 'Configuration not found',
      code: 'CONFIG_NOT_FOUND'
    }, 404, requestId);
    return false;
  }

  if (config.userId !== userId) {
    sendErrorResponse(res, {
      type: 'AuthorizationError',
      message: 'Access denied',
      code: 'INSUFFICIENT_PERMISSIONS'
    }, 403, requestId);
    return false;
  }

  return true;
}

// Apply request ID middleware to all routes
usageStatsRouter.use(addRequestId);

/**
 * GET /usage-stats
 * Get usage statistics for the current user
 */
usageStatsRouter.get('/',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      const queryParams: UsageStatsRequest = {
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
        period: req.query.period as 'day' | 'week' | 'month' | 'year'
      };

      logger.debug('Get usage stats request', {
        requestId,
        userId: user.userId,
        queryParams
      });

      const stats = await usageStatsService.getUserStats(user.userToken, queryParams);

      res.status(200).json({
        success: true,
        data: {
          statistics: stats
        },
        timestamp: new Date().toISOString(),
        requestId
      });

    } catch (error) {
      logger.error('Failed to get usage statistics', {
        requestId,
        userId: user.userId,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to get usage statistics',
        code: 'GET_USAGE_STATS_ERROR'
      }, 500, requestId);
    }
  }
);

/**
 * GET /usage-stats/context/:context
 * Get statistics for a specific context type
 */
usageStatsRouter.get('/context/:context',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;
    const context = req.params.context as EventContext;

    try {
      // Validate context parameter
      const validContexts: EventContext[] = [
        'merge_request',
        'merge_request_comment',
        'issue',
        'issue_comment'
      ];

      if (!validContexts.includes(context)) {
        sendErrorResponse(res, {
          type: 'ValidationError',
          message: `Invalid context. Must be one of: ${validContexts.join(', ')}`,
          code: 'INVALID_CONTEXT'
        }, 400, requestId);
        return;
      }

      const days = parseInt(req.query.days as string) || 30;

      logger.debug('Get context stats request', {
        requestId,
        userId: user.userId,
        context,
        days
      });

      const stats = await usageStatsService.getContextStats(user.userToken, context, days);

      res.status(200).json({
        success: true,
        data: {
          context,
          statistics: stats,
          period: `${days} days`
        },
        timestamp: new Date().toISOString(),
        requestId
      });

    } catch (error) {
      logger.error('Failed to get context statistics', {
        requestId,
        userId: user.userId,
        context,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to get context statistics',
        code: 'GET_CONTEXT_STATS_ERROR'
      }, 500, requestId);
    }
  }
);

/**
 * GET /usage-stats/webhooks
 * Get webhook usage statistics for the current user
 */
usageStatsRouter.get('/webhooks',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      const queryParams: UsageStatsRequest = {
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
        period: req.query.period as 'day' | 'week' | 'month' | 'year'
      };

      logger.debug('Get webhook usage stats request', {
        requestId,
        userId: user.userId,
        queryParams
      });

      const webhookStats = await usageStatsService.getWebhookUsageStats(user.userToken, queryParams);

      res.status(200).json({
        success: true,
        data: {
          webhookStatistics: webhookStats
        },
        timestamp: new Date().toISOString(),
        requestId
      });

    } catch (error) {
      logger.error('Failed to get webhook usage statistics', {
        requestId,
        userId: user.userId,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to get webhook usage statistics',
        code: 'GET_WEBHOOK_STATS_ERROR'
      }, 500, requestId);
    }
  }
);

/**
 * GET /usage-stats/webhook-types
 * Get historical webhook type usage totals for the current user
 */
usageStatsRouter.get('/webhook-types',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      logger.debug('Get webhook type totals request', {
        requestId,
        userId: user.userId
      });

      const webhookTypeTotals = await usageStatsService.getUserWebhookTypeTotals(user.userToken);

      res.status(200).json({
        success: true,
        data: {
          webhookTypeTotals
        },
        timestamp: new Date().toISOString(),
        requestId
      });

    } catch (error) {
      logger.error('Failed to get webhook type totals', {
        requestId,
        userId: user.userId,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to get webhook type totals',
        code: 'GET_WEBHOOK_TYPE_TOTALS_ERROR'
      }, 500, requestId);
    }
  }
);

/**
 * GET /usage-stats/comprehensive
 * Get comprehensive user statistics including regular stats, webhook stats, and webhook type totals
 */
usageStatsRouter.get('/comprehensive',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      const queryParams: UsageStatsRequest = {
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
        period: req.query.period as 'day' | 'week' | 'month' | 'year'
      };

      logger.debug('Get comprehensive stats request', {
        requestId,
        userId: user.userId,
        queryParams
      });

      const comprehensiveStats = await usageStatsService.getComprehensiveUserStats(user.userToken, queryParams);

      res.status(200).json({
        success: true,
        data: comprehensiveStats,
        timestamp: new Date().toISOString(),
        requestId
      });

    } catch (error) {
      logger.error('Failed to get comprehensive statistics', {
        requestId,
        userId: user.userId,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to get comprehensive statistics',
        code: 'GET_COMPREHENSIVE_STATS_ERROR'
      }, 500, requestId);
    }
  }
);

/**
 * GET /usage-stats/summary
 * Get a quick summary of user's usage (enhanced with webhook data)
 */
usageStatsRouter.get('/summary',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      logger.debug('Get usage summary request', {
        requestId,
        userId: user.userId
      });

      // Get comprehensive stats for the last 7 days and 30 days for comparison
      const weekStats = await usageStatsService.getComprehensiveUserStats(user.userToken, { period: 'week' });
      const monthStats = await usageStatsService.getComprehensiveUserStats(user.userToken, { period: 'month' });

      const summary = {
        thisWeek: {
          totalEvents: weekStats.usageStats.totalEvents,
          totalWebhooks: weekStats.webhookStats.totalWebhooks,
          successRate: weekStats.usageStats.totalEvents > 0
            ? Math.round((weekStats.usageStats.successfulEvents / weekStats.usageStats.totalEvents) * 100)
            : 0,
          averageExecutionTime: weekStats.usageStats.averageExecutionTime
        },
        thisMonth: {
          totalEvents: monthStats.usageStats.totalEvents,
          totalWebhooks: monthStats.webhookStats.totalWebhooks,
          successRate: monthStats.usageStats.totalEvents > 0
            ? Math.round((monthStats.usageStats.successfulEvents / monthStats.usageStats.totalEvents) * 100)
            : 0,
          averageExecutionTime: monthStats.usageStats.averageExecutionTime
        },
        topContext: Object.entries(monthStats.usageStats.eventsByContext)
          .sort(([,a], [,b]) => b - a)[0] || ['none', 0],
        topProject: monthStats.usageStats.eventsByProject[0] || { projectName: 'None', count: 0 },
        webhookBreakdown: {
          byType: monthStats.webhookStats.webhooksByType,
          byAction: monthStats.webhookStats.webhooksByAction,
          responseTypes: monthStats.webhookStats.responseTypeStats
        },
        historicalTotals: {
          mostUsedType: Object.entries(monthStats.webhookTypeTotals)
            .sort(([,a], [,b]) => b.total - a.total)[0] || ['none', { total: 0, contextLabel: 'None' }]
        }
      };

      res.status(200).json({
        success: true,
        data: {
          summary
        },
        timestamp: new Date().toISOString(),
        requestId
      });

    } catch (error) {
      logger.error('Failed to get usage summary', {
        requestId,
        userId: user.userId,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to get usage summary',
        code: 'GET_USAGE_SUMMARY_ERROR'
      }, 500, requestId);
    }
  }
);

/**
 * GET /usage-stats/by-config/:configId
 * Get usage statistics for a specific GitLab configuration
 */
usageStatsRouter.get('/by-config/:configId',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;
    const configId = req.params.configId;

    try {
      const queryParams: UsageStatsRequest = {
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
        period: req.query.period as 'day' | 'week' | 'month' | 'year'
      };

      logger.debug('Get config usage stats request', {
        requestId,
        userId: user.userId,
        configId,
        queryParams
      });

      const hasAccess = await ensureConfigAccess(configId, user.userId, requestId, res);
      if (!hasAccess) {
        return;
      }

      const stats = await usageStatsService.getConfigStats(configId, queryParams);

      res.status(200).json({
        success: true,
        data: {
          statistics: stats
        },
        timestamp: new Date().toISOString(),
        requestId
      });

    } catch (error) {
      logger.error('Failed to get config usage statistics', {
        requestId,
        userId: user.userId,
        configId,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to get config usage statistics',
        code: 'GET_CONFIG_USAGE_STATS_ERROR'
      }, 500, requestId);
    }
  }
);

/**
 * GET /usage-stats/by-config/:configId/webhooks
 * Get webhook usage statistics for a specific GitLab configuration
 */
usageStatsRouter.get('/by-config/:configId/webhooks',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;
    const configId = req.params.configId;

    try {
      const queryParams: UsageStatsRequest = {
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
        period: req.query.period as 'day' | 'week' | 'month' | 'year'
      };

      logger.debug('Get config webhook usage stats request', {
        requestId,
        userId: user.userId,
        configId,
        queryParams
      });

      const hasAccess = await ensureConfigAccess(configId, user.userId, requestId, res);
      if (!hasAccess) {
        return;
      }

      const webhookStats = await usageStatsService.getConfigWebhookStats(configId, queryParams);

      res.status(200).json({
        success: true,
        data: {
          webhookStatistics: webhookStats
        },
        timestamp: new Date().toISOString(),
        requestId
      });

    } catch (error) {
      logger.error('Failed to get config webhook usage statistics', {
        requestId,
        userId: user.userId,
        configId,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to get config webhook usage statistics',
        code: 'GET_CONFIG_WEBHOOK_STATS_ERROR'
      }, 500, requestId);
    }
  }
);

/**
 * GET /usage-stats/by-config/:configId/comprehensive
 * Get comprehensive statistics for a specific GitLab configuration
 */
usageStatsRouter.get('/by-config/:configId/comprehensive',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;
    const configId = req.params.configId;

    try {
      const queryParams: UsageStatsRequest = {
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
        period: req.query.period as 'day' | 'week' | 'month' | 'year'
      };

      logger.debug('Get comprehensive config stats request', {
        requestId,
        userId: user.userId,
        configId,
        queryParams
      });

      const hasAccess = await ensureConfigAccess(configId, user.userId, requestId, res);
      if (!hasAccess) {
        return;
      }

      const comprehensiveStats = await usageStatsService.getComprehensiveConfigStats(configId, queryParams);

      res.status(200).json({
        success: true,
        data: comprehensiveStats,
        timestamp: new Date().toISOString(),
        requestId
      });

    } catch (error) {
      logger.error('Failed to get comprehensive config statistics', {
        requestId,
        userId: user.userId,
        configId,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to get comprehensive config statistics',
        code: 'GET_COMPREHENSIVE_CONFIG_STATS_ERROR'
      }, 500, requestId);
    }
  }
);

export default usageStatsRouter;
