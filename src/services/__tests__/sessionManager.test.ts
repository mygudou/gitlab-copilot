import { SessionManager } from '../sessionManager';
import { SessionInfo } from '../../types/session';
import { SessionStore } from '../sessionStore';

class InMemorySessionStore implements SessionStore {
  private data: SessionInfo[] = [];

  load(): SessionInfo[] {
    return this.data.map(session => ({
      ...session,
      lastUsed: new Date(session.lastUsed),
      createdAt: new Date(session.createdAt),
      providerSessions: Object.fromEntries(
        Object.entries(session.providerSessions).map(([provider, info]) => [
          provider,
          info
            ? {
                sessionId: info.sessionId,
                lastUsed: new Date(info.lastUsed),
              }
            : undefined,
        ])
      ),
    }));
  }

  persist(sessions: SessionInfo[]): void {
    this.data = sessions.map(session => ({
      ...session,
      lastUsed: new Date(session.lastUsed),
      createdAt: new Date(session.createdAt),
      providerSessions: Object.fromEntries(
        Object.entries(session.providerSessions).map(([provider, info]) => [
          provider,
          info
            ? {
                sessionId: info.sessionId,
                lastUsed: new Date(info.lastUsed),
              }
            : undefined,
        ])
      ),
    }));
  }
}

