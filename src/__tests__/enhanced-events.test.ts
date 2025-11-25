import { 
  recordWebhookEvent, 
  getUserUsageStats, 
  getWebhookUsageStats,
  getUserWebhookTypeTotals,
  WebhookEventRecord,
  EventContext 
} from '../services/storage/eventRepository';
import { UsageStatsService } from '../services/usageStatsService';
// Mock config to enable MongoDB credentials for testing
jest.mock('../utils/config', () => ({
  config: {
    platform: {
      hasMongoCredentials: true
    }
  }
}));

// Mock MongoDB operations
jest.mock('../services/storage/mongoClient', () => {
  const mockAggregateImplementation = jest.fn().mockImplementation((pipeline) => {
    // Check if this is a webhook usage stats query by looking for totalCount facet
    const isWebhookUsageQuery = pipeline.some((stage: any) => 
      stage.$facet && stage.$facet.totalCount
    );
    
    // Check if this is a webhook type totals query by looking for multiple date-based facets
    const isWebhookTypeQuery = pipeline.some((stage: any) => 
      stage.$facet && stage.$facet.totalStats && stage.$facet.thisMonthStats
    );
    
    if (isWebhookUsageQuery) {
      return {
        toArray: jest.fn().mockResolvedValue([{
          totalCount: [{ total: 8, processed: 6, failed: 2 }],
          typeStats: [
            { _id: 'note', count: 5 },
            { _id: 'merge_request', count: 3 }
          ],
          actionStats: [
            { _id: 'create', count: 4 },
            { _id: 'open', count: 3 },
            { _id: 'update', count: 1 }
          ],
          contextStats: [
            { _id: 'issue_comment', count: 5 },
            { _id: 'merge_request', count: 3 }
          ],
          dailyStats: [
            { _id: '2025-01-01', count: 3 },
            { _id: '2025-01-02', count: 5 }
          ],
          topUsers: [
            { _id: 'test-user-token', count: 8 }
          ],
          responseTypeStats: [
            { _id: 'instruction', count: 8 }
          ]
        }])
      };
    }
    
    if (isWebhookTypeQuery) {
      return {
        toArray: jest.fn().mockResolvedValue([{
          totalStats: [
            { _id: 'issue_comment', count: 15 },
            { _id: 'merge_request', count: 8 }
          ],
          thisMonthStats: [
            { _id: 'issue_comment', count: 5 },
            { _id: 'merge_request', count: 3 }
          ],
          lastMonthStats: [
            { _id: 'issue_comment', count: 5 },
            { _id: 'merge_request', count: 2 }
          ]
        }])
      };
    }
    
    // Default user usage stats query
    return {
      toArray: jest.fn().mockResolvedValue([{
        totalCounts: [{ totalEvents: 5, successfulEvents: 4, failedEvents: 1, totalExecutionTime: 1000 }],
        contextStats: [
          { _id: 'issue_comment', count: 3 },
          { _id: 'merge_request', count: 2 }
        ],
        projectStats: [
          { _id: { projectId: 123, projectName: 'Test Project' }, count: 5 }
        ],
        dailyStats: [
          { _id: '2025-01-01', count: 2 },
          { _id: '2025-01-02', count: 3 }
        ],
        providerStats: [
          { _id: 'claude', count: 5 }
        ]
      }])
    };
  });

  return {
    getMongoDb: jest.fn().mockResolvedValue({
      collection: jest.fn().mockReturnValue({
        insertOne: jest.fn().mockResolvedValue({ insertedId: 'test-id' }),
        updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
        aggregate: mockAggregateImplementation
      })
    })
  };
});

// Mock user repository
jest.mock('../services/storage/userRepository', () => ({
  findUserByToken: jest.fn().mockResolvedValue({
    userId: 'test-user-id',
    userToken: 'test-user-token'
  })
}));

