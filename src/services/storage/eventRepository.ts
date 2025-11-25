import type { Collection } from 'mongodb';
import { getMongoDb } from './mongoClient';
import { config } from '../../utils/config';
import logger from '../../utils/logger';

export type WebhookEventStatus = 'received' | 'processed' | 'error';

export type EventContext =
  | 'merge_request'           // MR description (includes code review functionality)
  | 'merge_request_comment'   // MR comment
  | 'issue'                   // Issue description
  | 'issue_comment';          // Issue comment

export interface WebhookEventRecord {
  _id?: unknown;
  userId?: string;
  userToken?: string;
  gitlabConfigId?: string;   // GitLab configuration ID for multi-config support
  projectId?: number;
  projectName?: string;
  eventType?: string;
  eventContext?: EventContext;
  contextId?: number;        // Issue IID or MR IID
  contextTitle?: string;     // Issue/MR title for reference
  instructionText?: string;  // The @claude instruction that was processed
  aiProvider?: 'claude' | 'codex';
  status: WebhookEventStatus;
  payload: unknown;
  errorMessage?: string;
  receivedAt: Date;
  processedAt?: Date;
  executionTimeMs?: number;  // Time taken to process

  // Enhanced background fields
  note?: string;             // Background information about the context
  isProgressResponse?: boolean; // Whether this is a progress update response
  responseType?: 'instruction' | 'progress' | 'final' | 'error'; // Type of AI response
  webhookAction?: string;    // Original webhook action (open, close, update, etc.)
  sourceBranch?: string;     // For MR events
  targetBranch?: string;     // For MR events
  authorUsername?: string;   // Username of the person who triggered the event
  authorEmail?: string;      // Email of the person who triggered the event
}

const COLLECTION_NAME = 'events';

async function getEventsCollection(): Promise<Collection<WebhookEventRecord>> {
  const db = await getMongoDb();
  return db.collection<WebhookEventRecord>(COLLECTION_NAME);
}

function buildConfigIdMatch(configId: string): Record<string, unknown> {
  return {
    $or: [
      { gitlabConfigId: configId },
      {
        $and: [
          { $or: [{ gitlabConfigId: { $exists: false } }, { gitlabConfigId: null }] },
          { userId: configId }
        ]
      }
    ]
  };
}

