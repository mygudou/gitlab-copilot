import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import {
  register,
  login,
  logout,
  refreshTokens,
  verifyAccessToken,
  validatePassword,
  validateEmail,
  validateUsername,
  logoutAllSessions
} from '../authService';
import { AuthenticationError, ValidationError } from '../../types/auth';
import * as userRepository from '../storage/userRepository';
import * as webSessionRepository from '../storage/webSessionRepository';

// Mock dependencies
jest.mock('bcrypt');
jest.mock('jsonwebtoken');
jest.mock('../storage/userRepository');
jest.mock('../storage/webSessionRepository');
jest.mock('../../utils/logger');

const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;
const mockedJwt = jwt as jest.Mocked<typeof jwt>;
const mockedUserRepository = userRepository as jest.Mocked<typeof userRepository>;
const mockedWebSessionRepository = webSessionRepository as jest.Mocked<typeof webSessionRepository>;

// Test data
const testUser = {
  _id: 'user123',
  userToken: 'gitlab_12345',
  username: 'testuser',
  email: 'test@example.com',
  passwordHash: '$2b$12$hashedpassword',
  displayName: 'Test User',
  encryptedPat: 'encrypted_pat',
  encryptedWebhookSecret: 'encrypted_secret',
  isEmailVerified: true,
  loginAttempts: 0,
  createdAt: new Date(),
  updatedAt: new Date()
};

const sessionData = {
  userAgent: 'Mozilla/5.0 Test Browser',
  ipAddress: '127.0.0.1'
};

const mockSession = {
  sessionId: 'session123',
  userId: 'user123',
  accessToken: 'access_token',
  refreshToken: 'refresh_token',
  userAgent: sessionData.userAgent,
  ipAddress: sessionData.ipAddress,
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  lastActivity: new Date(),
  createdAt: new Date()
};

