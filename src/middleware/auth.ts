import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../services/authService';
import { AuthenticationError, ErrorResponse } from '../types/auth';
import logger from '../utils/logger';

// Extend Express Request type to include user information
declare module 'express' {
  interface Request {
    user?: {
      userId: string;
      userToken: string;
      username: string;
      email: string;
      sessionId: string;
    };
    requestId?: string;
  }
}

/**
 * JWT Authentication middleware
 * Validates Bearer tokens and attaches user info to request
 */
export function authenticateJWT(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.requestId || generateRequestId();
  req.requestId = requestId;

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('Missing or invalid authorization header', { requestId, path: req.path });
      sendErrorResponse(res, {
        type: 'AuthenticationError',
        message: 'Missing or invalid authorization header',
        code: 'MISSING_TOKEN'
      }, 401, requestId);
      return;
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    verifyAccessToken(token)
      .then(payload => {
        // Attach user info to request
        req.user = {
          userId: payload.userId,
          userToken: payload.userToken,
          username: payload.username,
          email: payload.email,
          sessionId: payload.sessionId
        };

        logger.debug('User authenticated successfully', {
          requestId,
          userId: payload.userId,
          username: payload.username,
          sessionId: payload.sessionId,
          path: req.path
        });

        next();
      })
      .catch(error => {
        logger.warn('Token verification failed', {
          requestId,
          path: req.path,
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
            type: 'AuthenticationError',
            message: 'Token verification failed',
            code: 'TOKEN_VERIFICATION_FAILED'
          }, 401, requestId);
        }
      });
  } catch (error) {
    logger.error('Authentication middleware error', {
      requestId,
      path: req.path,
      error: error instanceof Error ? error.message : String(error)
    });

    sendErrorResponse(res, {
      type: 'InternalError',
      message: 'Authentication service unavailable',
      code: 'AUTH_SERVICE_ERROR'
    }, 503, requestId);
  }
}

/**
 * Optional JWT Authentication middleware
 * Similar to authenticateJWT but doesn't require authentication
 * If token is provided and valid, attaches user info to request
 */
export function optionalJWT(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.requestId || generateRequestId();
  req.requestId = requestId;

  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // No auth header provided, continue without user info
    next();
    return;
  }

  const token = authHeader.substring(7);

  verifyAccessToken(token)
    .then(payload => {
      req.user = {
        userId: payload.userId,
        userToken: payload.userToken,
        username: payload.username,
        email: payload.email,
        sessionId: payload.sessionId
      };

      logger.debug('Optional authentication successful', {
        requestId,
        userId: payload.userId,
        username: payload.username,
        path: req.path
      });

      next();
    })
    .catch(error => {
      logger.debug('Optional authentication failed, continuing without user info', {
        requestId,
        path: req.path,
        error: error instanceof Error ? error.message : String(error)
      });

      // Continue without user info
      next();
    });
}

/**
 * Middleware to ensure user has access to specific user resources
 * Must be used after authenticateJWT
 */
export function requireUserAccess(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.requestId || generateRequestId();

  if (!req.user) {
    logger.error('requireUserAccess called without prior authentication', { requestId, path: req.path });
    sendErrorResponse(res, {
      type: 'AuthenticationError',
      message: 'Authentication required',
      code: 'NOT_AUTHENTICATED'
    }, 401, requestId);
    return;
  }

  const targetUserId = req.params.userId;

  if (targetUserId && targetUserId !== req.user.userId) {
    logger.warn('User attempted to access another user\'s resources', {
      requestId,
      currentUserId: req.user.userId,
      targetUserId,
      path: req.path
    });

    sendErrorResponse(res, {
      type: 'AuthorizationError',
      message: 'Access denied',
      code: 'INSUFFICIENT_PERMISSIONS'
    }, 403, requestId);
    return;
  }

  next();
}

/**
 * Middleware to add request ID to all requests
 */
export function addRequestId(req: Request, res: Response, next: NextFunction): void {
  req.requestId = generateRequestId();
  res.setHeader('X-Request-ID', req.requestId);
  next();
}

/**
 * Utility function to send standardized error responses
 */
function sendErrorResponse(
  res: Response,
  error: { type: string; message: string; code?: string; field?: string; details?: unknown },
  status: number,
  requestId: string
): void {
  const response: ErrorResponse = {
    success: false,
    error,
    timestamp: new Date().toISOString(),
    requestId
  };

  res.status(status).json(response);
}

/**
 * Generate unique request ID
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Middleware for CORS configuration
 */
export function configureCORS(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  const allowedOrigins = process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'];

  // Allow requests from allowed origins
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Max-Age', '86400'); // 24 hours

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  next();
}

/**
 * Export the sendErrorResponse function for use in routes
 */
export { sendErrorResponse };