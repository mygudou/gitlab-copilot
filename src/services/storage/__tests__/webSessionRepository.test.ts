import {
  createSession,
  validateSession,
  refreshSession,
  destroySession,
  destroyAllUserSessions,
  getUserSessions,
  cleanupExpiredSessions,
  getSessionStats
} from '../webSessionRepository';
import { getMongoDb } from '../mongoClient';
import { WebSessionData } from '../../../types/auth';
import { config } from '../../../utils/config';

// Mock dependencies
jest.mock('../mongoClient');
jest.mock('../../../utils/logger');
jest.mock('../../../utils/config', () => ({
  config: {
    platform: {
      hasMongoCredentials: true
    }
  }
}));

const mockedGetMongoDb = getMongoDb as jest.MockedFunction<typeof getMongoDb>;

// Test data
const sessionData: WebSessionData = {
  userAgent: 'Mozilla/5.0 Test Browser',
  ipAddress: '127.0.0.1'
};

const testSession = {
  sessionId: 'session123',
  userId: 'user123',
  accessTokenHash: 'hashed_access_token',
  refreshTokenHash: 'hashed_refresh_token',
  userAgent: sessionData.userAgent,
  ipAddress: sessionData.ipAddress,
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  lastActivity: new Date(),
  isActive: true,
  createdAt: new Date()
};

