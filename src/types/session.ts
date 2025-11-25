export type ProviderType = 'claude' | 'codex';

export interface ProviderSessionInfo {
  sessionId: string;
  lastUsed: Date;
}

export type SpecKitStage = 'spec' | 'plan' | 'tasks';

export interface SessionInfo {
  issueKey: string;
  projectId: number;
  issueIid: number;
  discussionId?: string;
  createdAt: Date;
  lastUsed: Date;
  lastProvider?: ProviderType;
  providerSessions: Partial<Record<ProviderType, ProviderSessionInfo>>;
  branchName?: string;
  baseBranch?: string;
  mergeRequestIid?: number;
  mergeRequestUrl?: string;
  ownerId?: string;
  specKitStage?: SpecKitStage;
  specKitDocuments?: Partial<Record<SpecKitStage, string[]>>;
}

export interface SessionManagerConfig {
  maxIdleTime: number; // 毫秒，默认7天
  maxSessions: number; // 最大session数量
  cleanupInterval: number; // 清理间隔，毫秒
  storagePath: string;
}

export interface SessionStats {
  totalSessions: number;
  activeSessions: number;
  expiredSessions: number;
  oldestSession?: Date;
  newestSession?: Date;
}

export type SessionKey = string; // 格式: ownerId?:projectId:issueIid
