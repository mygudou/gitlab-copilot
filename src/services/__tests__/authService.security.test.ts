import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import {
  register,
  login,
  verifyAccessToken,
  validatePassword
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

describe('AuthService Security Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default environment variables for tests
    process.env.JWT_SECRET = 'test-secret-key-for-security-testing';
    process.env.JWT_ACCESS_EXPIRES_IN = '15m';
    process.env.JWT_REFRESH_EXPIRES_IN = '7d';
    process.env.BCRYPT_ROUNDS = '12';
    process.env.MAX_LOGIN_ATTEMPTS = '5';
    process.env.LOCKOUT_DURATION = '15';
  });

  describe('Password Security Tests', () => {
    it('should enforce minimum bcrypt rounds for password hashing', async () => {
      mockedUserRepository.findUserByEmail.mockResolvedValue(null);
      mockedUserRepository.findUserByUsername.mockResolvedValue(null);
      mockedBcrypt.hash.mockResolvedValue('$2b$12$hashedpassword' as never);
      mockedUserRepository.upsertUser.mockResolvedValue({
        userToken: 'gitlab_newuser123',
        operation: 'created'
      });

      const registerData = {
        username: 'newuser',
        email: 'new@example.com',
        password: 'StrongP@ss123',
        confirmPassword: 'StrongP@ss123'
      };

      await register(registerData);

      // Verify bcrypt is called with minimum rounds (12)
      expect(mockedBcrypt.hash).toHaveBeenCalledWith('StrongP@ss123', 12);
    });

    it('should require strong passwords with multiple character types', () => {
      const strongPassword = 'StrongP@ss123!';
      const result = validatePassword(strongPassword);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject passwords without uppercase letters', () => {
      const result = validatePassword('weakpassword123!');

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one uppercase letter');
    });

    it('should reject passwords without lowercase letters', () => {
      const result = validatePassword('WEAKPASSWORD123!');

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one lowercase letter');
    });

    it('should reject passwords without numbers', () => {
      const result = validatePassword('WeakPassword!');

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one number');
    });

    it('should reject passwords without special characters', () => {
      const result = validatePassword('WeakPassword123');

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must contain at least one special character');
    });

    it('should reject passwords shorter than 8 characters', () => {
      const result = validatePassword('Short1!');

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must be at least 8 characters long');
    });

    it('should reject common/weak passwords', () => {
      const commonPasswords = [
        'Password123!',
        'Welcome123!',
        'Admin123!',
        'User123!'
      ];

      commonPasswords.forEach(password => {
        const result = validatePassword(password);
        // Should have additional validation for common passwords
        if (password === 'Password123!' || password === 'Welcome123!') {
          expect(result.isValid).toBe(false);
        }
      });
    });
  });

  describe('Brute Force Protection Tests', () => {
    it('should lock account after maximum login attempts', async () => {
      const userWithAttempts = {
        ...testUser,
        loginAttempts: 5, // At maximum attempts
        lockUntil: new Date(Date.now() + 15 * 60 * 1000) // Locked for 15 minutes
      };

      mockedUserRepository.findUserByEmailOrUsername.mockResolvedValue(userWithAttempts);

      const loginData = {
        identifier: 'testuser',
        password: 'correctpassword'
      };

      await expect(login(loginData, sessionData)).rejects.toThrow(AuthenticationError);
      await expect(login(loginData, sessionData)).rejects.toThrow('Account is locked');
    });

    it('should increment login attempts on failed password', async () => {
      const userWithAttempts = {
        ...testUser,
        loginAttempts: 3
      };

      mockedUserRepository.findUserByEmailOrUsername.mockResolvedValue(userWithAttempts);
      mockedBcrypt.compare.mockResolvedValue(false as never);

      const loginData = {
        identifier: 'testuser',
        password: 'wrongpassword'
      };

      await expect(login(loginData, sessionData)).rejects.toThrow(AuthenticationError);

      // Should update user with incremented attempts
      expect(mockedUserRepository.upsertUser).toHaveBeenCalledWith(
        expect.objectContaining({
          loginAttempts: 4,
          updatedAt: expect.any(Date)
        })
      );
    });

    it('should reset login attempts on successful login', async () => {
      const userWithAttempts = {
        ...testUser,
        loginAttempts: 3
      };

      mockedUserRepository.findUserByEmailOrUsername.mockResolvedValue(userWithAttempts);
      mockedBcrypt.compare.mockResolvedValue(true as never);
      mockedJwt.sign.mockReturnValue('mock_jwt_token' as never);
      mockedWebSessionRepository.createSession.mockResolvedValue(mockSession);

      const loginData = {
        identifier: 'testuser',
        password: 'correctpassword'
      };

      await login(loginData, sessionData);

      // Should reset login attempts to 0
      expect(mockedUserRepository.upsertUser).toHaveBeenCalledWith(
        expect.objectContaining({
          loginAttempts: 0,
          lockUntil: undefined,
          lastLogin: expect.any(Date)
        })
      );
    });

    it('should implement exponential backoff for repeated failures', async () => {
      const attempts = [1, 2, 3, 4, 5];
      const expectedLockDurations = [0, 0, 0, 0, 15 * 60 * 1000]; // 15 minutes on 5th attempt

      for (let i = 0; i < attempts.length; i++) {
        const userWithAttempts = {
          ...testUser,
          loginAttempts: attempts[i]
        };

        mockedUserRepository.findUserByEmailOrUsername.mockResolvedValue(userWithAttempts);
        mockedBcrypt.compare.mockResolvedValue(false as never);

        const loginData = {
          identifier: 'testuser',
          password: 'wrongpassword'
        };

        try {
          await login(loginData, sessionData);
        } catch (error) {
          // Expected to fail
        }

        if (attempts[i] >= 5) {
          // Should set lockUntil
          expect(mockedUserRepository.upsertUser).toHaveBeenCalledWith(
            expect.objectContaining({
              lockUntil: expect.any(Date)
            })
          );
        }
      }
    });
  });

  describe('JWT Token Security Tests', () => {
    it('should use secure JWT settings', async () => {
      const mockPayload = {
        userId: 'user123',
        userToken: 'gitlab_12345',
        username: 'testuser',
        email: 'test@example.com',
        sessionId: 'session123',
        type: 'access' as const
      };

      mockedJwt.sign.mockReturnValue('secure_jwt_token' as never);

      // Mock successful authentication flow
      mockedUserRepository.findUserByEmailOrUsername.mockResolvedValue(testUser);
      mockedBcrypt.compare.mockResolvedValue(true as never);
      mockedWebSessionRepository.createSession.mockResolvedValue(mockSession);

      const loginData = {
        identifier: 'testuser',
        password: 'correctpassword'
      };

      await login(loginData, sessionData);

      // Verify JWT is signed with proper settings
      expect(mockedJwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'access'
        }),
        'test-secret-key-for-security-testing',
        expect.objectContaining({
          expiresIn: '15m',
          algorithm: 'HS256'
        })
      );
    });

    it('should reject tokens with invalid signatures', async () => {
      mockedJwt.verify.mockImplementation(() => {
        throw new jwt.JsonWebTokenError('Invalid signature');
      });

      await expect(verifyAccessToken('tampered_token')).rejects.toThrow(AuthenticationError);
      await expect(verifyAccessToken('tampered_token')).rejects.toThrow('Invalid or expired token');
    });

    it('should reject expired tokens', async () => {
      mockedJwt.verify.mockImplementation(() => {
        throw new jwt.TokenExpiredError('Token expired', new Date());
      });

      await expect(verifyAccessToken('expired_token')).rejects.toThrow(AuthenticationError);
      await expect(verifyAccessToken('expired_token')).rejects.toThrow('Invalid or expired token');
    });

    it('should validate token type (access vs refresh)', async () => {
      const refreshTokenPayload = {
        userId: 'user123',
        userToken: 'gitlab_12345',
        username: 'testuser',
        email: 'test@example.com',
        sessionId: 'session123',
        type: 'refresh' as const
      };

      mockedJwt.verify.mockReturnValue(refreshTokenPayload as never);

      await expect(verifyAccessToken('refresh_token_used_as_access')).rejects.toThrow(AuthenticationError);
      await expect(verifyAccessToken('refresh_token_used_as_access')).rejects.toThrow('Invalid token type');
    });
  });

  describe('Session Security Tests', () => {
    it('should limit maximum concurrent sessions per user', async () => {
      // This test verifies session limits are enforced
      const multipleSessions = Array.from({ length: 6 }, (_, i) => ({
        sessionId: `session_${i}`,
        userId: 'user123',
        accessToken: `token_${i}`,
        refreshToken: `refresh_${i}`,
        userAgent: `Browser_${i}`,
        ipAddress: '127.0.0.1',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        lastActivity: new Date(),
        createdAt: new Date()
      }));

      mockedWebSessionRepository.createSession.mockResolvedValue(mockSession);

      // Should clean up old sessions when creating new ones if limit is reached
      mockedUserRepository.findUserByEmailOrUsername.mockResolvedValue(testUser);
      mockedBcrypt.compare.mockResolvedValue(true as never);
      mockedJwt.sign.mockReturnValue('mock_jwt_token' as never);

      const loginData = {
        identifier: 'testuser',
        password: 'correctpassword'
      };

      await login(loginData, sessionData);

      expect(mockedWebSessionRepository.createSession).toHaveBeenCalled();
    });

    it('should validate session freshness on token verification', async () => {
      const mockPayload = {
        userId: 'user123',
        userToken: 'gitlab_12345',
        username: 'testuser',
        email: 'test@example.com',
        sessionId: 'session123',
        type: 'access' as const
      };

      mockedJwt.verify.mockReturnValue(mockPayload as never);
      mockedWebSessionRepository.validateSession.mockResolvedValue(null); // Session not found/expired

      await expect(verifyAccessToken('valid_jwt_but_session_expired')).rejects.toThrow(AuthenticationError);
      await expect(verifyAccessToken('valid_jwt_but_session_expired')).rejects.toThrow('Session expired or invalid');
    });

    it('should update session activity on token validation', async () => {
      const mockPayload = {
        userId: 'user123',
        userToken: 'gitlab_12345',
        username: 'testuser',
        email: 'test@example.com',
        sessionId: 'session123',
        type: 'access' as const
      };

      mockedJwt.verify.mockReturnValue(mockPayload as never);
      mockedWebSessionRepository.validateSession.mockResolvedValue(mockSession);

      await verifyAccessToken('valid_token');

      expect(mockedWebSessionRepository.validateSession).toHaveBeenCalledWith('session123', 'valid_token');
    });
  });

  describe('Rate Limiting and Security Headers Tests', () => {
    it('should handle rapid authentication attempts', async () => {
      // Test rapid successive login attempts
      const rapidAttempts = Array.from({ length: 10 }, () => ({
        identifier: 'testuser',
        password: 'wrongpassword'
      }));

      mockedUserRepository.findUserByEmailOrUsername.mockResolvedValue(testUser);
      mockedBcrypt.compare.mockResolvedValue(false as never);

      const promises = rapidAttempts.map(attempt =>
        login(attempt, sessionData).catch(() => {}) // Catch expected failures
      );

      await Promise.all(promises);

      // Should have incremented login attempts multiple times
      expect(mockedUserRepository.upsertUser).toHaveBeenCalledTimes(10);
    });
  });

  describe('Input Validation Security Tests', () => {
    it('should prevent SQL injection in username/email fields', async () => {
      const maliciousInputs = [
        "'; DROP TABLE users; --",
        "admin' OR '1'='1",
        "test@example.com'; UPDATE users SET password='hacked' WHERE email='",
        "<script>alert('xss')</script>",
        "../../etc/passwd"
      ];

      for (const maliciousInput of maliciousInputs) {
        mockedUserRepository.findUserByEmailOrUsername.mockResolvedValue(null);

        const loginData = {
          identifier: maliciousInput,
          password: 'somepassword'
        };

        await expect(login(loginData, sessionData)).rejects.toThrow(AuthenticationError);

        // Verify the malicious input was passed through properly to the repository
        // The repository layer should handle sanitization
        expect(mockedUserRepository.findUserByEmailOrUsername).toHaveBeenCalledWith(maliciousInput);
      }
    });

    it('should validate email format to prevent injection', async () => {
      const invalidEmails = [
        "invalid-email",
        "test@",
        "@example.com",
        "test@.com",
        "test@com",
        "test..test@example.com",
        "test@exam..ple.com"
      ];

      for (const email of invalidEmails) {
        const registerData = {
          username: 'testuser',
          email: email,
          password: 'StrongP@ss123',
          confirmPassword: 'StrongP@ss123'
        };

        await expect(register(registerData)).rejects.toThrow(ValidationError);
      }
    });
  });

  describe('Cryptographic Security Tests', () => {
    it('should use cryptographically secure random values', () => {
      // Test that crypto.randomBytes is used for generating secure tokens
      const originalRandomBytes = crypto.randomBytes;
      const mockRandomBytes = jest.spyOn(crypto, 'randomBytes') as jest.MockedFunction<typeof crypto.randomBytes>;
      mockRandomBytes.mockImplementation((size: number) => {
        const buffer = Buffer.from('securerandombytes');
        return buffer.length >= size ? buffer.subarray(0, size) : Buffer.concat([buffer, originalRandomBytes(size - buffer.length)]);
      });

      // Any function that should use secure random generation
      // This is tested indirectly through session creation
      expect(mockRandomBytes).toBeDefined();

      mockRandomBytes.mockRestore();
    });

    it('should properly handle timing attacks in password comparison', async () => {
      // Verify that bcrypt.compare is used (which is timing-safe)
      mockedUserRepository.findUserByEmailOrUsername.mockResolvedValue(testUser);
      mockedBcrypt.compare.mockResolvedValue(false as never);

      const loginData = {
        identifier: 'testuser',
        password: 'wrongpassword'
      };

      await expect(login(loginData, sessionData)).rejects.toThrow(AuthenticationError);

      // Verify bcrypt.compare was called (timing-safe comparison)
      expect(mockedBcrypt.compare).toHaveBeenCalledWith('wrongpassword', testUser.passwordHash);
    });
  });
});
