import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import {
  authenticateJWT,
  optionalJWT,
  requireUserAccess,
  addRequestId,
  configureCORS,
  sendErrorResponse
} from '../auth';
import { verifyAccessToken } from '../../services/authService';

// Mock the authService
jest.mock('../../services/authService');
jest.mock('../../utils/logger');

const mockedVerifyAccessToken = verifyAccessToken as jest.MockedFunction<typeof verifyAccessToken>;

describe('Auth Middleware', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    jest.clearAllMocks();
  });

  describe('addRequestId', () => {
    it('should add request ID to all requests', async () => {
      app.use(addRequestId);
      app.get('/test', (req, res) => {
        res.json({ requestId: req.requestId });
      });

      const response = await request(app).get('/test');

      expect(response.status).toBe(200);
      expect(response.body.requestId).toBeDefined();
      expect(response.headers['x-request-id']).toBeDefined();
    });
  });

  describe('configureCORS', () => {
    it('should set CORS headers for allowed origins', async () => {
      process.env.CORS_ORIGINS = 'http://localhost:3000,https://example.com';

      app.use(configureCORS);
      app.get('/test', (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .get('/test')
        .set('Origin', 'http://localhost:3000');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(response.headers['access-control-allow-methods']).toBeDefined();
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    it('should handle OPTIONS preflight requests', async () => {
      app.use(configureCORS);
      app.get('/test', (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).options('/test');

      expect(response.status).toBe(200);
    });
  });

  describe('authenticateJWT', () => {
    it('should authenticate valid token and add user to request', async () => {
      const mockPayload = {
        userId: 'user123',
        userToken: 'token123',
        username: 'testuser',
        email: 'test@example.com',
        sessionId: 'session123',
        type: 'access' as const
      };

      mockedVerifyAccessToken.mockResolvedValue(mockPayload);

      app.use(authenticateJWT);
      app.get('/test', (req, res) => {
        res.json({ user: req.user });
      });

      const response = await request(app)
        .get('/test')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body.user).toEqual({
        userId: 'user123',
        userToken: 'token123',
        username: 'testuser',
        email: 'test@example.com',
        sessionId: 'session123'
      });
      expect(mockedVerifyAccessToken).toHaveBeenCalledWith('valid-token');
    });

    it('should return 401 for missing authorization header', async () => {
      app.use(authenticateJWT);
      app.get('/test', (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).get('/test');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('AuthenticationError');
      expect(response.body.error.code).toBe('MISSING_TOKEN');
    });

    it('should return 401 for invalid authorization header format', async () => {
      app.use(authenticateJWT);
      app.get('/test', (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .get('/test')
        .set('Authorization', 'Invalid token-format');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('AuthenticationError');
      expect(response.body.error.code).toBe('MISSING_TOKEN');
    });

    it('should return 401 for invalid token', async () => {
      mockedVerifyAccessToken.mockRejectedValue(new Error('Invalid token'));

      app.use(authenticateJWT);
      app.get('/test', (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app)
        .get('/test')
        .set('Authorization', 'Bearer invalid-token');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('AuthenticationError');
    });
  });

  describe('optionalJWT', () => {
    it('should authenticate valid token and add user to request', async () => {
      const mockPayload = {
        userId: 'user123',
        userToken: 'token123',
        username: 'testuser',
        email: 'test@example.com',
        sessionId: 'session123',
        type: 'access' as const
      };

      mockedVerifyAccessToken.mockResolvedValue(mockPayload);

      app.use(optionalJWT);
      app.get('/test', (req, res) => {
        res.json({ user: req.user || null });
      });

      const response = await request(app)
        .get('/test')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body.user).toEqual({
        userId: 'user123',
        userToken: 'token123',
        username: 'testuser',
        email: 'test@example.com',
        sessionId: 'session123'
      });
    });

    it('should continue without user info when no token provided', async () => {
      app.use(optionalJWT);
      app.get('/test', (req, res) => {
        res.json({ user: req.user || null });
      });

      const response = await request(app).get('/test');

      expect(response.status).toBe(200);
      expect(response.body.user).toBe(null);
    });

    it('should continue without user info when invalid token provided', async () => {
      mockedVerifyAccessToken.mockRejectedValue(new Error('Invalid token'));

      app.use(optionalJWT);
      app.get('/test', (req, res) => {
        res.json({ user: req.user || null });
      });

      const response = await request(app)
        .get('/test')
        .set('Authorization', 'Bearer invalid-token');

      expect(response.status).toBe(200);
      expect(response.body.user).toBe(null);
    });
  });

  describe('requireUserAccess', () => {
    it('should allow access when user ID matches', async () => {
      app.use((req, res, next) => {
        req.user = {
          userId: 'user123',
          userToken: 'token123',
          username: 'testuser',
          email: 'test@example.com',
          sessionId: 'session123'
        };
        next();
      });
      app.use('/users/:userId', requireUserAccess);
      app.get('/users/:userId', (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).get('/users/user123');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should deny access when user ID does not match', async () => {
      app.use((req, res, next) => {
        req.user = {
          userId: 'user123',
          userToken: 'token123',
          username: 'testuser',
          email: 'test@example.com',
          sessionId: 'session123'
        };
        next();
      });
      app.use('/users/:userId', requireUserAccess);
      app.get('/users/:userId', (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).get('/users/other-user');

      expect(response.status).toBe(403);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('AuthorizationError');
      expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('should return 401 when user is not authenticated', async () => {
      app.use('/users/:userId', requireUserAccess);
      app.get('/users/:userId', (req, res) => {
        res.json({ success: true });
      });

      const response = await request(app).get('/users/user123');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('AuthenticationError');
      expect(response.body.error.code).toBe('NOT_AUTHENTICATED');
    });
  });

  describe('sendErrorResponse', () => {
    it('should send standardized error response', async () => {
      app.get('/test', (req, res) => {
        sendErrorResponse(res, {
          type: 'ValidationError',
          message: 'Test error',
          code: 'TEST_ERROR',
          field: 'testField'
        }, 400, 'req123');
      });

      const response = await request(app).get('/test');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        success: false,
        error: {
          type: 'ValidationError',
          message: 'Test error',
          code: 'TEST_ERROR',
          field: 'testField'
        },
        timestamp: expect.any(String),
        requestId: 'req123'
      });
    });
  });
});