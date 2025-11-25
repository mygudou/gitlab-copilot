import { config } from './config';

function maskValue(value: string | undefined, visible: number = 4): string {
  if (!value || value.length === 0) {
    return 'NOT SET';
  }
  if (value.length <= visible) {
    return '***';
  }
  return '***' + value.slice(-visible);
}

/**
 * Debug configuration loading
 * Useful for troubleshooting environment variable issues
 */
export function debugConfig(): void {
  console.log('🔧 Configuration Debug Information:');
  console.log('=====================================');

  console.log('\n📁 Environment Files:');
  console.log(`Working Directory: ${process.cwd()}`);
  console.log(`NODE_ENV: ${process.env.NODE_ENV || 'undefined'}`);

  console.log('\n🔑 Loaded Configuration:');
  console.log(`Anthropic Base URL: ${config.anthropic.baseUrl}`);
  console.log(`Anthropic Auth Token: ${maskValue(config.anthropic.authToken, 8)}`);
  console.log(`GitLab Base URL: ${config.gitlab.baseUrl}`);
  console.log(`GitLab Token: ${maskValue(config.gitlab.token, 8)}`);
  console.log(`Webhook Secret: ${maskValue(config.webhook.secret, 4)}`);
  console.log(`MongoDB URI: ${config.mongodb.uri ? 'SET' : 'NOT SET'}`);
  console.log(`MongoDB Database: ${config.mongodb.dbName || 'NOT SET'}`);
  console.log(`Encryption Key: ${maskValue(config.encryption.key, 6)}`);
  console.log(`Legacy Credentials Ready: ${config.platform.hasLegacyCredentials}`);
  console.log(`Platform Credentials Ready: ${config.platform.hasMongoCredentials}`);
  console.log(`Port: ${config.webhook.port}`);
  console.log(`Work Directory: ${config.workDir}`);
  console.log(`Log Level: ${config.logLevel}`);

  console.log('\n🌐 Raw Environment Variables:');
  const envVars = [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'GITLAB_BASE_URL',
    'GITLAB_TOKEN',
    'WEBHOOK_SECRET',
    'MONGODB_URI',
    'MONGODB_DB',
    'ENCRYPTION_KEY',
    'PORT',
    'WORK_DIR',
    'LOG_LEVEL',
  ];

  envVars.forEach(varName => {
    const value = process.env[varName];
    if (value) {
      const masked =
        varName.includes('TOKEN') ||
        varName.includes('SECRET') ||
        varName.includes('ENCRYPTION') ||
        varName.includes('MONGODB_URI')
          ? '***' + value.slice(-4)
          : value;
      console.log(`${varName}: ${masked}`);
    } else {
      console.log(`${varName}: NOT SET`);
    }
  });

  console.log('\n=====================================');
}

/**
 * Validate that all required configuration is present
 */
export function validateRequiredConfig(): { isValid: boolean; missing: string[] } {
  const missing: string[] = [];
  const legacyReady = config.platform.hasLegacyCredentials;
  const platformReady = config.platform.hasMongoCredentials;

  if (!legacyReady && !platformReady) {
    if (!config.gitlab.token) missing.push('GITLAB_TOKEN');
    if (!config.webhook.secret) missing.push('WEBHOOK_SECRET');
    if (!config.mongodb.uri) missing.push('MONGODB_URI');
    if (!config.mongodb.dbName) missing.push('MONGODB_DB');
    if (!config.encryption.key) missing.push('ENCRYPTION_KEY');
  }

  return {
    isValid: legacyReady || platformReady,
    missing,
  };
}
