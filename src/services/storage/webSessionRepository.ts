import crypto from 'crypto';
import type { Collection } from 'mongodb';
import { getMongoDb } from './mongoClient';
import { WebSessionDocument, WebSession, WebSessionData } from '../../types/auth';
import { config } from '../../utils/config';
import logger from '../../utils/logger';

const COLLECTION_NAME = 'web_sessions';

function ensurePlatformMode(): void {
  if (!config.platform.hasMongoCredentials) {
    throw new Error('MongoDB is not configured for platform mode');
  }
}

async function getSessionsCollection(): Promise<Collection<WebSessionDocument>> {
  ensurePlatformMode();
  const db = await getMongoDb();
  return db.collection<WebSessionDocument>(COLLECTION_NAME);
}

function normalizeId(id: unknown, fallback: string): string {
  if (typeof id === 'string') {
    return id;
  }

  if (id && typeof (id as { toString?: () => string }).toString === 'function') {
    try {
      return (id as { toString: () => string }).toString();
    } catch (error) {
      logger.warn('Failed to convert Mongo _id to string', { error });
    }
  }

  return fallback;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateSessionId(): string {
  return crypto.randomUUID();
}

function mapDocumentToSession(doc: WebSessionDocument, accessToken: string, refreshToken: string): WebSession {
  return {
    sessionId: doc.sessionId,
    userId: doc.userId,
    accessToken,
    refreshToken,
    userAgent: doc.userAgent,
    ipAddress: doc.ipAddress,
    expiresAt: doc.expiresAt,
    lastActivity: doc.lastActivity,
    createdAt: doc.createdAt,
  };
}

export async function createSession(
  userId: string,
  accessToken: string,
  refreshToken: string,
  sessionData: WebSessionData,
  expiresIn: number,
  sessionId?: string
): Promise<WebSession> {
  ensurePlatformMode();

  const collection = await getSessionsCollection();
  const now = new Date();
  const finalSessionId = sessionId || generateSessionId();
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);

  const document: Omit<WebSessionDocument, '_id'> = {
    sessionId: finalSessionId,
    userId,
    accessTokenHash: hashToken(accessToken),
    refreshTokenHash: hashToken(refreshToken),
    userAgent: sessionData.userAgent,
    ipAddress: sessionData.ipAddress,
    expiresAt,
    lastActivity: now,
    isActive: true,
    createdAt: now,
  };

  try {
    await collection.insertOne(document);
    return mapDocumentToSession(document, accessToken, refreshToken);
  } catch (error) {
    logger.error('Failed to create web session', {
      userId,
      sessionId: finalSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function validateSession(sessionId: string, accessToken: string): Promise<WebSession | null> {
  if (!config.platform.hasMongoCredentials) {
    return null;
  }

  try {
    const collection = await getSessionsCollection();
    const tokenHash = hashToken(accessToken);
    const now = new Date();

    const doc = await collection.findOne({
      sessionId,
      accessTokenHash: tokenHash,
      isActive: true,
      expiresAt: { $gt: now }
    });

    if (!doc) {
      return null;
    }

    // Update last activity
    await collection.updateOne(
      { sessionId },
      { $set: { lastActivity: now } }
    );

    // Note: We don't have the original tokens, so we return empty strings
    // The calling code should use the tokens from the JWT payload
    return mapDocumentToSession(doc, '', '');
  } catch (error) {
    logger.error('Failed to validate session', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function refreshSession(
  sessionId: string,
  oldRefreshToken: string,
  newAccessToken: string,
  newRefreshToken: string,
  expiresIn: number
): Promise<WebSession | null> {
  ensurePlatformMode();

  try {
    const collection = await getSessionsCollection();
    const oldRefreshTokenHash = hashToken(oldRefreshToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresIn * 1000);

    const result = await collection.findOneAndUpdate(
      {
        sessionId,
        refreshTokenHash: oldRefreshTokenHash,
        isActive: true,
        expiresAt: { $gt: now }
      },
      {
        $set: {
          accessTokenHash: hashToken(newAccessToken),
          refreshTokenHash: hashToken(newRefreshToken),
          expiresAt,
          lastActivity: now
        }
      },
      { returnDocument: 'after' }
    );

    if (!result) {
      return null;
    }

    return mapDocumentToSession(result, newAccessToken, newRefreshToken);
  } catch (error) {
    logger.error('Failed to refresh session', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function destroySession(sessionId: string): Promise<void> {
  if (!config.platform.hasMongoCredentials) {
    return;
  }

  try {
    const collection = await getSessionsCollection();
    await collection.updateOne(
      { sessionId },
      {
        $set: {
          isActive: false,
          lastActivity: new Date()
        }
      }
    );
  } catch (error) {
    logger.error('Failed to destroy session', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function destroyAllUserSessions(userId: string): Promise<void> {
  if (!config.platform.hasMongoCredentials) {
    return;
  }

  try {
    const collection = await getSessionsCollection();
    await collection.updateMany(
      { userId, isActive: true },
      {
        $set: {
          isActive: false,
          lastActivity: new Date()
        }
      }
    );
  } catch (error) {
    logger.error('Failed to destroy all user sessions', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function getUserSessions(userId: string): Promise<WebSession[]> {
  if (!config.platform.hasMongoCredentials) {
    return [];
  }

  try {
    const collection = await getSessionsCollection();
    const now = new Date();

    const docs = await collection.find({
      userId,
      isActive: true,
      expiresAt: { $gt: now }
    })
      .sort({ lastActivity: -1 })
      .toArray();

    // Return sessions without actual tokens for security
    return docs.map((doc: WebSessionDocument) => mapDocumentToSession(doc, '', ''));
  } catch (error) {
    logger.error('Failed to get user sessions', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function cleanupExpiredSessions(): Promise<number> {
  if (!config.platform.hasMongoCredentials) {
    return 0;
  }

  try {
    const collection = await getSessionsCollection();
    const now = new Date();

    const result = await collection.updateMany(
      {
        isActive: true,
        expiresAt: { $lte: now }
      },
      {
        $set: {
          isActive: false,
          lastActivity: now
        }
      }
    );

    if (result.modifiedCount > 0) {
      logger.info('Cleaned up expired sessions', { count: result.modifiedCount });
    }

    return result.modifiedCount;
  } catch (error) {
    logger.error('Failed to cleanup expired sessions', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function getSessionStats(userId: string): Promise<{
  totalSessions: number;
  activeSessions: number;
  expiredSessions: number;
}> {
  if (!config.platform.hasMongoCredentials) {
    return { totalSessions: 0, activeSessions: 0, expiredSessions: 0 };
  }

  try {
    const collection = await getSessionsCollection();
    const now = new Date();

    const [totalSessions, activeSessions, expiredSessions] = await Promise.all([
      collection.countDocuments({ userId }),
      collection.countDocuments({
        userId,
        isActive: true,
        expiresAt: { $gt: now }
      }),
      collection.countDocuments({
        userId,
        isActive: true,
        expiresAt: { $lte: now }
      })
    ]);

    return { totalSessions, activeSessions, expiredSessions };
  } catch (error) {
    logger.error('Failed to get session stats', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}