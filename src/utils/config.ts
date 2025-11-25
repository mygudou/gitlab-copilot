import path from 'path';
import { Config } from '../types/common';

/**
 * Expand environment variables in a string
 * Supports ${VAR} and $VAR syntax
 */
function expandEnvVars(str: string): string {
  if (!str) return str;

  return str.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/gi, (match, braced, unbraced) => {
    const varName = braced || unbraced;
    return process.env[varName] || match;
  });
}

/**
 * Get environment variable with expansion support
 */
function getEnvVar(key: string, defaultValue: string = ''): string {
  const value = process.env[key] || defaultValue;
  return expandEnvVars(value);
}

function hasValue(value: string): boolean {
  return Boolean(value && value.length > 0);
}

const defaultAnthropicBaseUrl = 'https://api.anthropic.com';
const anthropicBaseUrl = getEnvVar('ANTHROPIC_BASE_URL', defaultAnthropicBaseUrl).trim() || defaultAnthropicBaseUrl;
const anthropicAuthToken = getEnvVar('ANTHROPIC_AUTH_TOKEN').trim();

const rawAiExecutor = getEnvVar('AI_EXECUTOR', 'claude').trim().toLowerCase();
const aiExecutor = rawAiExecutor === 'codex' ? 'codex' : 'claude';

const rawCodeReviewExecutor = getEnvVar('CODE_REVIEW_EXECUTOR', 'codex').trim().toLowerCase();
const codeReviewExecutor = rawCodeReviewExecutor === 'claude' ? 'claude' : 'codex';

const defaultGitlabBaseUrl = 'https://gitlab.example.com';
const gitlabBaseUrl = getEnvVar('GITLAB_BASE_URL', defaultGitlabBaseUrl).trim() || defaultGitlabBaseUrl;
const gitlabToken = getEnvVar('GITLAB_TOKEN').trim();

const webhookSecret = getEnvVar('WEBHOOK_SECRET').trim();
const port = parseInt(getEnvVar('PORT', '3000'), 10);

const defaultWorkDir = '/tmp/gitlab-copilot-work';
const workDirEnv = getEnvVar('WORK_DIR', defaultWorkDir).trim();
const workDir = workDirEnv || defaultWorkDir;

const defaultSessionStoragePath = path.join(workDir, 'sessions.json');
const sessionStorageEnv = getEnvVar('SESSION_STORE_PATH', defaultSessionStoragePath).trim();
const sessionStoragePath = sessionStorageEnv || defaultSessionStoragePath;

const mongodbUri = getEnvVar('MONGODB_URI').trim();
const mongodbDb = getEnvVar('MONGODB_DB').trim();
const encryptionKey = getEnvVar('ENCRYPTION_KEY').trim();

const logLevel = getEnvVar('LOG_LEVEL', 'info').trim() || 'info';

const MAX_TIMER_INTERVAL_MS = 2 ** 31 - 1; // Node.js timers use signed 32-bit integers

const workspaceMaxIdleTime = parseTimeToMs(
  getEnvVar('WORKSPACE_MAX_IDLE_TIME', '24h'),
  24 * 60 * 60 * 1000
);

const workspaceCleanupInterval = parseTimeToMs(
  getEnvVar('WORKSPACE_CLEANUP_INTERVAL', '6h'),
  6 * 60 * 60 * 1000
);

const hasLegacyCredentials = hasValue(gitlabToken) && hasValue(webhookSecret);
const hasMongoCredentials = hasValue(mongodbUri) && hasValue(mongodbDb) && hasValue(encryptionKey);

/**
 * Parse a time duration string to milliseconds
 * Supports: '7d', '24h', '60m', '3600s', '1800000' (plain number as ms)
 * @internal - Exported for testing purposes
 */
export function parseTimeToMs(value: string, defaultMs: number): number {
  if (!value) return defaultMs;

  const match = value.match(/^(\d+)([dhms]?)$/i);
  if (!match) {
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? defaultMs : parsed;
  }

  const [, num, unit] = match;
  const number = parseInt(num, 10);

  switch (unit.toLowerCase()) {
    case 'd':
      return number * 24 * 60 * 60 * 1000;
    case 'h':
      return number * 60 * 60 * 1000;
    case 'm':
      return number * 60 * 1000;
    case 's':
      return number * 1000;
    default:
      return number;
  }
}

/**
 * Configuration validation
 */
