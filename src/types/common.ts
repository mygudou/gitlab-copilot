export interface Config {
  anthropic: {
    baseUrl: string;
    authToken?: string;
  };
  ai: {
    executor: 'claude' | 'codex';
    displayName: string;
    codeReviewExecutor: 'claude' | 'codex';
  };
  gitlab: {
    baseUrl: string;
    token: string;
  };
  webhook: {
    secret: string;
    port: number;
  };
  mongodb: {
    uri: string;
    dbName: string;
  };
  encryption: {
    key: string;
  };
  platform: {
    hasLegacyCredentials: boolean;
    hasMongoCredentials: boolean;
  };
  session: {
    enabled: boolean;
    maxIdleTime: number;
    maxSessions: number;
    cleanupInterval: number;
    storagePath: string;
  };
  workspace: {
    maxIdleTime: number;
    cleanupInterval: number;
  };
  workDir: string;
  logLevel: string;
}

export interface ProcessResult {
  success: boolean;
  output?: string;
  error?: string;
  changes?: FileChange[];
}

export interface FileChange {
  path: string;
  type: 'modified' | 'created' | 'deleted';
  diff?: string;
}
