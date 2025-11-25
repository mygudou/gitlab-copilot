import {
  ProviderSessionInfo,
  ProviderType,
  SessionInfo,
  SessionManagerConfig,
  SessionStats,
  SessionKey,
  SpecKitStage,
} from '../types/session';
import { config } from '../utils/config';
import logger from '../utils/logger';
import { FileSessionStore, SessionStore } from './sessionStore';

type ProviderEntry = [ProviderType, ProviderSessionInfo];

export class SessionManager {
  private sessions: Map<SessionKey, SessionInfo> = new Map();
  private config: SessionManagerConfig;
  private store: SessionStore;

  constructor(customConfig?: Partial<SessionManagerConfig>, store?: SessionStore) {
    this.config = {
      maxIdleTime: config.session.maxIdleTime,
      maxSessions: config.session.maxSessions,
      cleanupInterval: config.session.cleanupInterval,
      storagePath: config.session.storagePath,
      ...customConfig,
    };

    if (!this.config.storagePath) {
      this.config.storagePath = config.session.storagePath;
    }

    this.store = store || new FileSessionStore(this.config.storagePath);

    const persistedSessions = this.store.load();
    let migratedSessions = 0;
    let removedSessions = 0;
    const hasLegacyFormat = this.store.hasLegacyFormat?.() ?? false;

    for (const session of persistedSessions) {
      const normalizedKey = this.generateSessionKey(session.projectId, session.issueIid, session.ownerId);
      if (session.issueKey !== normalizedKey) {
        migratedSessions++;
      }

      const normalized = this.normalizeSession({ ...session, issueKey: normalizedKey });
      if (normalized) {
        this.sessions.set(normalizedKey, normalized);
      } else {
        removedSessions++;
      }
    }

    if (migratedSessions > 0 || removedSessions > 0 || hasLegacyFormat) {
      this.persistSessions();
    }

    logger.info('SessionManager initialized', {
      maxIdleTime: this.config.maxIdleTime,
      maxSessions: this.config.maxSessions,
      cleanupInterval: this.config.cleanupInterval,
      storagePath: this.config.storagePath,
      loadedSessions: persistedSessions.length,
      activeSessions: this.sessions.size,
      migratedSessions,
      removedSessions,
      legacyFormatMigrated: hasLegacyFormat,
    });
  }

  /**
   * 生成session key
   */
  public generateSessionKey(projectId: number, issueIid: number, ownerId?: string): SessionKey {
    const baseKey = `${projectId}:${issueIid}`;
    return ownerId ? `${ownerId}:${baseKey}` : baseKey;
  }

  private extractOwnerFromKey(issueKey: SessionKey): string | undefined {
    const parts = issueKey.split(':');
    if (parts.length === 3) {
      return parts[0];
    }
    return undefined;
  }

  /**
   * 获取session信息
   */
  public getSession(issueKey: SessionKey): SessionInfo | null {
    const session = this.sessions.get(issueKey);

    if (!session) {
      return null;
    }

    const { active, changed } = this.refreshSession(session);
    if (!active) {
      this.sessions.delete(issueKey);
      this.persistSessions();
      return null;
    }

    if (changed) {
      this.sessions.set(issueKey, session);
      this.persistSessions();
    }

    logger.debug('Session retrieved', {
      issueKey,
      providers: this.getActiveProvidersSummary(session),
    });

    return session;
  }

  /**
   * 查看session但不更新provider的lastUsed
   */
  public peekSession(issueKey: SessionKey): SessionInfo | null {
    const session = this.sessions.get(issueKey);

    if (!session) {
      return null;
    }

    const { active, changed } = this.refreshSession(session);
    if (!active) {
      this.sessions.delete(issueKey);
      this.persistSessions();
      return null;
    }

    if (changed) {
      this.sessions.set(issueKey, session);
      this.persistSessions();
    }

    return session;
  }

