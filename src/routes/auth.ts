import { Router, Request, Response } from 'express';
import { register, login, logout, refreshTokens } from '../services/authService';
import {
  RegisterRequest,
  LoginRequest,
  WebSessionData,
  AuthenticationError,
  ValidationError
} from '../types/auth';
import {
  addRequestId,
  authenticateJWT,
  sendErrorResponse
} from '../middleware/auth';
import {
  validateRegistration,
  validateLogin,
  validateContentType,
  validateJsonBody
} from '../middleware/validation';
import logger from '../utils/logger';

const authRouter = Router();

// Apply request ID middleware to all auth routes
authRouter.use(addRequestId);

// Apply content type validation to all POST routes
authRouter.use(validateContentType);
authRouter.use(validateJsonBody);

/**
 * POST /auth/register
 * User registration endpoint
 */
authRouter.post('/register',
  validateRegistration,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;

    try {
      const registrationData: RegisterRequest = req.body;

      logger.info('Registration attempt', {
        requestId,
        username: registrationData.username,
        email: registrationData.email,
        ip: req.ip
      });

      const result = await register(registrationData);

      logger.info('Registration successful', {
        requestId,
        username: registrationData.username,
        email: registrationData.email,
        userToken: result.userToken
      });

      res.status(201).json({
        success: true,
        data: {
          userToken: result.userToken,
          message: result.message
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Registration failed', {
        requestId,
        username: req.body.username,
        email: req.body.email,
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof ValidationError) {
        sendErrorResponse(res, {
          type: 'ValidationError',
          message: error.message,
          code: 'VALIDATION_FAILED',
          field: error.field
        }, 400, requestId);
      } else if (error instanceof AuthenticationError) {
        sendErrorResponse(res, {
          type: 'AuthenticationError',
          message: error.message,
          code: error.code
        }, 400, requestId);
      } else {
        sendErrorResponse(res, {
          type: 'InternalError',
          message: 'Registration failed due to server error',
          code: 'REGISTRATION_ERROR'
        }, 500, requestId);
      }
    }
  }
);

/**
 * POST /auth/login
 * User login endpoint
 */
authRouter.post('/login',
  validateLogin,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;

    try {
      const loginData: LoginRequest = req.body;

      // Extract session data from request
      const sessionData: WebSessionData = {
        userAgent: req.get('User-Agent') || 'Unknown',
        ipAddress: req.ip || req.socket.remoteAddress || 'Unknown'
      };

      logger.info('Login attempt', {
        requestId,
        identifier: loginData.identifier,
        ip: sessionData.ipAddress,
        userAgent: sessionData.userAgent
      });

      const result = await login(loginData, sessionData);

      logger.info('Login successful', {
        requestId,
        identifier: loginData.identifier,
        userId: result.user.id,
        username: result.user.username
      });

      // Set secure HTTP-only cookies for tokens
      const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict' as const,
        maxAge: result.expiresIn * 1000 // Convert to milliseconds
      };

      res.cookie('accessToken', result.accessToken, cookieOptions);
      res.cookie('refreshToken', result.refreshToken, {
        ...cookieOptions,
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days for refresh token
      });

      res.status(200).json({
        success: true,
        data: {
          user: result.user,
          expiresIn: result.expiresIn,
          // Don't send tokens in response body for security
          accessToken: result.accessToken, // Keep for now for compatibility
          refreshToken: result.refreshToken // Keep for now for compatibility
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Login failed', {
        requestId,
        identifier: req.body.identifier,
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof ValidationError) {
        sendErrorResponse(res, {
          type: 'ValidationError',
          message: error.message,
          code: 'VALIDATION_FAILED',
          field: error.field
        }, 400, requestId);
      } else if (error instanceof AuthenticationError) {
        sendErrorResponse(res, {
          type: 'AuthenticationError',
          message: error.message,
          code: error.code
        }, 401, requestId);
      } else {
        sendErrorResponse(res, {
          type: 'InternalError',
          message: 'Login failed due to server error',
          code: 'LOGIN_ERROR'
        }, 500, requestId);
      }
    }
  }
);

/**
 * POST /auth/logout
 * User logout endpoint
 */
authRouter.post('/logout',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      logger.info('Logout attempt', {
        requestId,
        userId: user.userId,
        username: user.username,
        sessionId: user.sessionId
      });

      await logout(user.sessionId);

      // Clear cookies
      res.clearCookie('accessToken');
      res.clearCookie('refreshToken');

      logger.info('Logout successful', {
        requestId,
        userId: user.userId,
        username: user.username,
        sessionId: user.sessionId
      });

      res.status(200).json({
        success: true,
        data: {
          message: 'Logged out successfully'
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Logout failed', {
        requestId,
        userId: user.userId,
        sessionId: user.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof AuthenticationError) {
        sendErrorResponse(res, {
          type: 'AuthenticationError',
          message: error.message,
          code: error.code
        }, 400, requestId);
      } else {
        sendErrorResponse(res, {
          type: 'InternalError',
          message: 'Logout failed due to server error',
          code: 'LOGOUT_ERROR'
        }, 500, requestId);
      }
    }
  }
);

/**
 * POST /auth/refresh
 * Token refresh endpoint
 */
authRouter.post('/refresh',
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;

    try {
      // Get refresh token from body, cookie, or header
      const refreshToken = req.body.refreshToken ||
                        req.cookies?.refreshToken ||
                        req.get('X-Refresh-Token');

      if (!refreshToken) {
        logger.warn('Refresh token missing', {
          requestId,
          ip: req.ip
        });

        sendErrorResponse(res, {
          type: 'AuthenticationError',
          message: 'Refresh token is required',
          code: 'MISSING_REFRESH_TOKEN'
        }, 401, requestId);
        return;
      }

      logger.info('Token refresh attempt', {
        requestId,
        ip: req.ip
      });

      const result = await refreshTokens(refreshToken);

      // Update cookies with new tokens
      const cookieOptions = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict' as const,
        maxAge: result.expiresIn * 1000
      };

      res.cookie('accessToken', result.accessToken, cookieOptions);
      res.cookie('refreshToken', result.refreshToken, {
        ...cookieOptions,
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
      });

      logger.info('Token refresh successful', {
        requestId,
        ip: req.ip
      });

      res.status(200).json({
        success: true,
        data: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresIn: result.expiresIn
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Token refresh failed', {
        requestId,
        ip: req.ip,
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof AuthenticationError) {
        sendErrorResponse(res, {
          type: 'AuthenticationError',
          message: error.message,
          code: error.code
        }, 401, requestId);
      } else {
        sendErrorResponse(res, {
          type: 'InternalError',
          message: 'Token refresh failed due to server error',
          code: 'REFRESH_ERROR'
        }, 500, requestId);
      }
    }
  }
);

/**
 * GET /auth/me
 * Get current user information
 */
authRouter.get('/me',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      logger.debug('User info request', {
        requestId,
        userId: user.userId,
        username: user.username
      });

      res.status(200).json({
        success: true,
        data: {
          user: {
            id: user.userId,
            username: user.username,
            email: user.email
          }
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Failed to get user info', {
        requestId,
        userId: user.userId,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to get user information',
        code: 'USER_INFO_ERROR'
      }, 500, requestId);
    }
  }
);

/**
 * POST /auth/validate
 * Validate current token (for client-side token validation)
 */
authRouter.post('/validate',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    // If we reach this point, the token is valid (middleware validated it)
    res.status(200).json({
      success: true,
      data: {
        valid: true,
        user: {
          id: user.userId,
          username: user.username,
          email: user.email
        }
      },
      timestamp: new Date().toISOString(),
      requestId
    });
  }
);

export default authRouter;
