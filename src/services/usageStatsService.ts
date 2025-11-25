import {
  getUserUsageStats,
  getUserWebhookTypeTotals,
  getWebhookUsageStats,
  getConfigUsageStats,
  getConfigWebhookUsageStats,
  UsageStats,
  EventContext,
  WebhookUsageStats
} from './storage/eventRepository';
import { findUserByToken } from './storage/userRepository';
import { getConfigById } from './storage/gitlabConfigRepository';
import logger from '../utils/logger';

export interface UsageStatsRequest {
  startDate?: string;
  endDate?: string;
  period?: 'day' | 'week' | 'month' | 'year';
}

export interface DetailedUsageStats extends UsageStats {
  period: {
    startDate: string;
    endDate: string;
    period: string;
  };
  contextLabels: Record<EventContext, string>;
  trends: {
    dailyAverage: number;
    weeklyAverage: number;
    growthRate: number;
  };
}

export class UsageStatsService {
  private contextLabels: Record<EventContext, string> = {
    'merge_request': 'Merge Request (includes Code Review)',
    'merge_request_comment': 'MR Comment',
    'issue': 'Issue',
    'issue_comment': 'Issue Comment'
  };

  async getUserStats(userToken: string, request: UsageStatsRequest = {}): Promise<DetailedUsageStats> {
    try {
      // Validate user exists
      const user = await findUserByToken(userToken);
      if (!user) {
        throw new Error('User not found');
      }

      // Parse date range
      const { startDate, endDate } = this.parseDateRange(request);

      // Get raw stats
      const rawStats = await getUserUsageStats(userToken, startDate, endDate);

      // Calculate trends
      const trends = this.calculateTrends(rawStats.dailyStats, startDate, endDate);

      // Format response
      const detailedStats: DetailedUsageStats = {
        ...rawStats,
        period: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          period: request.period || 'month'
        },
        contextLabels: this.contextLabels,
        trends
      };

      logger.info('Usage stats retrieved', {
        userToken,
        totalEvents: rawStats.totalEvents,
        period: request.period || 'month'
      });

      return detailedStats;

    } catch (error) {
      logger.error('Failed to get user usage stats', {
        userToken,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async getAllUsersStats(): Promise<{
    totalUsers: number;
    totalEvents: number;
    topUsers: { userToken: string; eventCount: number }[];
    systemStats: UsageStats;
  }> {
    // This would require additional aggregation queries
    // Implementation depends on admin requirements
    throw new Error('Admin stats not implemented yet');
  }

  private parseDateRange(request: UsageStatsRequest): { startDate: Date; endDate: Date } {
    const now = new Date();
    let startDate: Date;
    let endDate = new Date(now);

    if (request.startDate && request.endDate) {
      startDate = new Date(request.startDate);
      endDate = new Date(request.endDate);
    } else {
      switch (request.period) {
        case 'day':
          startDate = new Date(now.getTime() - (24 * 60 * 60 * 1000));
          break;
        case 'week':
          startDate = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
          break;
        case 'year':
          startDate = new Date(now.getTime() - (365 * 24 * 60 * 60 * 1000));
          break;
        case 'month':
        default:
          startDate = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
          break;
      }
    }

    return { startDate, endDate };
  }

  private calculateTrends(
    dailyStats: { date: string; count: number }[],
    startDate: Date,
    endDate: Date
  ): { dailyAverage: number; weeklyAverage: number; growthRate: number } {
    const totalDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
    const totalEvents = dailyStats.reduce((sum, day) => sum + day.count, 0);

    const dailyAverage = totalDays > 0 ? Math.round((totalEvents / totalDays) * 100) / 100 : 0;
    const weeklyAverage = Math.round(dailyAverage * 7 * 100) / 100;

    // Calculate growth rate (comparing first half vs second half)
    let growthRate = 0;
    if (dailyStats.length >= 7) {
      const halfPoint = Math.floor(dailyStats.length / 2);
      const firstHalf = dailyStats.slice(0, halfPoint);
      const secondHalf = dailyStats.slice(halfPoint);

      const firstHalfAvg = firstHalf.reduce((sum, day) => sum + day.count, 0) / firstHalf.length;
      const secondHalfAvg = secondHalf.reduce((sum, day) => sum + day.count, 0) / secondHalf.length;

      if (firstHalfAvg > 0) {
        growthRate = Math.round(((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100 * 100) / 100;
      }
    }

    return {
      dailyAverage,
      weeklyAverage,
      growthRate
    };
  }

  // Helper method to get context statistics for a specific context type
  async getContextStats(userToken: string, context: EventContext, days: number = 30): Promise<{
    count: number;
    percentage: number;
    trend: 'up' | 'down' | 'stable';
  }> {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - (days * 24 * 60 * 60 * 1000));

    const stats = await getUserUsageStats(userToken, startDate, endDate);
    const contextCount = stats.eventsByContext[context] || 0;
    const percentage = stats.totalEvents > 0 ? Math.round((contextCount / stats.totalEvents) * 100) : 0;

    // For trend calculation, we'd need to compare with previous period
    // This is a simplified version
    const trend: 'up' | 'down' | 'stable' = 'stable';

    return {
      count: contextCount,
      percentage,
      trend
    };
  }

  /**
   * Get webhook usage statistics for a user or all users
   */
  async getWebhookUsageStats(
    userToken?: string,
    request: UsageStatsRequest = {}
  ): Promise<WebhookUsageStats & { period: { startDate: string; endDate: string; period: string } }> {
    try {
      if (userToken) {
        // Validate user exists
        const user = await findUserByToken(userToken);
        if (!user) {
          throw new Error('User not found');
        }
      }

      // Parse date range
      const { startDate, endDate } = this.parseDateRange(request);

      // Get webhook stats (excluding progress responses by default)
      const webhookStats = await getWebhookUsageStats(userToken, startDate, endDate, true);

      logger.info('Webhook usage stats retrieved', {
        userToken: userToken || 'all',
        totalWebhooks: webhookStats.totalWebhooks,
        period: request.period || 'month'
      });

      return {
        ...webhookStats,
        period: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          period: request.period || 'month'
        }
      };

    } catch (error) {
      logger.error('Failed to get webhook usage stats', {
        userToken,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get historical webhook type usage totals for a specific user
   */
  async getUserWebhookTypeTotals(userToken: string): Promise<Record<EventContext, { 
    total: number; 
    thisMonth: number; 
    lastMonth: number;
    contextLabel: string;
  }>> {
    try {
      // Validate user exists
      const user = await findUserByToken(userToken);
      if (!user) {
        throw new Error('User not found');
      }

      // Get webhook type totals (excluding progress responses)
      const typeTotals = await getUserWebhookTypeTotals(userToken, true);

      // Add context labels to the results
      const enhancedTotals: Record<EventContext, { 
        total: number; 
        thisMonth: number; 
        lastMonth: number;
        contextLabel: string;
      }> = {} as any;

      for (const [context, stats] of Object.entries(typeTotals)) {
        enhancedTotals[context as EventContext] = {
          ...stats,
          contextLabel: this.contextLabels[context as EventContext]
        };
      }

      logger.info('User webhook type totals retrieved', {
        userToken,
        totalCount: Object.values(typeTotals).reduce((sum, stats) => sum + stats.total, 0)
      });

      return enhancedTotals;

    } catch (error) {
      logger.error('Failed to get user webhook type totals', {
        userToken,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get comprehensive user statistics including both regular stats and webhook totals
   */
  async getComprehensiveUserStats(userToken: string, request: UsageStatsRequest = {}): Promise<{
    usageStats: DetailedUsageStats;
    webhookStats: WebhookUsageStats & { period: { startDate: string; endDate: string; period: string } };
    webhookTypeTotals: Record<EventContext, {
      total: number;
      thisMonth: number;
      lastMonth: number;
      contextLabel: string;
    }>;
  }> {
    try {
      // Get all stats in parallel
      const [usageStats, webhookStats, webhookTypeTotals] = await Promise.all([
        this.getUserStats(userToken, request),
        this.getWebhookUsageStats(userToken, request),
        this.getUserWebhookTypeTotals(userToken)
      ]);

      logger.info('Comprehensive user stats retrieved', {
        userToken,
        totalEvents: usageStats.totalEvents,
        totalWebhooks: webhookStats.totalWebhooks
      });

      return {
        usageStats,
        webhookStats,
        webhookTypeTotals
      };

    } catch (error) {
      logger.error('Failed to get comprehensive user stats', {
        userToken,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get usage statistics by GitLab configuration ID
   */
  async getConfigStats(gitlabConfigId: string, request: UsageStatsRequest = {}): Promise<DetailedUsageStats> {
    try {
      // Validate config exists
      const config = await getConfigById(gitlabConfigId);
      if (!config) {
        throw new Error('GitLab configuration not found');
      }

      // Parse date range
      const { startDate, endDate } = this.parseDateRange(request);

      // Get raw stats
      const rawStats = await getConfigUsageStats(gitlabConfigId, startDate, endDate);

      // Calculate trends
      const trends = this.calculateTrends(rawStats.dailyStats, startDate, endDate);

      // Format response
      const detailedStats: DetailedUsageStats = {
        ...rawStats,
        period: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          period: request.period || 'month'
        },
        contextLabels: this.contextLabels,
        trends
      };

      logger.info('Config usage stats retrieved', {
        gitlabConfigId,
        totalEvents: rawStats.totalEvents,
        period: request.period || 'month'
      });

      return detailedStats;

    } catch (error) {
      logger.error('Failed to get config usage stats', {
        gitlabConfigId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get webhook usage statistics by GitLab configuration ID
   */
  async getConfigWebhookStats(
    gitlabConfigId: string,
    request: UsageStatsRequest = {}
  ): Promise<WebhookUsageStats & { period: { startDate: string; endDate: string; period: string } }> {
    try {
      // Validate config exists
      const config = await getConfigById(gitlabConfigId);
      if (!config) {
        throw new Error('GitLab configuration not found');
      }

      // Parse date range
      const { startDate, endDate } = this.parseDateRange(request);

      // Get webhook stats (excluding progress responses by default)
      const webhookStats = await getConfigWebhookUsageStats(gitlabConfigId, startDate, endDate, true);

      logger.info('Config webhook usage stats retrieved', {
        gitlabConfigId,
        totalWebhooks: webhookStats.totalWebhooks,
        period: request.period || 'month'
      });

      return {
        ...webhookStats,
        period: {
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          period: request.period || 'month'
        }
      };

    } catch (error) {
      logger.error('Failed to get config webhook usage stats', {
        gitlabConfigId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Get comprehensive statistics by GitLab configuration ID
   */
  async getComprehensiveConfigStats(gitlabConfigId: string, request: UsageStatsRequest = {}): Promise<{
    usageStats: DetailedUsageStats;
    webhookStats: WebhookUsageStats & { period: { startDate: string; endDate: string; period: string } };
    configInfo: {
      id: string;
      name: string;
      gitlabUrl: string;
    };
  }> {
    try {
      // Validate config exists and get its info
      const config = await getConfigById(gitlabConfigId);
      if (!config) {
        throw new Error('GitLab configuration not found');
      }

      // Get all stats in parallel
      const [usageStats, webhookStats] = await Promise.all([
        this.getConfigStats(gitlabConfigId, request),
        this.getConfigWebhookStats(gitlabConfigId, request)
      ]);

      logger.info('Comprehensive config stats retrieved', {
        gitlabConfigId,
        totalEvents: usageStats.totalEvents,
        totalWebhooks: webhookStats.totalWebhooks
      });

      return {
        usageStats,
        webhookStats,
        configInfo: {
          id: config.id,
          name: config.name,
          gitlabUrl: config.gitlabUrl
        }
      };

    } catch (error) {
      logger.error('Failed to get comprehensive config stats', {
        gitlabConfigId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}