  /**
   * 获取指定provider的session
   */
  public getProviderSession(issueKey: SessionKey, provider: ProviderType): ProviderSessionInfo | null {
    const session = this.sessions.get(issueKey);
    if (!session) {
      return null;
    }

    const { active, changed } = this.refreshSession(session);
    if (!active) {
      this.sessions.delete(issueKey);
      this.persistSessions();
      return null;
    }

    const providerSession = session.providerSessions[provider];
    if (!providerSession) {
      if (changed) {
        this.sessions.set(issueKey, session);
        this.persistSessions();
      }
      return null;
    }

    const now = new Date();
    providerSession.lastUsed = now;
    session.lastProvider = provider;
    session.lastUsed = now;

    this.sessions.set(issueKey, session);
    this.persistSessions();

    logger.debug('Provider session retrieved', {
      issueKey,
      provider,
      sessionId: providerSession.sessionId,
    });

    return { ...providerSession };
  }

  /**
   * 设置session信息
   */
  public setSession(
    issueKey: SessionKey,
    sessionId: string,
    issueInfo: {
      projectId: number;
      issueIid: number;
      discussionId?: string;
      branchName?: string;
      baseBranch?: string;
      mergeRequestIid?: number;
      mergeRequestUrl?: string;
      ownerId?: string;
    },
    provider: ProviderType = 'claude'
  ): void {
    const now = new Date();
    const existing = this.sessions.get(issueKey);

    const providerSessions: SessionInfo['providerSessions'] = {
      ...(existing?.providerSessions ?? {}),
      [provider]: {
        sessionId,
        lastUsed: now,
      },
    };

    const sessionInfo: SessionInfo = {
      issueKey,
      projectId: issueInfo.projectId,
      issueIid: issueInfo.issueIid,
      discussionId: issueInfo.discussionId ?? existing?.discussionId,
      createdAt: existing?.createdAt ?? now,
      lastUsed: now,
      lastProvider: provider,
      providerSessions,
      branchName: issueInfo.branchName ?? existing?.branchName,
      baseBranch: issueInfo.baseBranch ?? existing?.baseBranch,
      mergeRequestIid: issueInfo.mergeRequestIid ?? existing?.mergeRequestIid,
      mergeRequestUrl: issueInfo.mergeRequestUrl ?? existing?.mergeRequestUrl,
      ownerId: issueInfo.ownerId ?? existing?.ownerId ?? this.extractOwnerFromKey(issueKey),
      specKitStage: existing?.specKitStage,
      specKitDocuments: existing?.specKitDocuments
        ? (Object.fromEntries(
            (Object.entries(existing.specKitDocuments) as Array<[
              SpecKitStage,
              string[] | undefined
            ]>).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])
          ) as Partial<Record<SpecKitStage, string[]>>)
        : undefined,
    };

    this.updateAggregateDetails(sessionInfo);

    this.sessions.set(issueKey, sessionInfo);

    if (this.sessions.size > this.config.maxSessions) {
      const cleanupCount = Math.max(1, Math.floor(this.config.maxSessions * 0.1));
      this.cleanupOldestSessions(cleanupCount);
    }

    this.persistSessions();

    logger.info('Session stored', {
      issueKey,
      sessionId,
      provider,
      projectId: issueInfo.projectId,
      issueIid: issueInfo.issueIid,
      discussionId: issueInfo.discussionId,
    });
  }

  public updateSpecKitState(issueKey: SessionKey, stage: SpecKitStage, documentPaths: string[]): void {
    const session = this.sessions.get(issueKey);
    if (!session) {
      return;
    }

    const normalizedDocs = Array.from(new Set(documentPaths.map(path => path.trim()).filter(Boolean)));

    session.specKitStage = stage;
    const docsMap = { ...(session.specKitDocuments ?? {}) } as Partial<Record<SpecKitStage, string[]>>;
    if (normalizedDocs.length > 0) {
      docsMap[stage] = [...normalizedDocs];
    } else if (!docsMap[stage]) {
      docsMap[stage] = [];
    }
    session.specKitDocuments = docsMap;
    session.lastUsed = new Date();

    this.sessions.set(issueKey, session);
    this.persistSessions();

    logger.debug('Updated Spec Kit state for session', {
      issueKey,
      stage,
      documents: docsMap[stage]?.length ?? 0,
    });
  }

  /**
   * 检查是否有活跃session
   */
  public hasActiveSession(issueKey: SessionKey, provider?: ProviderType): boolean {
    const session = this.peekSession(issueKey);
    if (!session) {
      return false;
    }

    if (provider) {
      return Boolean(session.providerSessions[provider]);
    }

    return this.getActiveProviderEntries(session).length > 0;
  }

  /**
   * 删除session或指定provider的session
   */
  public removeSession(issueKey: SessionKey, provider?: ProviderType): boolean {
    const session = this.sessions.get(issueKey);
    if (!session) {
      return false;
    }

    if (!provider) {
      this.sessions.delete(issueKey);
      this.persistSessions();
      logger.info('Session removed', { issueKey });
      return true;
    }

    if (!session.providerSessions[provider]) {
      return false;
    }

    delete session.providerSessions[provider];
    const hasProviders = this.getActiveProviderEntries(session).length > 0;

    if (hasProviders) {
      this.updateAggregateDetails(session);
      if (session.lastProvider === provider) {
        session.lastProvider = this.getActiveProviderEntries(session)[0]?.[0];
      }
      this.sessions.set(issueKey, session);
    } else {
      this.sessions.delete(issueKey);
    }

    this.persistSessions();

    logger.info('Provider session removed', {
      issueKey,
      provider,
      remainingProviders: hasProviders ? this.getActiveProvidersSummary(session) : [],
    });

    return true;
  }

  /**
   * 清理过期的session
   */
  public cleanExpiredSessions(maxAge?: number): number {
    const ageThreshold = maxAge ?? this.config.maxIdleTime;
    const now = Date.now();
    let removedSessions = 0;
    let changed = false;

    for (const [key, session] of Array.from(this.sessions.entries())) {
      const { active, changed: sessionChanged } = this.refreshSession(session, ageThreshold, now);
      if (!active) {
        this.sessions.delete(key);
        removedSessions++;
        changed = true;
        logger.debug('Expired session cleaned', { issueKey: key });
        continue;
      }

      if (sessionChanged) {
        this.sessions.set(key, session);
        changed = true;
      }
    }

    if (changed) {
      this.persistSessions();
      logger.info('Expired sessions cleanup completed', {
        removedSessions,
        remainingCount: this.sessions.size,
      });
    }

    return removedSessions;
  }

  /**
   * 清理最旧的sessions
   */
  private cleanupOldestSessions(count: number): void {
    const sessions = Array.from(this.sessions.entries()).sort(
      ([, a], [, b]) => a.lastUsed.getTime() - b.lastUsed.getTime()
    );

    const toRemove = sessions.slice(0, count);
    for (const [key] of toRemove) {
      this.sessions.delete(key);
      logger.debug('Oldest session removed', { issueKey: key });
    }
  }

  /**
   * 检查session是否过期
   */
  private isSessionExpired(session: SessionInfo): boolean {
    const activeEntries = this.getActiveProviderEntries(session);
    if (activeEntries.length === 0) {
      return true;
    }

    const latest = activeEntries.reduce((latestDate, [, info]) => {
      return info.lastUsed > latestDate ? info.lastUsed : latestDate;
    }, activeEntries[0][1].lastUsed);

    return Date.now() - latest.getTime() > this.config.maxIdleTime;
  }

  /**
   * 获取session统计信息
   */
  public getStats(): SessionStats {
    this.cleanExpiredSessions();

    let activeSessions = 0;
    let expiredSessions = 0;
    let oldestDate: Date | undefined;
    let newestDate: Date | undefined;

    for (const session of this.sessions.values()) {
      if (this.getActiveProviderEntries(session).length > 0) {
        activeSessions++;
      } else {
        expiredSessions++;
      }

      if (!oldestDate || session.createdAt < oldestDate) {
        oldestDate = session.createdAt;
      }

      if (!newestDate || session.createdAt > newestDate) {
        newestDate = session.createdAt;
      }
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions,
      expiredSessions,
      oldestSession: oldestDate,
      newestSession: newestDate,
    };
  }

  /**
   * 获取所有session信息（用于调试）
   */
  public getAllSessions(): SessionInfo[] {
    this.cleanExpiredSessions();
    return Array.from(this.sessions.values()).map(session => ({
      ...session,
      providerSessions: { ...session.providerSessions },
    }));
  }

  /**
   * 清空所有session（用于测试）
   */
  public clearAllSessions(): void {
    const count = this.sessions.size;
    this.sessions.clear();
    this.persistSessions();
    logger.info('All sessions cleared', { clearedCount: count });
  }

  private persistSessions(): void {
    this.store.persist(Array.from(this.sessions.values()));
  }

  private refreshSession(
    session: SessionInfo,
    ageThreshold: number = this.config.maxIdleTime,
    now: number = Date.now()
  ): { active: boolean; changed: boolean } {
    let changed = this.removeInvalidProviderSessions(session);

    const entries = this.getActiveProviderEntries(session);
    for (const [provider, info] of entries) {
      if (now - info.lastUsed.getTime() > ageThreshold) {
        delete session.providerSessions[provider];
        changed = true;
        logger.debug('Provider session expired, removing', {
          issueKey: session.issueKey,
          provider,
          lastUsed: info.lastUsed,
        });
      }
    }

    const activeEntries = this.getActiveProviderEntries(session);
    if (activeEntries.length === 0) {
      session.lastProvider = undefined;
      return { active: false, changed };
    }

    const previousLastUsed = session.lastUsed?.getTime?.() ?? 0;
    const previousLastProvider = session.lastProvider;

    this.updateAggregateDetails(session, activeEntries);

    if (
      session.lastProvider !== previousLastProvider ||
      session.lastUsed.getTime() !== previousLastUsed
    ) {
      changed = true;
    }

    return { active: true, changed };
  }

  private updateAggregateDetails(session: SessionInfo, entries?: ProviderEntry[]): void {
    const activeEntries = entries ?? this.getActiveProviderEntries(session);
    if (activeEntries.length === 0) {
      session.lastUsed = session.createdAt;
      session.lastProvider = undefined;
      return;
    }

    let latestEntry = activeEntries[0];
    for (const entry of activeEntries) {
      if (entry[1].lastUsed > latestEntry[1].lastUsed) {
        latestEntry = entry;
      }
    }

    session.lastProvider = latestEntry[0];
    session.lastUsed = latestEntry[1].lastUsed;
  }

  private getActiveProviderEntries(session: SessionInfo): ProviderEntry[] {
    return (Object.entries(session.providerSessions) as Array<[ProviderType, ProviderSessionInfo | undefined]>)
      .filter(([, info]) => Boolean(info && info.sessionId))
      .map(([provider, info]) => [provider, info!] as ProviderEntry);
  }

  private removeInvalidProviderSessions(session: SessionInfo): boolean {
    let changed = false;

    for (const [provider, info] of Object.entries(session.providerSessions) as Array<
      [ProviderType, ProviderSessionInfo | undefined]
    >) {
      if (!info || !info.sessionId) {
        delete session.providerSessions[provider];
        changed = true;
        continue;
      }

      if (!(info.lastUsed instanceof Date)) {
        info.lastUsed = new Date(info.lastUsed);
      }
    }

    return changed;
  }

  private normalizeSession(session: SessionInfo): SessionInfo | null {
    const normalized: SessionInfo = {
      ...session,
      providerSessions: { ...session.providerSessions },
    };

    const { active } = this.refreshSession(normalized);
    if (!active) {
      return null;
    }

    return normalized;
  }

  private getActiveProvidersSummary(session: SessionInfo): ProviderType[] {
    return this.getActiveProviderEntries(session).map(([provider]) => provider);
  }
}