export async function recordWebhookEvent(record: WebhookEventRecord): Promise<unknown | null> {
  if (!config.platform.hasMongoCredentials) {
    return null;
  }

  try {
    const collection = await getEventsCollection();
    const result = await collection.insertOne({
      ...record,
      receivedAt: record.receivedAt ?? new Date(),
    });
    return result.insertedId ?? null;
  } catch (error) {
    logger.error('Failed to record webhook event', {
      userId: record.userId,
      eventType: record.eventType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

export async function markWebhookEventProcessed(id: unknown, status: WebhookEventStatus, errorMessage?: string): Promise<void> {
  if (!config.platform.hasMongoCredentials) {
    return;
  }

  try {
    const collection = await getEventsCollection();
    await collection.updateOne(
      { _id: id },
      {
        $set: {
          status,
          errorMessage,
          processedAt: new Date(),
        },
      }
    );
  } catch (error) {
    logger.error('Failed to update webhook event status', {
      id,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function updateWebhookEventDetails(
  id: unknown,
  updates: {
    eventContext?: EventContext;
    contextId?: number;
    contextTitle?: string;
    instructionText?: string;
    aiProvider?: 'claude' | 'codex';
    executionTimeMs?: number;
    note?: string;
    isProgressResponse?: boolean;
    responseType?: 'instruction' | 'progress' | 'final' | 'error';
    webhookAction?: string;
    sourceBranch?: string;
    targetBranch?: string;
    authorUsername?: string;
    authorEmail?: string;
    gitlabConfigId?: string;
  }
): Promise<void> {
  if (!config.platform.hasMongoCredentials) {
    return;
  }

  try {
    const collection = await getEventsCollection();
    await collection.updateOne(
      { _id: id },
      { $set: updates }
    );
  } catch (error) {
    logger.error('Failed to update webhook event details', {
      id,
      updates,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface ProjectDetailStats {
  projectId: number;
  projectName: string;
  totalEvents: number;
  successfulEvents: number;
  failedEvents: number;
  averageExecutionTime: number;
  successRate: number;
}

export interface ProviderContextStats {
  provider: string;
  contexts: Record<EventContext, number>;
  totalEvents: number;
}

export interface UsageStats {
  totalEvents: number;
  successfulEvents: number;
  failedEvents: number;
  eventsByContext: Record<EventContext, number>;
  eventsByProject: { projectId: number; projectName: string; count: number }[];
  projectDetails?: ProjectDetailStats[];
  providerContextStats?: ProviderContextStats[];
  dailyStats: { date: string; count: number }[];
  averageExecutionTime: number;
  providerStats: Record<string, number>;
}

export async function getUserUsageStats(
  userToken: string,
  startDate?: Date,
  endDate?: Date
): Promise<UsageStats> {
  if (!config.platform.hasMongoCredentials) {
    return {
      totalEvents: 0,
      successfulEvents: 0,
      failedEvents: 0,
      eventsByContext: {} as Record<EventContext, number>,
      eventsByProject: [],
      dailyStats: [],
      averageExecutionTime: 0,
      providerStats: {},
    };
  }

  try {
    const collection = await getEventsCollection();
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));

    const matchQuery: any = {
      userToken,
      receivedAt: {
        $gte: startDate || thirtyDaysAgo,
        $lte: endDate || now
      },
      responseType: 'instruction',
      // Filter out progress responses to only count actual AI instruction responses
      $or: [
        { isProgressResponse: { $ne: true } },
        { isProgressResponse: { $exists: false } }
      ]
    };

    const pipeline = [
      { $match: matchQuery },
      {
        $facet: {
          // Total counts
          totalCounts: [
            {
              $group: {
                _id: null,
                totalEvents: { $sum: 1 },
                successfulEvents: { $sum: { $cond: [{ $eq: ['$status', 'processed'] }, 1, 0] } },
                failedEvents: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
                totalExecutionTime: { $sum: { $ifNull: ['$executionTimeMs', 0] } }
              }
            }
          ],
          // Events by context
          contextStats: [
            {
              $group: {
                _id: '$eventContext',
                count: { $sum: 1 }
              }
            }
          ],
          // Events by project
          projectStats: [
            {
              $group: {
                _id: { projectId: '$projectId', projectName: '$projectName' },
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ],
          // Daily stats
          dailyStats: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$receivedAt' } },
                count: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } }
          ],
          // Provider stats
          providerStats: [
            {
              $group: {
                _id: '$aiProvider',
                count: { $sum: 1 }
              }
            }
          ],
          // Project details with success rate and execution time
          projectDetails: [
            {
              $group: {
                _id: { projectId: '$projectId', projectName: '$projectName' },
                totalEvents: { $sum: 1 },
                successfulEvents: { $sum: { $cond: [{ $eq: ['$status', 'processed'] }, 1, 0] } },
                failedEvents: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
                totalExecutionTime: { $sum: { $ifNull: ['$executionTimeMs', 0] } }
              }
            },
            { $sort: { totalEvents: -1 } },
            { $limit: 20 }
          ],
          // Provider context stats
          providerContextStats: [
            {
              $group: {
                _id: { provider: '$aiProvider', context: '$eventContext' },
                count: { $sum: 1 }
              }
            }
          ]
        }
      }
    ];

    const [result] = await (collection as any).aggregate(pipeline).toArray();

    const totalCounts = result.totalCounts[0] || { totalEvents: 0, successfulEvents: 0, failedEvents: 0, totalExecutionTime: 0 };

    const eventsByContext: Record<EventContext, number> = {
      merge_request: 0,
      merge_request_comment: 0,
      issue: 0,
      issue_comment: 0,
    };
    for (const item of result.contextStats) {
      if (item._id) {
        eventsByContext[item._id as EventContext] = item.count;
      }
    }

    const eventsByProject = result.projectStats.map((item: any) => ({
      projectId: item._id.projectId,
      projectName: item._id.projectName || `Project ${item._id.projectId}`,
      count: item.count
    }));

    const dailyStats = result.dailyStats.map((item: any) => ({
      date: item._id,
      count: item.count
    }));

    const providerStats: Record<string, number> = {};
    for (const item of result.providerStats) {
      if (item._id) {
        providerStats[item._id] = item.count;
      }
    }

    const averageExecutionTime = totalCounts.totalEvents > 0
      ? Math.round(totalCounts.totalExecutionTime / totalCounts.totalEvents)
      : 0;

    // Process project details
    const projectDetails: ProjectDetailStats[] = result.projectDetails.map((item: any) => {
      const totalEvents = item.totalEvents || 0;
      const avgTime = totalEvents > 0 ? Math.round(item.totalExecutionTime / totalEvents) : 0;
      const successRate = totalEvents > 0 ? Math.round((item.successfulEvents / totalEvents) * 100) : 0;

      return {
        projectId: item._id.projectId,
        projectName: item._id.projectName || `Project ${item._id.projectId}`,
        totalEvents,
        successfulEvents: item.successfulEvents || 0,
        failedEvents: item.failedEvents || 0,
        averageExecutionTime: avgTime,
        successRate
      };
    });

    // Process provider context stats
    const providerContextMap = new Map<string, Record<EventContext, number>>();
    for (const item of result.providerContextStats) {
      const provider = item._id.provider || 'unknown';
      const context = item._id.context as EventContext;

      if (!providerContextMap.has(provider)) {
        providerContextMap.set(provider, {
          merge_request: 0,
          merge_request_comment: 0,
          issue: 0,
          issue_comment: 0
        });
      }

      const contexts = providerContextMap.get(provider)!;
      if (context) {
        contexts[context] = item.count;
      }
    }

    const providerContextStats: ProviderContextStats[] = Array.from(providerContextMap.entries()).map(([provider, contexts]) => ({
      provider,
      contexts,
      totalEvents: Object.values(contexts).reduce((sum, count) => sum + count, 0)
    }));

    return {
      totalEvents: totalCounts.totalEvents,
      successfulEvents: totalCounts.successfulEvents,
      failedEvents: totalCounts.failedEvents,
      eventsByContext,
      eventsByProject,
      projectDetails,
      providerContextStats,
      dailyStats,
      averageExecutionTime,
      providerStats,
    };

  } catch (error) {
    logger.error('Failed to get user usage stats', {
      userToken,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export interface WebhookUsageStats {
  totalWebhooks: number;
  processedWebhooks: number;
  failedWebhooks: number;
  webhooksByType: Record<string, number>;
  webhooksByAction: Record<string, number>;
  webhooksByContext: Record<EventContext, number>;
  dailyWebhookStats: { date: string; count: number }[];
  topUsers: { userToken: string; count: number }[];
  responseTypeStats: Record<string, number>;
}

/**
 * Get comprehensive webhook usage statistics for all users or filtered by user token
 */
export async function getWebhookUsageStats(
  userToken?: string,
  startDate?: Date,
  endDate?: Date,
  excludeProgressResponses: boolean = true
): Promise<WebhookUsageStats> {
  if (!config.platform.hasMongoCredentials) {
    return {
      totalWebhooks: 0,
      processedWebhooks: 0,
      failedWebhooks: 0,
      webhooksByType: {},
      webhooksByAction: {},
      webhooksByContext: {
        merge_request: 0,
        merge_request_comment: 0,
        issue: 0,
        issue_comment: 0,
      },
      dailyWebhookStats: [],
      topUsers: [],
      responseTypeStats: {},
    };
  }

  try {
    const collection = await getEventsCollection();
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));

    const matchQuery: any = {
      receivedAt: {
        $gte: startDate || thirtyDaysAgo,
        $lte: endDate || now
      }
    };

    if (userToken) {
      matchQuery.userToken = userToken;
    }

    if (excludeProgressResponses) {
      matchQuery.$or = [
        { isProgressResponse: { $ne: true } },
        { isProgressResponse: { $exists: false } }
      ];
    }

    const pipeline = [
      { $match: matchQuery },
      {
        $facet: {
          // Total count and status counts
          totalCount: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                processed: { $sum: { $cond: [{ $eq: ['$status', 'processed'] }, 1, 0] } },
                failed: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } }
              }
            }
          ],
          // Webhooks by event type
          typeStats: [
            {
              $group: {
                _id: '$eventType',
                count: { $sum: 1 }
              }
            }
          ],
          // Webhooks by webhook action
          actionStats: [
            {
              $group: {
                _id: '$webhookAction',
                count: { $sum: 1 }
              }
            }
          ],
          // Webhooks by context
          contextStats: [
            {
              $group: {
                _id: '$eventContext',
                count: { $sum: 1 }
              }
            }
          ],
          // Daily webhook stats
          dailyStats: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$receivedAt' } },
                count: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } }
          ],
          // Top users (only if not filtering by specific user)
          ...(userToken ? {} : {
            topUsers: [
              {
                $group: {
                  _id: '$userToken',
                  count: { $sum: 1 }
                }
              },
              { $sort: { count: -1 } },
              { $limit: 10 }
            ]
          }),
          // Response type stats
          responseTypeStats: [
            {
              $group: {
                _id: '$responseType',
                count: { $sum: 1 }
              }
            }
          ]
        }
      }
    ];

    const [result] = await (collection as any).aggregate(pipeline).toArray();

    const statusCounts = result.totalCount[0] || { total: 0, processed: 0, failed: 0 };
    const totalWebhooks = statusCounts.total;
    const processedWebhooks = statusCounts.processed;
    const failedWebhooks = statusCounts.failed;

    const webhooksByType: Record<string, number> = {};
    for (const item of result.typeStats) {
      if (item._id) {
        webhooksByType[item._id] = item.count;
      }
    }

    const webhooksByAction: Record<string, number> = {};
    for (const item of result.actionStats) {
      if (item._id) {
        webhooksByAction[item._id] = item.count;
      }
    }

    const webhooksByContext: Record<EventContext, number> = {
      merge_request: 0,
      merge_request_comment: 0,
      issue: 0,
      issue_comment: 0,
    };
    for (const item of result.contextStats) {
      if (item._id) {
        webhooksByContext[item._id as EventContext] = item.count;
      }
    }

    const dailyWebhookStats = result.dailyStats.map((item: any) => ({
      date: item._id,
      count: item.count
    }));

    const topUsers = userToken ? [] : result.topUsers?.map((item: any) => ({
      userToken: item._id,
      count: item.count
    })) || [];

    const responseTypeStats: Record<string, number> = {};
    for (const item of result.responseTypeStats) {
      if (item._id) {
        responseTypeStats[item._id] = item.count;
      }
    }

    return {
      totalWebhooks,
      processedWebhooks,
      failedWebhooks,
      webhooksByType,
      webhooksByAction,
      webhooksByContext,
      dailyWebhookStats,
      topUsers,
      responseTypeStats,
    };

  } catch (error) {
    logger.error('Failed to get webhook usage stats', {
      userToken,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Get usage statistics by GitLab configuration ID
 */
export async function getConfigUsageStats(
  gitlabConfigId: string,
  startDate?: Date,
  endDate?: Date
): Promise<UsageStats> {
  if (!config.platform.hasMongoCredentials) {
    return {
      totalEvents: 0,
      successfulEvents: 0,
      failedEvents: 0,
      eventsByContext: {} as Record<EventContext, number>,
      eventsByProject: [],
      dailyStats: [],
      averageExecutionTime: 0,
      providerStats: {},
    };
  }

  try {
    const collection = await getEventsCollection();
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));

    const matchConditions: any[] = [
      buildConfigIdMatch(gitlabConfigId),
      {
        receivedAt: {
          $gte: startDate || thirtyDaysAgo,
          $lte: endDate || now
        }
      },
      { responseType: 'instruction' }
    ];

    matchConditions.push({
      $or: [
        { isProgressResponse: { $ne: true } },
        { isProgressResponse: { $exists: false } }
      ]
    });

    const pipeline = [
      { $match: { $and: matchConditions } },
      {
        $facet: {
          // Total counts
          totalCounts: [
            {
              $group: {
                _id: null,
                totalEvents: { $sum: 1 },
                successfulEvents: { $sum: { $cond: [{ $eq: ['$status', 'processed'] }, 1, 0] } },
                failedEvents: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
                totalExecutionTime: { $sum: { $ifNull: ['$executionTimeMs', 0] } }
              }
            }
          ],
          // Events by context
          contextStats: [
            {
              $group: {
                _id: '$eventContext',
                count: { $sum: 1 }
              }
            }
          ],
          // Events by project
          projectStats: [
            {
              $group: {
                _id: { projectId: '$projectId', projectName: '$projectName' },
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ],
          // Daily stats
          dailyStats: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$receivedAt' } },
                count: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } }
          ],
          // Provider stats
          providerStats: [
            {
              $group: {
                _id: '$aiProvider',
                count: { $sum: 1 }
              }
            }
          ],
          // Project details with success rate and execution time
          projectDetails: [
            {
              $group: {
                _id: { projectId: '$projectId', projectName: '$projectName' },
                totalEvents: { $sum: 1 },
                successfulEvents: { $sum: { $cond: [{ $eq: ['$status', 'processed'] }, 1, 0] } },
                failedEvents: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
                totalExecutionTime: { $sum: { $ifNull: ['$executionTimeMs', 0] } }
              }
            },
            { $sort: { totalEvents: -1 } },
            { $limit: 20 }
          ],
          // Provider context stats
          providerContextStats: [
            {
              $group: {
                _id: { provider: '$aiProvider', context: '$eventContext' },
                count: { $sum: 1 }
              }
            }
          ]
        }
      }
    ];

    const [result] = await (collection as any).aggregate(pipeline).toArray();

    const totalCounts = result.totalCounts[0] || { totalEvents: 0, successfulEvents: 0, failedEvents: 0, totalExecutionTime: 0 };

    const eventsByContext: Record<EventContext, number> = {
      merge_request: 0,
      merge_request_comment: 0,
      issue: 0,
      issue_comment: 0,
    };
    for (const item of result.contextStats) {
      if (item._id) {
        eventsByContext[item._id as EventContext] = item.count;
      }
    }

    const eventsByProject = result.projectStats.map((item: any) => ({
      projectId: item._id.projectId,
      projectName: item._id.projectName || `Project ${item._id.projectId}`,
      count: item.count
    }));

    const dailyStats = result.dailyStats.map((item: any) => ({
      date: item._id,
      count: item.count
    }));

    const providerStats: Record<string, number> = {};
    for (const item of result.providerStats) {
      if (item._id) {
        providerStats[item._id] = item.count;
      }
    }

    const averageExecutionTime = totalCounts.totalEvents > 0
      ? Math.round(totalCounts.totalExecutionTime / totalCounts.totalEvents)
      : 0;

    // Process project details
    const projectDetails: ProjectDetailStats[] = result.projectDetails.map((item: any) => {
      const totalEvents = item.totalEvents || 0;
      const avgTime = totalEvents > 0 ? Math.round(item.totalExecutionTime / totalEvents) : 0;
      const successRate = totalEvents > 0 ? Math.round((item.successfulEvents / totalEvents) * 100) : 0;

      return {
        projectId: item._id.projectId,
        projectName: item._id.projectName || `Project ${item._id.projectId}`,
        totalEvents,
        successfulEvents: item.successfulEvents || 0,
        failedEvents: item.failedEvents || 0,
        averageExecutionTime: avgTime,
        successRate
      };
    });

    // Process provider context stats
    const providerContextMap = new Map<string, Record<EventContext, number>>();
    for (const item of result.providerContextStats) {
      const provider = item._id.provider || 'unknown';
      const context = item._id.context as EventContext;

      if (!providerContextMap.has(provider)) {
        providerContextMap.set(provider, {
          merge_request: 0,
          merge_request_comment: 0,
          issue: 0,
          issue_comment: 0
        });
      }

      const contexts = providerContextMap.get(provider)!;
      if (context) {
        contexts[context] = item.count;
      }
    }

    const providerContextStats: ProviderContextStats[] = Array.from(providerContextMap.entries()).map(([provider, contexts]) => ({
      provider,
      contexts,
      totalEvents: Object.values(contexts).reduce((sum, count) => sum + count, 0)
    }));

    return {
      totalEvents: totalCounts.totalEvents,
      successfulEvents: totalCounts.successfulEvents,
      failedEvents: totalCounts.failedEvents,
      eventsByContext,
      eventsByProject,
      projectDetails,
      providerContextStats,
      dailyStats,
      averageExecutionTime,
      providerStats,
    };

  } catch (error) {
    logger.error('Failed to get config usage stats', {
      gitlabConfigId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Get webhook usage statistics by GitLab configuration ID
 */
export async function getConfigWebhookUsageStats(
  gitlabConfigId: string,
  startDate?: Date,
  endDate?: Date,
  excludeProgressResponses: boolean = true
): Promise<WebhookUsageStats> {
  if (!config.platform.hasMongoCredentials) {
    return {
      totalWebhooks: 0,
      processedWebhooks: 0,
      failedWebhooks: 0,
      webhooksByType: {},
      webhooksByAction: {},
      webhooksByContext: {
        merge_request: 0,
        merge_request_comment: 0,
        issue: 0,
        issue_comment: 0,
      },
      dailyWebhookStats: [],
      topUsers: [],
      responseTypeStats: {},
    };
  }

  try {
    const collection = await getEventsCollection();
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));

    const matchConditions: any[] = [
      buildConfigIdMatch(gitlabConfigId),
      {
        receivedAt: {
          $gte: startDate || thirtyDaysAgo,
          $lte: endDate || now
        }
      }
    ];

    if (excludeProgressResponses) {
      matchConditions.push({
        $or: [
          { isProgressResponse: { $ne: true } },
          { isProgressResponse: { $exists: false } }
        ]
      });
    }

    const pipeline = [
      { $match: { $and: matchConditions } },
      {
        $facet: {
          // Total count and status counts
          totalCount: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                processed: { $sum: { $cond: [{ $eq: ['$status', 'processed'] }, 1, 0] } },
                failed: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } }
              }
            }
          ],
          // Webhooks by event type
          typeStats: [
            {
              $group: {
                _id: '$eventType',
                count: { $sum: 1 }
              }
            }
          ],
          // Webhooks by webhook action
          actionStats: [
            {
              $group: {
                _id: '$webhookAction',
                count: { $sum: 1 }
              }
            }
          ],
          // Webhooks by context
          contextStats: [
            {
              $group: {
                _id: '$eventContext',
                count: { $sum: 1 }
              }
            }
          ],
          // Daily webhook stats
          dailyStats: [
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$receivedAt' } },
                count: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } }
          ],
          // Response type stats
          responseTypeStats: [
            {
              $group: {
                _id: '$responseType',
                count: { $sum: 1 }
              }
            }
          ]
        }
      }
    ];

    const [result] = await (collection as any).aggregate(pipeline).toArray();

    const statusCounts = result.totalCount[0] || { total: 0, processed: 0, failed: 0 };
    const totalWebhooks = statusCounts.total;
    const processedWebhooks = statusCounts.processed;
    const failedWebhooks = statusCounts.failed;

    const webhooksByType: Record<string, number> = {};
    for (const item of result.typeStats) {
      if (item._id) {
        webhooksByType[item._id] = item.count;
      }
    }

    const webhooksByAction: Record<string, number> = {};
    for (const item of result.actionStats) {
      if (item._id) {
        webhooksByAction[item._id] = item.count;
      }
    }

    const webhooksByContext: Record<EventContext, number> = {
      merge_request: 0,
      merge_request_comment: 0,
      issue: 0,
      issue_comment: 0,
    };
    for (const item of result.contextStats) {
      if (item._id) {
        webhooksByContext[item._id as EventContext] = item.count;
      }
    }

    const dailyWebhookStats = result.dailyStats.map((item: any) => ({
      date: item._id,
      count: item.count
    }));

    const responseTypeStats: Record<string, number> = {};
    for (const item of result.responseTypeStats) {
      if (item._id) {
        responseTypeStats[item._id] = item.count;
      }
    }

    return {
      totalWebhooks,
      processedWebhooks,
      failedWebhooks,
      webhooksByType,
      webhooksByAction,
      webhooksByContext,
      dailyWebhookStats,
      topUsers: [], // Not applicable for single config stats
      responseTypeStats,
    };

  } catch (error) {
    logger.error('Failed to get config webhook usage stats', {
      gitlabConfigId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Get historical usage totals for different webhook types by user token
 */
export async function getUserWebhookTypeTotals(
  userToken: string,
  excludeProgressResponses: boolean = true
): Promise<Record<EventContext, { total: number; thisMonth: number; lastMonth: number }>> {
  if (!config.platform.hasMongoCredentials) {
    const emptyStats = { total: 0, thisMonth: 0, lastMonth: 0 };
    return {
      merge_request: emptyStats,
      merge_request_comment: emptyStats,
      issue: emptyStats,
      issue_comment: emptyStats,
    };
  }

  try {
    const collection = await getEventsCollection();
    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

    const baseMatchQuery: any = {
      userToken
    };

    if (excludeProgressResponses) {
      baseMatchQuery.$or = [
        { isProgressResponse: { $ne: true } },
        { isProgressResponse: { $exists: false } }
      ];
    }

    const pipeline = [
      {
        $facet: {
          // Total counts by context
          totalStats: [
            { $match: baseMatchQuery },
            {
              $group: {
                _id: '$eventContext',
                count: { $sum: 1 }
              }
            }
          ],
          // This month counts
          thisMonthStats: [
            {
              $match: {
                ...baseMatchQuery,
                receivedAt: { $gte: thisMonthStart }
              }
            },
            {
              $group: {
                _id: '$eventContext',
                count: { $sum: 1 }
              }
            }
          ],
          // Last month counts
          lastMonthStats: [
            {
              $match: {
                ...baseMatchQuery,
                receivedAt: {
                  $gte: lastMonthStart,
                  $lte: lastMonthEnd
                }
              }
            },
            {
              $group: {
                _id: '$eventContext',
                count: { $sum: 1 }
              }
            }
          ]
        }
      }
    ];

    const [result] = await (collection as any).aggregate(pipeline).toArray();

    const totalStats: Record<string, number> = {};
    for (const item of result.totalStats) {
      if (item._id) {
        totalStats[item._id] = item.count;
      }
    }

    const thisMonthStats: Record<string, number> = {};
    for (const item of result.thisMonthStats) {
      if (item._id) {
        thisMonthStats[item._id] = item.count;
      }
    }

    const lastMonthStats: Record<string, number> = {};
    for (const item of result.lastMonthStats) {
      if (item._id) {
        lastMonthStats[item._id] = item.count;
      }
    }

    const contexts: EventContext[] = ['merge_request', 'merge_request_comment', 'issue', 'issue_comment'];
    const results: Record<EventContext, { total: number; thisMonth: number; lastMonth: number }> = {} as any;

    for (const context of contexts) {
      results[context] = {
        total: totalStats[context] || 0,
        thisMonth: thisMonthStats[context] || 0,
        lastMonth: lastMonthStats[context] || 0,
      };
    }

    return results;

  } catch (error) {
    logger.error('Failed to get user webhook type totals', {
      userToken,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
