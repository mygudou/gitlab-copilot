import { SessionCleanupService } from '../sessionCleanupService';
import { SessionManager } from '../sessionManager';
import { config } from '../../utils/config';

// Mock the config module
jest.mock('../../utils/config', () => ({
  config: {
    session: {
      enabled: true,
      cleanupInterval: 1000, // 1 second for tests
      maxIdleTime: 2000, // 2 seconds for tests
      maxSessions: 100,
      storagePath: '/tmp/test-sessions.json',
    },
  },
}));

jest.mock('../../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe('SessionCleanupService', () => {
  let cleanupService: SessionCleanupService;
  let mockSessionManager: jest.Mocked<SessionManager>;

  beforeEach(() => {
    // Create a mock SessionManager
    mockSessionManager = {
      cleanExpiredSessions: jest.fn().mockReturnValue(5),
      getStats: jest.fn().mockReturnValue({
        totalSessions: 10,
        activeSessions: 8,
        expiredSessions: 2,
      }),
    } as any;

    cleanupService = new SessionCleanupService(mockSessionManager);

    // Clear all mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Make sure to stop any running cleanup service
    cleanupService.stop();
  });

  describe('start and stop', () => {
    it('should start the cleanup service', () => {
      expect(cleanupService.isServiceRunning()).toBe(false);

      cleanupService.start();

      expect(cleanupService.isServiceRunning()).toBe(true);
      expect(mockSessionManager.cleanExpiredSessions).toHaveBeenCalled();
    });

    it('should not start if already running', () => {
      cleanupService.start();
      const firstCallCount = mockSessionManager.cleanExpiredSessions.mock.calls.length;

      cleanupService.start(); // Second call should be ignored

      expect(mockSessionManager.cleanExpiredSessions).toHaveBeenCalledTimes(firstCallCount);
    });

    it('should stop the cleanup service', () => {
      cleanupService.start();
      expect(cleanupService.isServiceRunning()).toBe(true);

      cleanupService.stop();

      expect(cleanupService.isServiceRunning()).toBe(false);
    });

    it('should not stop if not running', () => {
      expect(cleanupService.isServiceRunning()).toBe(false);

      // Should not throw
      cleanupService.stop();

      expect(cleanupService.isServiceRunning()).toBe(false);
    });

    it('should not start when sessions are disabled', () => {
      // Mock config with sessions disabled
      const mockConfig = config as any;
      mockConfig.session.enabled = false;

      cleanupService.start();

      expect(cleanupService.isServiceRunning()).toBe(false);
      expect(mockSessionManager.cleanExpiredSessions).not.toHaveBeenCalled();

      // Reset config
      mockConfig.session.enabled = true;
    });
  });

  describe('periodic cleanup', () => {
    it('should run cleanup at intervals', (done) => {
      cleanupService.start();

      // Wait for a couple of intervals
      setTimeout(() => {
        expect(mockSessionManager.cleanExpiredSessions).toHaveBeenCalledTimes(3); // Initial + 2 intervals
        cleanupService.stop();
        done();
      }, 2500); // Wait 2.5 seconds (2+ intervals)
    }, 5000);

    it('should handle cleanup errors gracefully', (done) => {
      // Make cleanExpiredSessions throw an error
      mockSessionManager.cleanExpiredSessions.mockImplementation(() => {
        throw new Error('Test cleanup error');
      });

      cleanupService.start();

      // Wait for cleanup to run and handle the error
      setTimeout(() => {
        expect(mockSessionManager.cleanExpiredSessions).toHaveBeenCalled();
        cleanupService.stop();
        done();
      }, 1500);
    });
  });

  describe('manual cleanup', () => {
    it('should run manual cleanup and return statistics', async () => {
      mockSessionManager.getStats
        .mockReturnValueOnce({
          totalSessions: 15,
          activeSessions: 10,
          expiredSessions: 5,
        })
        .mockReturnValueOnce({
          totalSessions: 10,
          activeSessions: 10,
          expiredSessions: 0,
        });

      mockSessionManager.cleanExpiredSessions.mockReturnValue(5);

      const result = await cleanupService.runManualCleanup();

      expect(result.expiredSessions).toBe(5);
      expect(result.totalSessions).toBe(10);
      expect(result.cleanupDuration).toBeGreaterThanOrEqual(0);
      expect(mockSessionManager.cleanExpiredSessions).toHaveBeenCalledTimes(1);
    });

    it('should measure cleanup duration accurately', async () => {
      // Mock a slow cleanup operation
      mockSessionManager.cleanExpiredSessions.mockImplementation(() => {
        // Simulate some work
        const start = Date.now();
        while (Date.now() - start < 100) {
          // Busy wait for 100ms
        }
        return 3;
      });

      const result = await cleanupService.runManualCleanup();

      expect(result.cleanupDuration).toBeGreaterThanOrEqual(100);
    });
  });

  describe('getStatus', () => {
    it('should return correct status when not running', () => {
      const status = cleanupService.getStatus();

      expect(status.isRunning).toBe(false);
      expect(status.cleanupInterval).toBe(1000);
      expect(status.maxIdleTime).toBe(2000);
      expect(status.nextCleanup).toBeUndefined();
    });

    it('should return correct status when running with next cleanup time', () => {
      cleanupService.start();

      const status = cleanupService.getStatus();

      expect(status.isRunning).toBe(true);
      expect(status.cleanupInterval).toBe(1000);
      expect(status.maxIdleTime).toBe(2000);
      expect(status.nextCleanup).toBeDefined();
      expect(status.nextCleanup!.getTime()).toBeGreaterThan(Date.now());

      cleanupService.stop();
    });
  });

  describe('isServiceRunning', () => {
    it('should return false initially', () => {
      expect(cleanupService.isServiceRunning()).toBe(false);
    });

    it('should return true after start', () => {
      cleanupService.start();
      expect(cleanupService.isServiceRunning()).toBe(true);
    });

    it('should return false after stop', () => {
      cleanupService.start();
      cleanupService.stop();
      expect(cleanupService.isServiceRunning()).toBe(false);
    });
  });
});