function validateConfig(cfg: Config): void {
  const errors: string[] = [];

  const legacyReady = hasValue(cfg.gitlab.token) && hasValue(cfg.webhook.secret);
  const mongoUriSet = hasValue(cfg.mongodb.uri);
  const mongoDbSet = hasValue(cfg.mongodb.dbName);
  const encryptionKeySet = hasValue(cfg.encryption.key);
  const platformReady = mongoUriSet && mongoDbSet && encryptionKeySet;

  if (!legacyReady && !platformReady) {
    errors.push(
      'Credentials missing: configure GITLAB_TOKEN + WEBHOOK_SECRET or provide MONGODB_URI + MONGODB_DB + ENCRYPTION_KEY for platform mode.'
    );
  }

  if ((mongoUriSet || mongoDbSet || encryptionKeySet) && !platformReady) {
    if (!mongoUriSet) {
      errors.push('MONGODB_URI is required when configuring platform mode');
    }

    if (!mongoDbSet) {
      errors.push('MONGODB_DB is required when configuring platform mode');
    }

    if (!encryptionKeySet) {
      errors.push('ENCRYPTION_KEY is required when configuring platform mode');
    }
  }

  if (!Number.isFinite(cfg.webhook.port) || cfg.webhook.port < 1 || cfg.webhook.port > 65535) {
    errors.push('PORT must be a number between 1 and 65535');
  }

  if (cfg.session.enabled) {
    if (cfg.session.maxIdleTime < 60000) {
      // Less than 1 minute
      errors.push('SESSION_MAX_IDLE_TIME must be at least 60000ms (1 minute)');
    }

    if (cfg.session.maxSessions < 1) {
      errors.push('SESSION_MAX_SESSIONS must be at least 1');
    }

    if (cfg.session.cleanupInterval < 60000) {
      // Less than 1 minute
      errors.push('SESSION_CLEANUP_INTERVAL must be at least 60000ms (1 minute)');
    }

    if (cfg.session.cleanupInterval > MAX_TIMER_INTERVAL_MS) {
      errors.push(
        `SESSION_CLEANUP_INTERVAL must not exceed ${MAX_TIMER_INTERVAL_MS}ms (~24.8 days) due to Node.js timer limits`
      );
    }

    if (!hasValue(cfg.session.storagePath)) {
      errors.push('SESSION_STORE_PATH is required when sessions are enabled');
    }
  }

  if (cfg.workspace.maxIdleTime < 60000) {
    errors.push('WORKSPACE_MAX_IDLE_TIME must be at least 60000ms (1 minute)');
  }

  if (cfg.workspace.cleanupInterval < 60000) {
    errors.push('WORKSPACE_CLEANUP_INTERVAL must be at least 60000ms (1 minute)');
  }

  if (cfg.workspace.cleanupInterval > MAX_TIMER_INTERVAL_MS) {
    errors.push(
      `WORKSPACE_CLEANUP_INTERVAL must not exceed ${MAX_TIMER_INTERVAL_MS}ms (~24.8 days) due to Node.js timer limits`
    );
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }
}

export const config: Config = {
  anthropic: {
    baseUrl: anthropicBaseUrl,
    authToken: hasValue(anthropicAuthToken) ? anthropicAuthToken : undefined,
  },
  ai: {
    executor: aiExecutor,
    displayName: aiExecutor === 'codex' ? 'Codex' : 'Claude',
    codeReviewExecutor: codeReviewExecutor,
  },
  gitlab: {
    baseUrl: gitlabBaseUrl,
    token: gitlabToken,
  },
  webhook: {
    secret: webhookSecret,
    port,
  },
  mongodb: {
    uri: mongodbUri,
    dbName: mongodbDb,
  },
  encryption: {
    key: encryptionKey,
  },
  platform: {
    hasLegacyCredentials,
    hasMongoCredentials,
  },
  session: {
    enabled: getEnvVar('SESSION_ENABLED', 'true').toLowerCase() === 'true',
    maxIdleTime: parseTimeToMs(getEnvVar('SESSION_MAX_IDLE_TIME', '7d'), 7 * 24 * 60 * 60 * 1000),
    maxSessions: parseInt(getEnvVar('SESSION_MAX_SESSIONS', '1000'), 10),
    cleanupInterval: parseTimeToMs(getEnvVar('SESSION_CLEANUP_INTERVAL', '1h'), 60 * 60 * 1000),
    storagePath: sessionStoragePath,
  },
  workspace: {
    maxIdleTime: workspaceMaxIdleTime,
    cleanupInterval: workspaceCleanupInterval,
  },
  workDir,
  logLevel,
};

// Validate configuration on load
validateConfig(config);
