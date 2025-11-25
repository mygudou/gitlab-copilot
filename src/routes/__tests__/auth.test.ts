import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import authRouter from '../auth';
import { register, login, logout, refreshTokens } from '../../services/authService';
import { AuthenticationError, ValidationError } from '../../types/auth';

// Mock the auth service
jest.mock('../../services/authService');
jest.mock('../../utils/logger');

const mockedRegister = register as jest.MockedFunction<typeof register>;
const mockedLogin = login as jest.MockedFunction<typeof login>;
const mockedLogout = logout as jest.MockedFunction<typeof logout>;
const mockedRefreshTokens = refreshTokens as jest.MockedFunction<typeof refreshTokens>;

describe('Auth Routes', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/auth', authRouter);
    jest.clearAllMocks();
  });

  describe('POST /auth/register', () => {
    it('should register a new user successfully', async () => {
      const mockResponse = {
        success: true,
        userToken: 'user_token_123',
        message: 'Registration successful. Please verify your email address.'
      };

      mockedRegister.mockResolvedValue(mockResponse);

      const validData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'StrongPassword123!',
        confirmPassword: 'StrongPassword123!'
      };

      const response = await request(app)
        .post('/auth/register')
        .send(validData);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(response.body.data.userToken).toBe('user_token_123');
      expect(response.body.data.message).toBe('Registration successful. Please verify your email address.');
      expect(response.body.requestId).toBeDefined();
      expect(response.body.timestamp).toBeDefined();

      expect(mockedRegister).toHaveBeenCalledWith(validData);
    });

    it('should return 400 for validation errors', async () => {
      const invalidData = {
        username: 'ab', // Too short
        email: 'invalid-email',
        password: 'weak',
        confirmPassword: 'different'
      };

      const response = await request(app)
        .post('/auth/register')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('ValidationError');
      expect(response.body.error.details.errors).toBeDefined();
    });

    it('should handle registration service errors', async () => {
      mockedRegister.mockRejectedValue(new ValidationError('Email already exists', 'email'));

      const validData = {
        username: 'testuser',
        email: 'test@example.com',
        password: 'StrongPassword123!',
        confirmPassword: 'StrongPassword123!'
      };

      const response = await request(app)
        .post('/auth/register')
        .send(validData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('ValidationError');
      expect(response.body.error.field).toBe('email');
    });
  });

  describe('POST /auth/login', () => {
    it('should login user successfully', async () => {
      const mockResponse = {
        success: true,
        accessToken: 'access_token_123',
        refreshToken: 'refresh_token_123',
        expiresIn: 900,
        user: {
          id: 'user123',
          username: 'testuser',
          email: 'test@example.com',
          displayName: 'Test User'
        }
      };

      mockedLogin.mockResolvedValue(mockResponse);

      const validData = {
        identifier: 'testuser',
        password: 'password'
      };

      const response = await request(app)
        .post('/auth/login')
        .send(validData);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.user).toEqual(mockResponse.user);
      expect(response.body.data.expiresIn).toBe(900);
      expect(response.body.requestId).toBeDefined();
      expect(response.body.timestamp).toBeDefined();

      // Check that cookies are set
      expect(response.headers['set-cookie']).toBeDefined();
      const cookies = response.headers['set-cookie'];
      expect(cookies.some((cookie: string) => cookie.startsWith('accessToken='))).toBe(true);
      expect(cookies.some((cookie: string) => cookie.startsWith('refreshToken='))).toBe(true);

      expect(mockedLogin).toHaveBeenCalledWith(validData, expect.objectContaining({
        userAgent: expect.any(String),
        ipAddress: expect.any(String)
      }));
    });

    it('should return 400 for validation errors', async () => {
      const invalidData = {
        password: 'password'
        // Missing identifier
      };

      const response = await request(app)
        .post('/auth/login')
        .send(invalidData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('ValidationError');
    });

    it('should handle authentication errors', async () => {
      mockedLogin.mockRejectedValue(new AuthenticationError('Invalid credentials', 'INVALID_CREDENTIALS'));

      const validData = {
        identifier: 'testuser',
        password: 'wrongpassword'
      };

      const response = await request(app)
        .post('/auth/login')
        .send(validData);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('AuthenticationError');
      expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('POST /auth/logout', () => {
    it('should logout user successfully', async () => {
      mockedLogout.mockResolvedValue();

      const response = await request(app)
        .post('/auth/logout')
        .set('Authorization', 'Bearer valid_token')
        .send();

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.message).toBe('Logged out successfully');

      // Check that cookies are cleared
      expect(response.headers['set-cookie']).toBeDefined();
      const cookies = response.headers['set-cookie'];
      expect(cookies.some((cookie: string) => cookie.includes('accessToken=;'))).toBe(true);
      expect(cookies.some((cookie: string) => cookie.includes('refreshToken=;'))).toBe(true);
    });

    it('should return 401 for missing token', async () => {
      const response = await request(app)
        .post('/auth/logout')
        .send();

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('AuthenticationError');
    });
  });

  describe('POST /auth/refresh', () => {
    it('should refresh tokens successfully', async () => {
      const mockResponse = {
        accessToken: 'new_access_token_123',
        refreshToken: 'new_refresh_token_123',
        expiresIn: 900
      };

      mockedRefreshTokens.mockResolvedValue(mockResponse);

      const response = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: 'valid_refresh_token' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.accessToken).toBe('new_access_token_123');
      expect(response.body.data.refreshToken).toBe('new_refresh_token_123');
      expect(response.body.data.expiresIn).toBe(900);

      // Check that cookies are updated
      expect(response.headers['set-cookie']).toBeDefined();
      const cookies = response.headers['set-cookie'];
      expect(cookies.some((cookie: string) => cookie.startsWith('accessToken='))).toBe(true);
      expect(cookies.some((cookie: string) => cookie.startsWith('refreshToken='))).toBe(true);
    });

    it('should refresh tokens from cookies', async () => {
      const mockResponse = {
        accessToken: 'new_access_token_123',
        refreshToken: 'new_refresh_token_123',
        expiresIn: 900
      };

      mockedRefreshTokens.mockResolvedValue(mockResponse);

      const response = await request(app)
        .post('/auth/refresh')
        .set('Cookie', 'refreshToken=valid_refresh_token')
        .send();

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(mockedRefreshTokens).toHaveBeenCalledWith('valid_refresh_token');
    });

    it('should return 401 for missing refresh token', async () => {
      const response = await request(app)
        .post('/auth/refresh')
        .send();

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('AuthenticationError');
      expect(response.body.error.code).toBe('MISSING_REFRESH_TOKEN');
    });

    it('should handle invalid refresh token', async () => {
      mockedRefreshTokens.mockRejectedValue(new AuthenticationError('Invalid token', 'INVALID_TOKEN'));

      const response = await request(app)
        .post('/auth/refresh')
        .send({ refreshToken: 'invalid_token' });

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('AuthenticationError');
      expect(response.body.error.code).toBe('INVALID_TOKEN');
    });
  });

  describe('GET /auth/me', () => {
    it('should return user info for authenticated user', async () => {
      const response = await request(app)
        .get('/auth/me')
        .set('Authorization', 'Bearer valid_token')
        .send();

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.user).toBeDefined();
    });

    it('should return 401 for missing token', async () => {
      const response = await request(app)
        .get('/auth/me')
        .send();

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('AuthenticationError');
    });
  });

  describe('POST /auth/validate', () => {
    it('should validate token successfully', async () => {
      const response = await request(app)
        .post('/auth/validate')
        .set('Authorization', 'Bearer valid_token')
        .send();

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.valid).toBe(true);
      expect(response.body.data.user).toBeDefined();
    });

    it('should return 401 for invalid token', async () => {
      const response = await request(app)
        .post('/auth/validate')
        .set('Authorization', 'Bearer invalid_token')
        .send();

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error.type).toBe('AuthenticationError');
    });
  });
});