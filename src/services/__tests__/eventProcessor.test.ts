import { EventProcessor } from '../eventProcessor';
import { GitLabWebhookEvent } from '../../types/gitlab';

// Mock dependencies
jest.mock('../projectManager');
jest.mock('../streamingAiExecutor');
jest.mock('../gitlabService');
jest.mock('../codeReviewService');
jest.mock('../sessionManager');
jest.mock('../../utils/config');
jest.mock('../../utils/logger');
jest.mock('../../utils/webhook');

import { SessionManager } from '../sessionManager';
import { StreamingAiExecutor } from '../streamingAiExecutor';
import { extractAiInstructions } from '../../utils/webhook';

const mockSessionManager = SessionManager as jest.MockedClass<typeof SessionManager>;
const mockStreamingAiExecutor = StreamingAiExecutor as jest.MockedClass<typeof StreamingAiExecutor>;
const mockExtractAiInstructions = extractAiInstructions as jest.MockedFunction<typeof extractAiInstructions>;

describe('EventProcessor Session Integration', () => {
  let eventProcessor: EventProcessor;
  let mockSessionManagerInstance: jest.Mocked<SessionManager>;
  let mockAiExecutorInstance: jest.Mocked<StreamingAiExecutor>;

  beforeEach(() => {
    // Create mock instances
    mockSessionManagerInstance = {
      generateSessionKey: jest.fn(),
      getSession: jest.fn(),
      getProviderSession: jest.fn(),
      setSession: jest.fn(),
      peekSession: jest.fn(),
      hasActiveSession: jest.fn(),
      removeSession: jest.fn(),
      cleanExpiredSessions: jest.fn(),
      getStats: jest.fn(),
      getAllSessions: jest.fn(),
      clearAllSessions: jest.fn(),
    } as any;

    mockAiExecutorInstance = {
      executeWithSession: jest.fn(),
      executeWithStreaming: jest.fn(),
    } as any;

    // Mock constructors to return our instances
    mockSessionManager.mockImplementation(() => mockSessionManagerInstance);
    mockStreamingAiExecutor.mockImplementation(() => mockAiExecutorInstance);

    eventProcessor = new EventProcessor();

    jest.clearAllMocks();
  });

  describe('shouldUseSession', () => {
    it('should detect session for issue events', async () => {
      const mockEvent: GitLabWebhookEvent = {
        object_kind: 'issue',
        project: { id: 123 },
        issue: { iid: 456, title: 'Test Issue', description: 'Test description' }
      } as any;

      mockSessionManagerInstance.generateSessionKey.mockReturnValue('123:456');
      mockSessionManagerInstance.getSession.mockReturnValue(null);

      const result = await (eventProcessor as any).shouldUseSession(mockEvent);

      expect(result.useSession).toBe(true);
      expect(result.issueKey).toBe('123:456');
      expect(mockSessionManagerInstance.generateSessionKey).toHaveBeenCalledWith(123, 456, undefined);
    });

    it('should find existing session for issue comments', async () => {
      const mockEvent: GitLabWebhookEvent = {
        object_kind: 'note',
        project: { id: 123 },
        issue: { iid: 456, title: 'Test Issue', description: 'Test description' }
      } as any;

      const existingSession = {
        lastUsed: new Date(),
        issueKey: '123:456',
        projectId: 123,
        issueIid: 456,
        createdAt: new Date(),
        providerSessions: {
          claude: {
            sessionId: 'existing-session-123',
            lastUsed: new Date(),
          },
        },
        lastProvider: 'claude' as const,
      } as any;

      mockSessionManagerInstance.generateSessionKey.mockReturnValue('123:456');
      mockSessionManagerInstance.getSession.mockReturnValue(existingSession);

      const result = await (eventProcessor as any).shouldUseSession(mockEvent);

      expect(result.useSession).toBe(true);
      expect(result.issueKey).toBe('123:456');
      expect(result.existingSession).toEqual(existingSession as any);
      expect(mockSessionManagerInstance.getSession).toHaveBeenCalledWith('123:456');
    });

    it('should return false for unsupported event types', async () => {
      const mockEvent: GitLabWebhookEvent = {
        object_kind: 'push',
        project: { id: 123 },
      } as any;

      const result = await (eventProcessor as any).shouldUseSession(mockEvent);

      expect(result.useSession).toBe(false);
      expect(result.issueKey).toBe('');
    });
  });

  describe('extractInstruction fallback', () => {
    it('should use existing session when note lacks explicit mention', async () => {
      const existingSession = {
        lastUsed: new Date(),
        issueKey: '123:456',
        projectId: 123,
        issueIid: 456,
        createdAt: new Date(),
        providerSessions: {
          claude: {
            sessionId: 'existing-session-123',
            lastUsed: new Date(),
          },
        },
        lastProvider: 'claude' as const,
        baseBranch: 'main',
      } as any;

      const noteEvent: GitLabWebhookEvent = {
        object_kind: 'note',
        project: { id: 123, default_branch: 'main', web_url: 'https://gitlab.com/test/repo' } as any,
        issue: { iid: 456, title: 'Test Issue', description: 'Desc' } as any,
        object_attributes: {
          id: 789,
          note: '请继续完善测试用例',
        } as any,
      } as any;

      mockExtractAiInstructions.mockReturnValueOnce(null);
      jest.spyOn(eventProcessor as any, 'getThreadContext').mockResolvedValue(null);

      const instruction = await (eventProcessor as any).withEventContext(async () => {
        return (eventProcessor as any).extractInstruction(noteEvent, {
          existingSession,
        });
      });

      expect(instruction).not.toBeNull();
      expect(instruction.command).toBe('请继续完善测试用例');
      expect(instruction.provider).toBe('claude');
      expect(instruction.branch).toBe('main');
      expect(instruction.context).toBe('请继续完善测试用例');
    });

    it('should require explicit mention for merge request notes even with existing session', async () => {
      const existingSession = {
        lastUsed: new Date(),
        issueKey: '123:789',
        projectId: 123,
        issueIid: 789,
        createdAt: new Date(),
        providerSessions: {
          codex: {
            sessionId: 'existing-session-456',
            lastUsed: new Date(),
          },
        },
        lastProvider: 'codex' as const,
        baseBranch: 'feature',
      } as any;

      const noteEvent: GitLabWebhookEvent = {
        object_kind: 'note',
        project: {
          id: 123,
          default_branch: 'main',
          web_url: 'https://gitlab.com/test/repo',
        } as any,
        merge_request: {
          iid: 789,
          title: 'Add new feature',
          description: 'Improvements',
          source_branch: 'feature',
          target_branch: 'main',
          action: 'open',
        } as any,
        object_attributes: {
          id: 999,
          note: '这个地方逻辑要不要再优化下？',
        } as any,
      } as any;

      mockExtractAiInstructions.mockReturnValueOnce(null);
      jest.spyOn(eventProcessor as any, 'buildMergeRequestContext').mockResolvedValue('MR context');
      jest.spyOn(eventProcessor as any, 'getThreadContext').mockResolvedValue(null);

      const instruction = await (eventProcessor as any).withEventContext(async () => {
        return (eventProcessor as any).extractInstruction(noteEvent, {
          existingSession,
        });
      });

      expect(instruction).toBeNull();
    });
  });

  describe('handleSessionBasedExecution', () => {
    it('should execute with new session and save session ID', async () => {
      const mockEvent: GitLabWebhookEvent = {
        object_kind: 'issue',
        project: { id: 123, default_branch: 'main', web_url: 'https://gitlab.com/test/repo' },
        issue: { iid: 456, title: 'Test Issue', description: 'Test description' }
      } as any;

      const mockInstruction = {
        command: 'Help me with this issue',
        provider: 'claude' as const,
        context: 'Issue context',
        fullContext: 'Full context',
        branch: 'main',
      };

      const sessionInfo = {
        issueKey: '123:456',
        provider: 'claude' as const,
      } as any;

      // Mock successful execution with session ID
      mockAiExecutorInstance.executeWithSession.mockResolvedValue({
        success: true,
        output: 'AI response',
        changes: [],
        sessionId: 'new-session-456',
      });

      // Mock other required methods
      jest.spyOn(eventProcessor as any, 'createProgressComment').mockResolvedValue(789);
      jest.spyOn(eventProcessor as any, 'updateProgressComment').mockResolvedValue(undefined);
      jest.spyOn(eventProcessor as any, 'handleSuccess').mockResolvedValue(undefined);
      jest.spyOn((eventProcessor as any).projectManager, 'prepareProject').mockResolvedValue('/tmp/project');
      jest.spyOn((eventProcessor as any).projectManager, 'cleanup').mockResolvedValue(undefined);

      await (eventProcessor as any).withEventContext(async () => {
        await (eventProcessor as any).handleSessionBasedExecution(mockEvent, mockInstruction, sessionInfo);
      });

      // Verify session was saved
      expect(mockSessionManagerInstance.setSession).toHaveBeenCalledWith(
        '123:456',
        'new-session-456',
        expect.objectContaining({
          projectId: 123,
          issueIid: 456,
          discussionId: undefined,
          baseBranch: 'main',
        }),
        'claude'
      );

      // Verify AI executor was called with correct options
      expect(mockAiExecutorInstance.executeWithSession).toHaveBeenCalledWith(
        'Help me with this issue',
        '/tmp/project',
        expect.objectContaining({
          context: 'Issue context',
          fullContext: 'Full context',
          provider: 'claude',
          scenario: 'issue-session',
        }),
        expect.any(Object), // callback
        expect.objectContaining({
          sessionId: undefined,
          isNewSession: true,
          outputFormat: 'json',
        })
      );
    });

    it('should execute with existing session', async () => {
      const mockEvent: GitLabWebhookEvent = {
        object_kind: 'note',
        project: { id: 123, default_branch: 'main', web_url: 'https://gitlab.com/test/repo' },
        issue: { iid: 456, title: 'Test Issue', description: 'Test description' }
      } as any;

      const mockInstruction = {
        command: 'Continue helping',
        provider: 'claude' as const,
        context: 'Issue context',
        branch: 'main',
      };

      const sessionInfo = {
        issueKey: '123:456',
        provider: 'claude' as const,
        existingSession: {
          lastUsed: new Date(),
          issueKey: '123:456',
          projectId: 123,
          issueIid: 456,
          createdAt: new Date(),
          providerSessions: {
            claude: {
              sessionId: 'existing-session-789',
              lastUsed: new Date(),
            },
          },
          lastProvider: 'claude' as const,
          baseBranch: 'main',
          branchName: 'claude-branch',
        },
      } as any;

      mockSessionManagerInstance.getProviderSession.mockReturnValue({
        sessionId: 'existing-session-789',
        lastUsed: new Date(),
      } as any);

      // Mock successful execution
      mockAiExecutorInstance.executeWithSession.mockResolvedValue({
        success: true,
        output: 'AI response',
        changes: [],
        sessionId: 'existing-session-789',
      });

      // Mock other required methods
      jest.spyOn(eventProcessor as any, 'createProgressComment').mockResolvedValue(789);
      jest.spyOn(eventProcessor as any, 'updateProgressComment').mockResolvedValue(undefined);
      jest.spyOn(eventProcessor as any, 'handleSuccess').mockResolvedValue(undefined);
      jest.spyOn((eventProcessor as any).projectManager, 'prepareProject').mockResolvedValue('/tmp/project');
      jest.spyOn((eventProcessor as any).projectManager, 'cleanup').mockResolvedValue(undefined);

      await (eventProcessor as any).withEventContext(async () => {
        await (eventProcessor as any).handleSessionBasedExecution(mockEvent, mockInstruction, sessionInfo);
      });

      // Verify session was NOT saved again (since it's existing)
      expect(mockSessionManagerInstance.setSession).not.toHaveBeenCalled();
      expect(mockSessionManagerInstance.getProviderSession).toHaveBeenCalledWith('123:456', 'claude');

      // Verify AI executor was called with existing session
      expect(mockAiExecutorInstance.executeWithSession).toHaveBeenCalledWith(
        'Continue helping',
        '/tmp/project',
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({
          sessionId: 'existing-session-789',
          isNewSession: false,
          outputFormat: 'text',
        })
      );
    });
  });

  describe('public session methods', () => {
    it('should expose session statistics', () => {
      const mockStats = {
        totalSessions: 5,
        activeSessions: 3,
        expiredSessions: 2,
      };

      mockSessionManagerInstance.getStats.mockReturnValue(mockStats);

      const result = eventProcessor.getSessionStats();

      expect(result).toBe(mockStats);
      expect(mockSessionManagerInstance.getStats).toHaveBeenCalled();
    });

    it('should clean expired sessions', () => {
      mockSessionManagerInstance.cleanExpiredSessions.mockReturnValue(3);

      const result = eventProcessor.cleanExpiredSessions(86400000); // 1 day

      expect(result).toBe(3);
      expect(mockSessionManagerInstance.cleanExpiredSessions).toHaveBeenCalledWith(86400000);
    });

    it('should remove specific session', () => {
      mockSessionManagerInstance.generateSessionKey.mockReturnValue('123:456');
      mockSessionManagerInstance.removeSession.mockReturnValue(true);

      const result = eventProcessor.removeSession(123, 456);

      expect(result).toBe(true);
      expect(mockSessionManagerInstance.generateSessionKey).toHaveBeenCalledWith(123, 456, undefined);
      expect(mockSessionManagerInstance.removeSession).toHaveBeenCalledWith('123:456');
    });
  });

  describe('response formatting enforcement', () => {
    it('should format success responses using AI response template', () => {
      const response = (eventProcessor as any).buildSuccessResponse({
        command: 'Implement feature X',
        changes: [
          { path: 'src/app.ts', type: 'modified' },
          { path: 'README.md', type: 'created' },
        ],
        output: 'Line one\n- second detail\n3. third detail\nextra context',
        sessionMode: 'new',
        baseBranch: 'main',
        branchName: 'feature-x',
        mergeRequestUrl: 'https://example.com/mr/1',
        mergeRequestIid: 1,
        warnings: ['注意：需要补充测试'],
      });

      expect(response).toContain('### ✅ 工作完成');
      expect(response).toContain('**梗概**');
      expect(response).toContain('Line one - second detail 3. third detail extra context');
      expect(response).toContain('**执行摘要**');
      expect(response).toContain('| Modified | `src/app.ts` |');
      expect(response).toContain('| Created | `README.md` |');
      expect(response).toContain('**需要澄清的问题**');
      expect(response).toContain('**AI 原始回复**');
      expect(response).toContain('Line one\n- second detail\n3. third detail\nextra context');
    });

    it('should format failure responses using AI response template', () => {
      const response = (eventProcessor as any).buildFailureResponse({
        command: 'Implement feature X',
        error: 'Validation failed\nDetails stack line',
      });

      expect(response).toContain('### ❌ 工作失败');
      expect(response).toContain('**指令摘要**');
      expect(response).toContain('**核心业务逻辑**');
      expect(response).toContain('**执行摘要**\n- 执行失败：Validation failed');
      expect(response).toContain('**代码变更**\n- 本次未对仓库做任何修改');
      expect(response).toContain('**附加说明**');
      expect(response).toContain('```');
      expect(response).toContain('Validation failed');
    });
  });
});
