import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';
import { ProviderType, ProviderSessionInfo, SessionInfo, SpecKitStage } from '../types/session';

type StoredProviderSession = {
  sessionId: string;
  lastUsed: string;
};

type StoredSession = Omit<SessionInfo, 'lastUsed' | 'createdAt' | 'providerSessions'> & {
  lastUsed: string;
  createdAt: string;
  providerSessions?: Partial<Record<ProviderType, StoredProviderSession>>;
  /**
   * Legacy fields for backward compatibility.
   */
  sessionId?: string;
  provider?: ProviderType;
};

export interface SessionStore {
  load(): SessionInfo[];
  persist(sessions: SessionInfo[]): void;
  hasLegacyFormat?(): boolean;
}

function ensureDirectoryExists(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export class FileSessionStore implements SessionStore {
  private readonly filePath: string;
  private legacyFormatDetected = false;

  constructor(filePath: string) {
    this.filePath = filePath;
    ensureDirectoryExists(filePath);
  }

  public load(): SessionInfo[] {
    try {
      if (!fs.existsSync(this.filePath)) {
        return [];
      }

      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) {
        return [];
      }

      const parsed = JSON.parse(raw) as StoredSession[];

      // 检测是否有旧格式数据
      this.legacyFormatDetected = parsed.some(
        session => session.sessionId !== undefined || session.provider !== undefined
      );

      return parsed.map(session => this.convertStoredSession(session));
    } catch (error) {
      logger.error('Failed to load sessions from storage', {
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  public hasLegacyFormat(): boolean {
    return this.legacyFormatDetected;
  }

  public persist(sessions: SessionInfo[]): void {
    try {
      const serialized: StoredSession[] = sessions.map(session => ({
        ...session,
        lastUsed: session.lastUsed.toISOString(),
        createdAt: session.createdAt.toISOString(),
        providerSessions: this.serializeProviderSessions(session.providerSessions),
      }));

      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(serialized, null, 2), 'utf8');
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      logger.error('Failed to persist sessions to storage', {
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private convertStoredSession(session: StoredSession): SessionInfo {
    const providerSessions = this.deserializeProviderSessions(
      session.providerSessions,
      session.sessionId,
      session.provider
    );

    const lastUsed = new Date(session.lastUsed);
    const createdAt = new Date(session.createdAt);

    return {
      issueKey: session.issueKey,
      projectId: session.projectId,
      issueIid: session.issueIid,
      discussionId: session.discussionId,
      createdAt,
      lastUsed,
      lastProvider: session.lastProvider ?? session.provider,
      providerSessions,
      branchName: session.branchName,
      baseBranch: session.baseBranch,
      mergeRequestIid: session.mergeRequestIid,
      mergeRequestUrl: session.mergeRequestUrl,
      ownerId: session.ownerId,
      specKitStage: session.specKitStage,
      specKitDocuments: session.specKitDocuments
        ? (Object.fromEntries(
            (Object.entries(session.specKitDocuments) as Array<[
              SpecKitStage,
              string[] | undefined
            ]>).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])
          ) as Partial<Record<SpecKitStage, string[]>>)
        : undefined,
    };
  }

  private deserializeProviderSessions(
    stored?: Partial<Record<ProviderType, StoredProviderSession>>,
    legacySessionId?: string,
    legacyProvider?: ProviderType
  ): Partial<Record<ProviderType, ProviderSessionInfo>> {
    const result: Partial<Record<ProviderType, ProviderSessionInfo>> = {};

    if (stored) {
      (Object.entries(stored) as Array<[ProviderType, StoredProviderSession | undefined]>).forEach(
        ([provider, info]) => {
          if (info && info.sessionId) {
            result[provider] = {
              sessionId: info.sessionId,
              lastUsed: new Date(info.lastUsed),
            };
          }
        }
      );
    }

    if (legacySessionId && legacyProvider) {
      result[legacyProvider] = {
        sessionId: legacySessionId,
        lastUsed: new Date(),
      };
    }

    return result;
  }

  private serializeProviderSessions(
    providerSessions: Partial<Record<ProviderType, ProviderSessionInfo>>
  ): Partial<Record<ProviderType, StoredProviderSession>> {
    const serialized: Partial<Record<ProviderType, StoredProviderSession>> = {};

    (Object.entries(providerSessions) as Array<[ProviderType, ProviderSessionInfo | undefined]>).forEach(
      ([provider, info]) => {
        if (!info) {
          return;
        }
        serialized[provider] = {
          sessionId: info.sessionId,
          lastUsed: info.lastUsed.toISOString(),
        };
      }
    );

    return serialized;
  }
}