describe('AuthService', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default environment variables for tests
    process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
    process.env.JWT_ACCESS_EXPIRES_IN = '15m';
    process.env.JWT_REFRESH_EXPIRES_IN = '7d';
    process.env.BCRYPT_ROUNDS = '12';
    process.env.MAX_LOGIN_ATTEMPTS = '5';
    process.env.LOCKOUT_DURATION = '15';
  });

  describe('validatePassword', () => {
    it('should validate strong password', () => {
      const result = validatePassword('StrongP@ss123');
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject password without uppercase', () => {
      const result = validatePassword('weakp@ss123');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one uppercase letter');
    });

    it('should reject password without lowercase', () => {
      const result = validatePassword('STRONGP@SS123');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one lowercase letter');
    });

    it('should reject password without numbers', () => {
      const result = validatePassword('StrongP@ss');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one number');
    });

    it('should reject password without special characters', () => {
      const result = validatePassword('StrongPass123');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one special character');
    });

    it('should reject short password', () => {
      const result = validatePassword('Short1!');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must be at least 8 characters long');
    });
  });

  describe('validateEmail', () => {
    it('should validate unique email', async () => {
      mockedUserRepository.findUserByEmail.mockResolvedValue(null);

      const result = await validateEmail('new@example.com');
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject invalid email format', async () => {
      const result = await validateEmail('invalid-email');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Invalid email format');
    });

    it('should reject already registered email', async () => {
      mockedUserRepository.findUserByEmail.mockResolvedValue(testUser);

      const result = await validateEmail('test@example.com');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Email is already registered');
    });
  });

  describe('validateUsername', () => {
    it('should validate unique username', async () => {
      mockedUserRepository.findUserByUsername.mockResolvedValue(null);

      const result = await validateUsername('newuser');
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject short username', async () => {
      const result = await validateUsername('ab');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Username must be at least 3 characters long');
    });

    it('should reject long username', async () => {
      const result = await validateUsername('a'.repeat(31));
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Username must be no more than 30 characters long');
    });

    it('should reject username with invalid characters', async () => {
      const result = await validateUsername('user@name');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Username can only contain letters, numbers, underscores, and hyphens');
    });

    it('should reject already taken username', async () => {
      mockedUserRepository.findUserByUsername.mockResolvedValue(testUser);

      const result = await validateUsername('testuser');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Username is already taken');
    });
  });

  describe('register', () => {
    const registerData = {
      username: 'newuser',
      email: 'new@example.com',
      password: 'StrongP@ss123',
      confirmPassword: 'StrongP@ss123'
    };

    beforeEach(() => {
      mockedUserRepository.findUserByEmail.mockResolvedValue(null);
      mockedUserRepository.findUserByUsername.mockResolvedValue(null);
      mockedBcrypt.hash.mockResolvedValue('$2b$12$hashedpassword' as never);
      mockedUserRepository.upsertUser.mockResolvedValue({
        userToken: 'gitlab_newuser123',
        operation: 'created'
      });
    });

    it('should register new user successfully', async () => {
      const result = await register(registerData);

      expect(result.success).toBe(true);
      expect(result.userToken).toBe('gitlab_newuser123');
      expect(result.message).toContain('Registration successful');
      expect(mockedBcrypt.hash).toHaveBeenCalledWith('StrongP@ss123', 12);
      expect(mockedUserRepository.upsertUser).toHaveBeenCalled();
    });

    it('should reject mismatched passwords', async () => {
      const data = { ...registerData, confirmPassword: 'Different123!' };

      await expect(register(data)).rejects.toThrow(ValidationError);
      await expect(register(data)).rejects.toThrow('Passwords do not match');
    });

    it('should reject weak password', async () => {
      const data = { ...registerData, password: 'weak', confirmPassword: 'weak' };

      await expect(register(data)).rejects.toThrow(ValidationError);
    });

    it('should reject existing email', async () => {
      mockedUserRepository.findUserByEmail.mockResolvedValue(testUser);

      await expect(register(registerData)).rejects.toThrow(ValidationError);
      await expect(register(registerData)).rejects.toThrow('Email is already registered');
    });

    it('should reject existing username', async () => {
      mockedUserRepository.findUserByUsername.mockResolvedValue(testUser);

      await expect(register(registerData)).rejects.toThrow(ValidationError);
      await expect(register(registerData)).rejects.toThrow('Username is already taken');
    });
  });

  describe('login', () => {
    const loginData = {
      identifier: 'testuser',
      password: 'StrongP@ss123'
    };

    beforeEach(() => {
      mockedUserRepository.findUserByEmailOrUsername.mockResolvedValue(testUser);
      mockedBcrypt.compare.mockResolvedValue(true as never);
      mockedJwt.sign.mockReturnValue('mock_jwt_token' as never);
      mockedWebSessionRepository.createSession.mockResolvedValue(mockSession);
    });

    it('should login user successfully', async () => {
      const result = await login(loginData, sessionData);

      expect(result.success).toBe(true);
      expect(result.accessToken).toBe('mock_jwt_token');
      expect(result.refreshToken).toBe('mock_jwt_token');
      expect(result.user.username).toBe('testuser');
      expect(mockedBcrypt.compare).toHaveBeenCalledWith('StrongP@ss123', testUser.passwordHash);
      expect(mockedWebSessionRepository.createSession).toHaveBeenCalled();
    });

    it('should reject invalid user', async () => {
      mockedUserRepository.findUserByEmailOrUsername.mockResolvedValue(null);

      await expect(login(loginData, sessionData)).rejects.toThrow(AuthenticationError);
      await expect(login(loginData, sessionData)).rejects.toThrow('Invalid credentials');
    });

    it('should reject invalid password', async () => {
      mockedBcrypt.compare.mockResolvedValue(false as never);

      await expect(login(loginData, sessionData)).rejects.toThrow(AuthenticationError);
      await expect(login(loginData, sessionData)).rejects.toThrow('Invalid credentials');
    });

    it('should reject locked account', async () => {
      const lockedUser = {
        ...testUser,
        lockUntil: new Date(Date.now() + 10 * 60 * 1000) // 10 minutes from now
      };
      mockedUserRepository.findUserByEmailOrUsername.mockResolvedValue(lockedUser);

      await expect(login(loginData, sessionData)).rejects.toThrow(AuthenticationError);
      await expect(login(loginData, sessionData)).rejects.toThrow('Account is locked');
    });
  });

  describe('logout', () => {
    it('should logout successfully', async () => {
      mockedWebSessionRepository.destroySession.mockResolvedValue();

      await logout('session123');

      expect(mockedWebSessionRepository.destroySession).toHaveBeenCalledWith('session123');
    });

    it('should handle logout error', async () => {
      mockedWebSessionRepository.destroySession.mockRejectedValue(new Error('DB error'));

      await expect(logout('session123')).rejects.toThrow(AuthenticationError);
    });
  });

  describe('refreshTokens', () => {
    const mockPayload = {
      userId: 'user123',
      userToken: 'gitlab_12345',
      username: 'testuser',
      email: 'test@example.com',
      sessionId: 'session123',
      type: 'refresh' as const
    };

    beforeEach(() => {
      mockedJwt.verify.mockReturnValue(mockPayload as never);
      mockedUserRepository.findUserByEmailOrUsername.mockResolvedValue(testUser);
      mockedJwt.sign.mockReturnValue('new_token' as never);
      mockedWebSessionRepository.refreshSession.mockResolvedValue(mockSession);
    });

    it('should refresh tokens successfully', async () => {
      const result = await refreshTokens('old_refresh_token');

      expect(result.accessToken).toBe('new_token');
      expect(result.refreshToken).toBe('new_token');
      expect(mockedJwt.verify).toHaveBeenCalledWith('old_refresh_token', expect.any(String), expect.any(Object));
      const [, usedSecret] = mockedJwt.verify.mock.calls[0];
      expect(typeof usedSecret).toBe('string');
      expect((usedSecret as string).length).toBeGreaterThan(0);
      expect(mockedWebSessionRepository.refreshSession).toHaveBeenCalled();
    });

    it('should reject invalid token', async () => {
      mockedJwt.verify.mockImplementation(() => {
        throw new jwt.JsonWebTokenError('Invalid token');
      });

      await expect(refreshTokens('invalid_token')).rejects.toThrow(AuthenticationError);
      await expect(refreshTokens('invalid_token')).rejects.toThrow('Invalid or expired token');
    });

    it('should reject access token type', async () => {
      mockedJwt.verify.mockReturnValue({ ...mockPayload, type: 'access' } as never);

      await expect(refreshTokens('access_token')).rejects.toThrow(AuthenticationError);
      await expect(refreshTokens('access_token')).rejects.toThrow('Invalid token type');
    });

    it('should reject if user not found', async () => {
      mockedUserRepository.findUserByEmailOrUsername.mockResolvedValue(null);

      await expect(refreshTokens('refresh_token')).rejects.toThrow(AuthenticationError);
      await expect(refreshTokens('refresh_token')).rejects.toThrow('User not found');
    });

    it('should reject if session not found', async () => {
      mockedWebSessionRepository.refreshSession.mockResolvedValue(null);

      await expect(refreshTokens('refresh_token')).rejects.toThrow(AuthenticationError);
      await expect(refreshTokens('refresh_token')).rejects.toThrow('Session not found or expired');
    });
  });

  describe('verifyAccessToken', () => {
    const mockPayload = {
      userId: 'user123',
      userToken: 'gitlab_12345',
      username: 'testuser',
      email: 'test@example.com',
      sessionId: 'session123',
      type: 'access' as const
    };

    beforeEach(() => {
      mockedJwt.verify.mockReturnValue(mockPayload as never);
      mockedWebSessionRepository.validateSession.mockResolvedValue(mockSession);
    });

    it('should verify access token successfully', async () => {
      const result = await verifyAccessToken('access_token');

      expect(result).toEqual(mockPayload);
      expect(mockedJwt.verify).toHaveBeenCalledWith('access_token', expect.any(String), expect.any(Object));
      expect(mockedWebSessionRepository.validateSession).toHaveBeenCalledWith('session123', 'access_token');
    });

    it('should reject invalid token', async () => {
      mockedJwt.verify.mockImplementation(() => {
        throw new jwt.JsonWebTokenError('Invalid token');
      });

      await expect(verifyAccessToken('invalid_token')).rejects.toThrow(AuthenticationError);
      await expect(verifyAccessToken('invalid_token')).rejects.toThrow('Invalid or expired token');
    });

    it('should reject refresh token type', async () => {
      mockedJwt.verify.mockReturnValue({ ...mockPayload, type: 'refresh' } as never);

      await expect(verifyAccessToken('refresh_token')).rejects.toThrow(AuthenticationError);
      await expect(verifyAccessToken('refresh_token')).rejects.toThrow('Invalid token type');
    });

    it('should reject if session expired', async () => {
      mockedWebSessionRepository.validateSession.mockResolvedValue(null);

      await expect(verifyAccessToken('access_token')).rejects.toThrow(AuthenticationError);
      await expect(verifyAccessToken('access_token')).rejects.toThrow('Session expired or invalid');
    });
  });

  describe('logoutAllSessions', () => {
    it('should logout all sessions successfully', async () => {
      mockedWebSessionRepository.destroyAllUserSessions.mockResolvedValue();

      await logoutAllSessions('user123');

      expect(mockedWebSessionRepository.destroyAllUserSessions).toHaveBeenCalledWith('user123');
    });

    it('should handle error when logging out all sessions', async () => {
      mockedWebSessionRepository.destroyAllUserSessions.mockRejectedValue(new Error('DB error'));

      await expect(logoutAllSessions('user123')).rejects.toThrow(AuthenticationError);
    });
  });
});