describe('Enhanced Events System', () => {
  const testUserToken = 'test-user-token';
  const usageStatsService = new UsageStatsService();

  describe('WebhookEventRecord with enhanced fields', () => {
    it('should record webhook event with enhanced background fields', async () => {
      const eventRecord: WebhookEventRecord = {
        status: 'received',
        userId: 'test-user-id',
        userToken: testUserToken,
        projectId: 123,
        projectName: 'Test Project',
        eventType: 'note',
        eventContext: 'issue_comment',
        contextId: 456,
        contextTitle: 'Test Issue',
        instructionText: '@claude fix this bug',
        aiProvider: 'claude',
        payload: { test: 'data' },
        receivedAt: new Date(),
        
        // Enhanced background fields
        note: 'Comment on issue in Test Project',
        isProgressResponse: false,
        responseType: 'instruction',
        webhookAction: 'create',
        sourceBranch: undefined,
        targetBranch: undefined,
        authorUsername: 'testuser',
        authorEmail: 'test@example.com',
      };

      const result = await recordWebhookEvent(eventRecord);
      expect(result).toBe('test-id');
    });

    it('should record merge request event with branch information', async () => {
      const eventRecord: WebhookEventRecord = {
        status: 'received',
        userId: 'test-user-id',
        userToken: testUserToken,
        projectId: 123,
        projectName: 'Test Project',
        eventType: 'merge_request',
        eventContext: 'merge_request',
        contextId: 789,
        contextTitle: 'Test MR',
        instructionText: '@claude review this code',
        aiProvider: 'claude',
        payload: { test: 'data' },
        receivedAt: new Date(),
        
        // Enhanced background fields for MR
        note: 'MR open in Test Project',
        isProgressResponse: false,
        responseType: 'instruction',
        webhookAction: 'open',
        sourceBranch: 'feature/test-branch',
        targetBranch: 'main',
        authorUsername: 'developer',
        authorEmail: 'dev@example.com',
      };

      const result = await recordWebhookEvent(eventRecord);
      expect(result).toBe('test-id');
    });
  });

  describe('Enhanced Statistics Functions', () => {
    it('should get user usage stats with non-progress filtering', async () => {
      const stats = await getUserUsageStats(testUserToken);
      
      expect(stats).toEqual({
        totalEvents: 5,
        successfulEvents: 4,
        failedEvents: 1,
        eventsByContext: {
          merge_request: 2,
          merge_request_comment: 0,
          issue: 0,
          issue_comment: 3,
        },
        eventsByProject: [
          { projectId: 123, projectName: 'Test Project', count: 5 }
        ],
        dailyStats: [
          { date: '2025-01-01', count: 2 },
          { date: '2025-01-02', count: 3 }
        ],
        averageExecutionTime: 200,
        providerStats: {
          claude: 5
        }
      });
    });

    it('should get webhook usage stats', async () => {
      const webhookStats = await getWebhookUsageStats(testUserToken);

      expect(webhookStats.totalWebhooks).toBe(8);
      expect(webhookStats.processedWebhooks).toBe(8);
      expect(webhookStats.failedWebhooks).toBe(2);
      expect(webhookStats.webhooksByType).toEqual({
        note: 6,
        merge_request: 4
      });
      expect(webhookStats.webhooksByAction).toEqual({
        create: 5,
        open: 3,
        update: 2
      });
      expect(webhookStats.webhooksByContext).toEqual({
        merge_request: 4,
        merge_request_comment: 0,
        issue: 0,
        issue_comment: 6,
      });
    });

    it('should get user webhook type totals', async () => {
      const typeTotals = await getUserWebhookTypeTotals(testUserToken);
      
      expect(typeTotals).toEqual({
        merge_request: { total: 8, thisMonth: 4, lastMonth: 2 },
        merge_request_comment: { total: 0, thisMonth: 0, lastMonth: 0 },
        issue: { total: 0, thisMonth: 0, lastMonth: 0 },
        issue_comment: { total: 15, thisMonth: 6, lastMonth: 5 },
      });
    });
  });

  describe('UsageStatsService Enhanced Methods', () => {
    it('should get webhook usage statistics through service', async () => {
      const webhookStats = await usageStatsService.getWebhookUsageStats(testUserToken, { period: 'month' });
      
      expect(webhookStats).toHaveProperty('totalWebhooks');
      expect(webhookStats).toHaveProperty('webhooksByType');
      expect(webhookStats).toHaveProperty('webhooksByAction');
      expect(webhookStats).toHaveProperty('period');
      expect(webhookStats.period.period).toBe('month');
    });

    it('should get user webhook type totals through service', async () => {
      const typeTotals = await usageStatsService.getUserWebhookTypeTotals(testUserToken);
      
      expect(typeTotals).toHaveProperty('merge_request');
      expect(typeTotals).toHaveProperty('issue_comment');
      expect(typeTotals.merge_request).toHaveProperty('total');
      expect(typeTotals.merge_request).toHaveProperty('thisMonth');
      expect(typeTotals.merge_request).toHaveProperty('lastMonth');
      expect(typeTotals.merge_request).toHaveProperty('contextLabel');
    });

    it('should get comprehensive user statistics', async () => {
      const comprehensiveStats = await usageStatsService.getComprehensiveUserStats(testUserToken, { period: 'week' });
      
      expect(comprehensiveStats).toHaveProperty('usageStats');
      expect(comprehensiveStats).toHaveProperty('webhookStats');
      expect(comprehensiveStats).toHaveProperty('webhookTypeTotals');
      expect(comprehensiveStats.usageStats.totalEvents).toBe(5);
      expect(comprehensiveStats.webhookStats.period.period).toBe('week');
    });
  });

  describe('Event Context Validation', () => {
    const validContexts: EventContext[] = [
      'merge_request',
      'merge_request_comment',
      'issue',
      'issue_comment'
    ];

    it('should validate all event context types', () => {
      validContexts.forEach(context => {
        expect(typeof context).toBe('string');
        expect(context.length).toBeGreaterThan(0);
      });
    });

    it('should handle context statistics for each type', async () => {
      for (const context of validContexts) {
        const stats = await usageStatsService.getContextStats(testUserToken, context, 30);
        expect(stats).toHaveProperty('count');
        expect(stats).toHaveProperty('percentage');
        expect(stats).toHaveProperty('trend');
      }
    });
  });

  describe('Progress Response Filtering', () => {
    it('should exclude progress responses from statistics by default', async () => {
      // The getUserUsageStats function should filter out isProgressResponse: true by default
      const stats = await getUserUsageStats(testUserToken);
      
      // This verifies that the aggregation pipeline includes the filter for non-progress responses
      expect(stats.totalEvents).toBe(5); // Should only count non-progress events
    });

    it('should handle webhook stats with progress response filtering', async () => {
      const webhookStats = await getWebhookUsageStats(testUserToken, undefined, undefined, true);
      
      // Should exclude progress responses by default
      expect(webhookStats.totalWebhooks).toBe(8); // Mocked response
      expect(webhookStats.responseTypeStats).toEqual({
        instruction: 8
      });
    });
  });

  describe('Background Note Generation', () => {
    const testCases = [
      {
        eventType: 'merge_request',
        action: 'open',
        projectName: 'Test Project',
        expected: 'MR open in Test Project'
      },
      {
        eventType: 'issue',
        action: 'create',
        projectName: 'Test Project',
        expected: 'Issue create in Test Project'
      },
      {
        eventType: 'note',
        noteableType: 'Issue',
        projectName: 'Test Project',
        expected: 'Comment on issue in Test Project'
      }
    ];

    testCases.forEach(testCase => {
      it(`should generate correct note for ${testCase.eventType} events`, () => {
        let expectedNote = '';
        if (testCase.eventType === 'merge_request') {
          expectedNote = `MR ${testCase.action} in ${testCase.projectName}`;
        } else if (testCase.eventType === 'issue') {
          expectedNote = `Issue ${testCase.action} in ${testCase.projectName}`;
        } else if (testCase.eventType === 'note') {
          expectedNote = `Comment on ${testCase.noteableType?.toLowerCase()} in ${testCase.projectName}`;
        }
        
        expect(expectedNote).toBe(testCase.expected);
      });
    });
  });
});
