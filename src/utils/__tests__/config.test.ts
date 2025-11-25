// Mock environment variables before importing config
const originalEnv = process.env;

function clearSessionEnv(): void {
  delete process.env.SESSION_ENABLED;
  delete process.env.SESSION_MAX_IDLE_TIME;
  delete process.env.SESSION_MAX_SESSIONS;
  delete process.env.SESSION_CLEANUP_INTERVAL;
}

function clearPlatformEnv(): void {
  delete process.env.MONGODB_URI;
  delete process.env.MONGODB_DB;
  delete process.env.MONGODB_DBNAME;
  delete process.env.ENCRYPTION_KEY;
}

describe('Config System', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    clearSessionEnv();
    clearPlatformEnv();
    // Set required env vars to prevent validation errors
    process.env.GITLAB_TOKEN = 'test-token';
    process.env.WEBHOOK_SECRET = 'test-secret';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('parseTimeToMs', () => {
    it('should parse time units correctly', async () => {
      const { parseTimeToMs } = await import('../config');

      expect(parseTimeToMs('7d', 0)).toBe(7 * 24 * 60 * 60 * 1000);
      expect(parseTimeToMs('24h', 0)).toBe(24 * 60 * 60 * 1000);
      expect(parseTimeToMs('60m', 0)).toBe(60 * 60 * 1000);
      expect(parseTimeToMs('30s', 0)).toBe(30 * 1000);
      expect(parseTimeToMs('1800000', 0)).toBe(1800000);
    });

    it('should return default for invalid values', async () => {
      const { parseTimeToMs } = await import('../config');

      expect(parseTimeToMs('invalid', 5000)).toBe(5000);
      expect(parseTimeToMs('', 5000)).toBe(5000);
    });
  });

  describe('session configuration', () => {
    it('should load default session config when env vars not set', async () => {
      clearSessionEnv();
      const { config } = await import('../config');

      expect(config.session.enabled).toBe(true);
      expect(config.session.maxIdleTime).toBe(7 * 24 * 60 * 60 * 1000); // 7 days
      expect(config.session.maxSessions).toBe(1000);
      expect(config.session.cleanupInterval).toBe(60 * 60 * 1000); // 1 hour
    });

    it('should parse session config from environment', async () => {
      process.env.SESSION_ENABLED = 'false';
      process.env.SESSION_MAX_IDLE_TIME = '3d';
      process.env.SESSION_MAX_SESSIONS = '500';
      process.env.SESSION_CLEANUP_INTERVAL = '30m';

      const { config } = await import('../config');

      expect(config.session.enabled).toBe(false);
      expect(config.session.maxIdleTime).toBe(3 * 24 * 60 * 60 * 1000);
      expect(config.session.maxSessions).toBe(500);
      expect(config.session.cleanupInterval).toBe(30 * 60 * 1000);
    });
  });

  describe('configuration validation', () => {
    it('should pass validation with valid config', async () => {
      process.env.PORT = '3000';
      clearPlatformEnv();

      await expect(import('../config')).resolves.toBeDefined();
    });

    it('should fail validation when GITLAB_TOKEN is missing', async () => {
      delete process.env.GITLAB_TOKEN;
      process.env.WEBHOOK_SECRET = 'test-secret';
      clearPlatformEnv();

      await expect(import('../config')).rejects.toThrow('Credentials missing');
    });

    it('should fail validation when WEBHOOK_SECRET is missing', async () => {
      process.env.GITLAB_TOKEN = 'test-token';
      delete process.env.WEBHOOK_SECRET;
      clearPlatformEnv();

      await expect(import('../config')).rejects.toThrow('Credentials missing');
    });

    it('should fail validation with invalid port', async () => {
      process.env.PORT = '0';

      await expect(import('../config')).rejects.toThrow('PORT must be a number between 1 and 65535');
    });

    it('should fail validation with invalid session config', async () => {
      process.env.SESSION_ENABLED = 'true';
      process.env.SESSION_MAX_IDLE_TIME = '30s'; // Less than 1 minute

      await expect(import('../config')).rejects.toThrow('SESSION_MAX_IDLE_TIME must be at least 60000ms');
    });

    it('should fail validation with invalid max sessions', async () => {
      process.env.SESSION_ENABLED = 'true';
      process.env.SESSION_MAX_SESSIONS = '0';

      await expect(import('../config')).rejects.toThrow('SESSION_MAX_SESSIONS must be at least 1');
    });

    it('should fail validation with invalid cleanup interval', async () => {
      process.env.SESSION_ENABLED = 'true';
      process.env.SESSION_CLEANUP_INTERVAL = '30s'; // Less than 1 minute

      await expect(import('../config')).rejects.toThrow('SESSION_CLEANUP_INTERVAL must be at least 60000ms');
    });

    it('should fail validation when session cleanup interval exceeds timer limit', async () => {
      process.env.SESSION_ENABLED = 'true';
      process.env.SESSION_CLEANUP_INTERVAL = '30d';

      await expect(import('../config')).rejects.toThrow('SESSION_CLEANUP_INTERVAL must not exceed');
    });

    it('should fail validation when workspace cleanup interval exceeds timer limit', async () => {
      process.env.WORKSPACE_CLEANUP_INTERVAL = '30d';

      await expect(import('../config')).rejects.toThrow('WORKSPACE_CLEANUP_INTERVAL must not exceed');
    });

    it('should skip session validation when sessions disabled', async () => {
      process.env.SESSION_ENABLED = 'false';
      process.env.SESSION_MAX_IDLE_TIME = '30s'; // Would be invalid if sessions enabled

      await expect(import('../config')).resolves.toBeDefined();
    });
  });
});