describe('WebSessionRepository', () => {
  let mockCollection: any;
  let mockDb: any;

  beforeEach(() => {
    jest.clearAllMocks();
    config.platform.hasMongoCredentials = true;

    // Mock MongoDB collection methods
    mockCollection = {
      insertOne: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn(),
      updateMany: jest.fn(),
      find: jest.fn(),
      countDocuments: jest.fn()
    };

    mockDb = {
      collection: jest.fn().mockReturnValue(mockCollection)
    };

    mockedGetMongoDb.mockResolvedValue(mockDb);
  });

  describe('createSession', () => {
    it('should create session successfully', async () => {
      mockCollection.insertOne.mockResolvedValue({ insertedId: 'session_doc_id' });

      const result = await createSession(
        'user123',
        'access_token',
        'refresh_token',
        sessionData,
        900 // 15 minutes
      );

      expect(result.sessionId).toBeDefined();
      expect(result.userId).toBe('user123');
      expect(result.accessToken).toBe('access_token');
      expect(result.refreshToken).toBe('refresh_token');
      expect(result.userAgent).toBe(sessionData.userAgent);
      expect(result.ipAddress).toBe(sessionData.ipAddress);
      expect(mockCollection.insertOne).toHaveBeenCalled();

      const insertedDoc = mockCollection.insertOne.mock.calls[0][0];
      expect(insertedDoc.userId).toBe('user123');
      expect(insertedDoc.isActive).toBe(true);
      expect(insertedDoc.accessTokenHash).toBeDefined();
      expect(insertedDoc.refreshTokenHash).toBeDefined();
    });

    it('should handle database errors', async () => {
      mockCollection.insertOne.mockRejectedValue(new Error('DB error'));

      await expect(createSession('user123', 'token', 'refresh', sessionData, 900))
        .rejects.toThrow('DB error');
    });
  });

  describe('validateSession', () => {
    it('should validate active session successfully', async () => {
      mockCollection.findOne.mockResolvedValue(testSession);
      mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

      const result = await validateSession('session123', 'access_token');

      expect(result).toBeDefined();
      expect(result?.sessionId).toBe('session123');
      expect(result?.userId).toBe('user123');
      expect(mockCollection.findOne).toHaveBeenCalledWith({
        sessionId: 'session123',
        accessTokenHash: expect.any(String),
        isActive: true,
        expiresAt: { $gt: expect.any(Date) }
      });
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { sessionId: 'session123' },
        { $set: { lastActivity: expect.any(Date) } }
      );
    });

    it('should return null for invalid session', async () => {
      mockCollection.findOne.mockResolvedValue(null);

      const result = await validateSession('invalid_session', 'access_token');

      expect(result).toBeNull();
    });

    it('should return null for expired session', async () => {
      const expiredSession = {
        ...testSession,
        expiresAt: new Date(Date.now() - 1000) // 1 second ago
      };
      mockCollection.findOne.mockResolvedValue(expiredSession);

      const result = await validateSession('session123', 'access_token');

      expect(result).toBeNull();
    });
  });

  describe('refreshSession', () => {
    it('should refresh session successfully', async () => {
      const updatedSession = {
        ...testSession,
        accessTokenHash: 'new_access_hash',
        refreshTokenHash: 'new_refresh_hash',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000)
      };

      mockCollection.findOneAndUpdate.mockResolvedValue(updatedSession);

      const result = await refreshSession(
        'session123',
        'old_refresh_token',
        'new_access_token',
        'new_refresh_token',
        900
      );

      expect(result).toBeDefined();
      expect(result?.sessionId).toBe('session123');
      expect(result?.accessToken).toBe('new_access_token');
      expect(result?.refreshToken).toBe('new_refresh_token');
      expect(mockCollection.findOneAndUpdate).toHaveBeenCalledWith(
        {
          sessionId: 'session123',
          refreshTokenHash: expect.any(String),
          isActive: true,
          expiresAt: { $gt: expect.any(Date) }
        },
        {
          $set: {
            accessTokenHash: expect.any(String),
            refreshTokenHash: expect.any(String),
            expiresAt: expect.any(Date),
            lastActivity: expect.any(Date)
          }
        },
        { returnDocument: 'after' }
      );
    });

    it('should return null for invalid refresh token', async () => {
      mockCollection.findOneAndUpdate.mockResolvedValue(null);

      const result = await refreshSession(
        'session123',
        'invalid_refresh',
        'new_access',
        'new_refresh',
        900
      );

      expect(result).toBeNull();
    });
  });

  describe('destroySession', () => {
    it('should destroy session successfully', async () => {
      mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });

      await destroySession('session123');

      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { sessionId: 'session123' },
        {
          $set: {
            isActive: false,
            lastActivity: expect.any(Date)
          }
        }
      );
    });
  });

  describe('destroyAllUserSessions', () => {
    it('should destroy all user sessions successfully', async () => {
      mockCollection.updateMany.mockResolvedValue({ modifiedCount: 3 });

      await destroyAllUserSessions('user123');

      expect(mockCollection.updateMany).toHaveBeenCalledWith(
        { userId: 'user123', isActive: true },
        {
          $set: {
            isActive: false,
            lastActivity: expect.any(Date)
          }
        }
      );
    });
  });

  describe('getUserSessions', () => {
    it('should get user sessions successfully', async () => {
      const mockCursor = {
        sort: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([testSession])
      };
      mockCollection.find.mockReturnValue(mockCursor);

      const result = await getUserSessions('user123');

      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('session123');
      expect(result[0].accessToken).toBe(''); // Should be empty for security
      expect(result[0].refreshToken).toBe(''); // Should be empty for security
      expect(mockCollection.find).toHaveBeenCalledWith({
        userId: 'user123',
        isActive: true,
        expiresAt: { $gt: expect.any(Date) }
      });
    });

    it('should return empty array when no sessions found', async () => {
      const mockCursor = {
        sort: jest.fn().mockReturnThis(),
        toArray: jest.fn().mockResolvedValue([])
      };
      mockCollection.find.mockReturnValue(mockCursor);

      const result = await getUserSessions('user123');

      expect(result).toEqual([]);
    });
  });

  describe('cleanupExpiredSessions', () => {
    it('should cleanup expired sessions successfully', async () => {
      mockCollection.updateMany.mockResolvedValue({ modifiedCount: 5 });

      const result = await cleanupExpiredSessions();

      expect(result).toBe(5);
      expect(mockCollection.updateMany).toHaveBeenCalledWith(
        {
          isActive: true,
          expiresAt: { $lte: expect.any(Date) }
        },
        {
          $set: {
            isActive: false,
            lastActivity: expect.any(Date)
          }
        }
      );
    });

    it('should return 0 when no expired sessions found', async () => {
      mockCollection.updateMany.mockResolvedValue({ modifiedCount: 0 });

      const result = await cleanupExpiredSessions();

      expect(result).toBe(0);
    });
  });

  describe('getSessionStats', () => {
    it('should get session statistics successfully', async () => {
      mockCollection.countDocuments
        .mockResolvedValueOnce(10) // totalSessions
        .mockResolvedValueOnce(7)  // activeSessions
        .mockResolvedValueOnce(2); // expiredSessions

      const result = await getSessionStats('user123');

      expect(result).toEqual({
        totalSessions: 10,
        activeSessions: 7,
        expiredSessions: 2
      });

      expect(mockCollection.countDocuments).toHaveBeenCalledTimes(3);
      expect(mockCollection.countDocuments).toHaveBeenNthCalledWith(1, { userId: 'user123' });
      expect(mockCollection.countDocuments).toHaveBeenNthCalledWith(2, {
        userId: 'user123',
        isActive: true,
        expiresAt: { $gt: expect.any(Date) }
      });
      expect(mockCollection.countDocuments).toHaveBeenNthCalledWith(3, {
        userId: 'user123',
        isActive: true,
        expiresAt: { $lte: expect.any(Date) }
      });
    });
  });

  describe('platform mode disabled', () => {
    beforeEach(() => {
      config.platform.hasMongoCredentials = false;
    });

    it('should return null for validateSession when platform mode disabled', async () => {
      const result = await validateSession('session123', 'token');
      expect(result).toBeNull();
    });

    it('should return empty array for getUserSessions when platform mode disabled', async () => {
      const result = await getUserSessions('user123');
      expect(result).toEqual([]);
    });

    it('should return zero stats when platform mode disabled', async () => {
      const result = await getSessionStats('user123');
      expect(result).toEqual({
        totalSessions: 0,
        activeSessions: 0,
        expiredSessions: 0
      });
    });

    it('should return 0 for cleanupExpiredSessions when platform mode disabled', async () => {
      const result = await cleanupExpiredSessions();
      expect(result).toBe(0);
    });
  });
});