describe('SessionManager', () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager({
      maxIdleTime: 1000, // 1秒用于测试
      maxSessions: 5, // 小数值便于测试
      cleanupInterval: 100,
    }, new InMemorySessionStore());
  });

  afterEach(() => {
    sessionManager.clearAllSessions();
  });

  describe('generateSessionKey', () => {
    it('should generate correct session key', () => {
      const key = sessionManager.generateSessionKey(123, 456);
      expect(key).toBe('123:456');
    });
  });

  describe('setSession and getSession', () => {
    it('should store and retrieve session', () => {
      const issueKey = '123:456';
      const sessionId = 'test-session-123';
      const issueInfo = { projectId: 123, issueIid: 456 };

      sessionManager.setSession(issueKey, sessionId, issueInfo);
      const retrieved = sessionManager.getSession(issueKey);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.providerSessions.claude?.sessionId).toBe(sessionId);
      expect(retrieved?.lastProvider).toBe('claude');
      expect(retrieved?.projectId).toBe(123);
      expect(retrieved?.issueIid).toBe(456);
    });

    it('should return null for non-existent session', () => {
      const retrieved = sessionManager.getSession('non-existent');
      expect(retrieved).toBeNull();
    });

    it('should store session with codex provider', () => {
      const issueKey = '123:456';
      const sessionId = 'codex-session-123';
      const issueInfo = { projectId: 123, issueIid: 456 };

      sessionManager.setSession(issueKey, sessionId, issueInfo, 'codex');
      const retrieved = sessionManager.getSession(issueKey);

      expect(retrieved?.providerSessions.codex?.sessionId).toBe(sessionId);
      expect(retrieved?.lastProvider).toBe('codex');
    });

    it('should peek session without updating lastUsed', () => {
      const issueKey = '123:456';
      sessionManager.setSession(issueKey, 'peek-session', { projectId: 123, issueIid: 456 });

      const peeked = sessionManager.peekSession(issueKey);
      expect(peeked?.providerSessions.claude?.sessionId).toBe('peek-session');

      const retrieved = sessionManager.getSession(issueKey);
      expect(retrieved?.providerSessions.claude?.sessionId).toBe('peek-session');
    });

    it('should merge additional metadata when updating session', () => {
      const issueKey = '123:456';
      const sessionId = 'session-meta';

      sessionManager.setSession(issueKey, sessionId, { projectId: 123, issueIid: 456, baseBranch: 'main' });
      sessionManager.setSession(issueKey, sessionId, {
        projectId: 123,
        issueIid: 456,
        branchName: 'feature-branch',
        baseBranch: 'main',
        mergeRequestUrl: 'https://example.com/mr/1',
      });

      const retrieved = sessionManager.getSession(issueKey);

      expect(retrieved?.branchName).toBe('feature-branch');
      expect(retrieved?.baseBranch).toBe('main');
      expect(retrieved?.mergeRequestUrl).toBe('https://example.com/mr/1');
    });
  });

  describe('hasActiveSession', () => {
    it('should return true for active session', () => {
      const issueKey = '123:456';
      sessionManager.setSession(issueKey, 'test-session', { projectId: 123, issueIid: 456 });

      expect(sessionManager.hasActiveSession(issueKey)).toBe(true);
      expect(sessionManager.hasActiveSession(issueKey, 'claude')).toBe(true);
      expect(sessionManager.hasActiveSession(issueKey, 'codex')).toBe(false);
    });

    it('should return false for non-existent session', () => {
      expect(sessionManager.hasActiveSession('non-existent')).toBe(false);
    });
  });

  describe('removeSession', () => {
    it('should remove existing session', () => {
      const issueKey = '123:456';
      sessionManager.setSession(issueKey, 'test-session', { projectId: 123, issueIid: 456 });

      const removed = sessionManager.removeSession(issueKey);
      expect(removed).toBe(true);
      expect(sessionManager.getSession(issueKey)).toBeNull();
    });

    it('should remove only specified provider session when provided', () => {
      const issueKey = '123:789';
      sessionManager.setSession(issueKey, 'claude-session', { projectId: 123, issueIid: 789 }, 'claude');
      sessionManager.setSession(issueKey, 'codex-session', { projectId: 123, issueIid: 789 }, 'codex');

      const removed = sessionManager.removeSession(issueKey, 'claude');
      expect(removed).toBe(true);

      const remaining = sessionManager.getSession(issueKey);
      expect(remaining?.providerSessions.claude).toBeUndefined();
      expect(remaining?.providerSessions.codex?.sessionId).toBe('codex-session');
    });

    it('should return false for non-existent session', () => {
      const removed = sessionManager.removeSession('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('cleanExpiredSessions', () => {
    it('should clean expired sessions', async () => {
      const issueKey = '123:456';
      sessionManager.setSession(issueKey, 'test-session', { projectId: 123, issueIid: 456 });

      // 等待session过期
      await new Promise(resolve => setTimeout(resolve, 1100));

      const cleanedCount = sessionManager.cleanExpiredSessions();
      expect(cleanedCount).toBe(1);
      expect(sessionManager.getSession(issueKey)).toBeNull();
    });

    it('should not clean active sessions', () => {
      const issueKey = '123:456';
      sessionManager.setSession(issueKey, 'test-session', { projectId: 123, issueIid: 456 });

      const cleanedCount = sessionManager.cleanExpiredSessions();
      expect(cleanedCount).toBe(0);
      expect(sessionManager.getSession(issueKey)).not.toBeNull();
    });
  });

  describe('session limits', () => {
    it('should cleanup oldest sessions when limit reached', () => {
      // 添加最大数量的session
      for (let i = 0; i < 5; i++) {
        sessionManager.setSession(`123:${i}`, `session-${i}`, { projectId: 123, issueIid: i });
      }

      expect(sessionManager.getStats().totalSessions).toBe(5);

      // 添加第6个session应该触发清理
      sessionManager.setSession('123:999', 'session-999', { projectId: 123, issueIid: 999 });

      const stats = sessionManager.getStats();
      expect(stats.totalSessions).toBeLessThan(6);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      sessionManager.setSession('123:1', 'session-1', { projectId: 123, issueIid: 1 });
      sessionManager.setSession('123:2', 'session-2', { projectId: 123, issueIid: 2 });

      const stats = sessionManager.getStats();
      expect(stats.totalSessions).toBe(2);
      expect(stats.activeSessions).toBe(2);
      expect(stats.expiredSessions).toBe(0);
      expect(stats.oldestSession).toBeDefined();
      expect(stats.newestSession).toBeDefined();
    });
  });

  describe('multiple providers in same MR', () => {
    it('should maintain separate sessions for @codex and @claude', async () => {
      const issueKey = '123:456';
      const issueInfo = { projectId: 123, issueIid: 456 };

      // 第一次 @codex
      sessionManager.setSession(issueKey, 'codex-session-abc', issueInfo, 'codex');
      let session = sessionManager.getSession(issueKey);
      expect(session?.providerSessions.codex?.sessionId).toBe('codex-session-abc');
      expect(session?.lastProvider).toBe('codex');

      await new Promise(resolve => setTimeout(resolve, 10));

      // 第二次 @claude
      sessionManager.setSession(issueKey, 'claude-session-xyz', issueInfo, 'claude');
      session = sessionManager.getSession(issueKey);
      expect(session?.providerSessions.codex?.sessionId).toBe('codex-session-abc'); // 应该保留
      expect(session?.providerSessions.claude?.sessionId).toBe('claude-session-xyz');
      expect(session?.lastProvider).toBe('claude');

      // 第三次 @codex - 应该复用之前的 session
      const codexSession = sessionManager.getProviderSession(issueKey, 'codex');
      expect(codexSession?.sessionId).toBe('codex-session-abc');

      // 验证两个 provider 的 session 都存在
      expect(sessionManager.hasActiveSession(issueKey, 'codex')).toBe(true);
      expect(sessionManager.hasActiveSession(issueKey, 'claude')).toBe(true);
    });

    it('should update lastProvider when using getProviderSession', async () => {
      const issueKey = '123:789';
      const issueInfo = { projectId: 123, issueIid: 789 };

      // 先设置 codex session
      sessionManager.setSession(issueKey, 'codex-1', issueInfo, 'codex');
      await new Promise(resolve => setTimeout(resolve, 10));

      // 再设置 claude session（此时 claude 应该是最新的）
      sessionManager.setSession(issueKey, 'claude-1', issueInfo, 'claude');
      let session = sessionManager.getSession(issueKey);
      expect(session?.lastProvider).toBe('claude');

      await new Promise(resolve => setTimeout(resolve, 10));

      // 使用 getProviderSession 会更新该 provider 的 lastUsed，从而更新 lastProvider
      sessionManager.getProviderSession(issueKey, 'codex');
      session = sessionManager.getSession(issueKey);
      expect(session?.lastProvider).toBe('codex');
    });
  });
});
