import { Router, Request, Response } from 'express';
import { findUserByToken, upsertUser } from '../services/storage/userRepository';
import { getUserSessions, destroySession, destroyAllUserSessions } from '../services/storage/webSessionRepository';
import {
  ValidationError
} from '../types/auth';
import {
  addRequestId,
  authenticateJWT,
  sendErrorResponse
} from '../middleware/auth';
import {
  validatePasswordChange,
  validateContentType,
  validateJsonBody
} from '../middleware/validation';
import bcrypt from 'bcrypt';
import logger from '../utils/logger';

const usersRouter = Router();

// Apply request ID middleware to all user routes
usersRouter.use(addRequestId);

// Apply content type validation to POST/PUT routes
usersRouter.use(validateContentType);
usersRouter.use(validateJsonBody);

/**
 * GET /users/me
 * Get current user profile
 */
usersRouter.get('/me',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      logger.debug('User profile request', {
        requestId,
        userId: user.userId,
        username: user.username
      });

      const userDoc = await findUserByToken(user.userToken);
      if (!userDoc) {
        sendErrorResponse(res, {
          type: 'AuthenticationError',
          message: 'User not found',
          code: 'USER_NOT_FOUND'
        }, 404, requestId);
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          user: {
            id: user.userId,
            username: userDoc.username || '',
            email: userDoc.email || '',
            displayName: userDoc.displayName,
            isEmailVerified: userDoc.isEmailVerified || false,
            lastLogin: userDoc.lastLogin,
            createdAt: userDoc.createdAt,
            updatedAt: userDoc.updatedAt
          }
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Failed to get user profile', {
        requestId,
        userId: user.userId,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to get user profile',
        code: 'PROFILE_ERROR'
      }, 500, requestId);
    }
  }
);

/**
 * PUT /users/me
 * Update current user profile
 */
usersRouter.put('/me',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      const { displayName } = req.body;

      // Validate input
      if (displayName && typeof displayName !== 'string') {
        sendErrorResponse(res, {
          type: 'ValidationError',
          message: 'Display name must be a string',
          code: 'VALIDATION_FAILED',
          field: 'displayName'
        }, 400, requestId);
        return;
      }

      if (displayName && displayName.length > 100) {
        sendErrorResponse(res, {
          type: 'ValidationError',
          message: 'Display name is too long',
          code: 'VALIDATION_FAILED',
          field: 'displayName'
        }, 400, requestId);
        return;
      }

      logger.info('User profile update attempt', {
        requestId,
        userId: user.userId,
        username: user.username,
        updates: { displayName }
      });

      const userDoc = await findUserByToken(user.userToken);
      if (!userDoc) {
        sendErrorResponse(res, {
          type: 'AuthenticationError',
          message: 'User not found',
          code: 'USER_NOT_FOUND'
        }, 404, requestId);
        return;
      }

      // Update user
      await upsertUser({
        userToken: userDoc.userToken,
        username: userDoc.username,
        email: userDoc.email,
        passwordHash: userDoc.passwordHash,
        displayName: displayName?.trim() || userDoc.displayName,
        gitlabHost: userDoc.gitlabHost,
        isEmailVerified: userDoc.isEmailVerified,
        pat: userDoc.encryptedPat || '',
        webhookSecret: userDoc.encryptedWebhookSecret || ''
      });

      // Fetch the updated user document
      const updatedUserDoc = await findUserByToken(user.userToken);
      if (!updatedUserDoc) {
        sendErrorResponse(res, {
          type: 'InternalError',
          message: 'Failed to retrieve updated user profile',
          code: 'PROFILE_UPDATE_ERROR'
        }, 500, requestId);
        return;
      }

      logger.info('User profile updated successfully', {
        requestId,
        userId: user.userId,
        username: user.username
      });

      res.status(200).json({
        success: true,
        data: {
          user: {
            id: user.userId,
            username: updatedUserDoc.username || '',
            email: updatedUserDoc.email || '',
            displayName: updatedUserDoc.displayName,
            isEmailVerified: updatedUserDoc.isEmailVerified || false,
            lastLogin: updatedUserDoc.lastLogin,
            createdAt: updatedUserDoc.createdAt,
            updatedAt: updatedUserDoc.updatedAt
          }
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Failed to update user profile', {
        requestId,
        userId: user.userId,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to update user profile',
        code: 'PROFILE_UPDATE_ERROR'
      }, 500, requestId);
    }
  }
);

/**
 * POST /users/me/change-password
 * Change user password
 */
usersRouter.post('/me/change-password',
  authenticateJWT,
  validatePasswordChange,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      const { currentPassword, newPassword } = req.body;

      logger.info('Password change attempt', {
        requestId,
        userId: user.userId,
        username: user.username
      });

      const userDoc = await findUserByToken(user.userToken);
      if (!userDoc || !userDoc.passwordHash) {
        sendErrorResponse(res, {
          type: 'AuthenticationError',
          message: 'User not found or invalid account',
          code: 'USER_NOT_FOUND'
        }, 404, requestId);
        return;
      }

      // Verify current password
      const isCurrentPasswordValid = await bcrypt.compare(currentPassword, userDoc.passwordHash);
      if (!isCurrentPasswordValid) {
        logger.warn('Invalid current password for password change', {
          requestId,
          userId: user.userId,
          username: user.username
        });

        sendErrorResponse(res, {
          type: 'AuthenticationError',
          message: 'Current password is incorrect',
          code: 'INVALID_CURRENT_PASSWORD'
        }, 401, requestId);
        return;
      }

      // Hash new password
      const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12');
      const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

      // Update user with new password
      await upsertUser({
        userToken: userDoc.userToken,
        username: userDoc.username,
        email: userDoc.email,
        passwordHash: newPasswordHash,
        displayName: userDoc.displayName,
        gitlabHost: userDoc.gitlabHost,
        isEmailVerified: userDoc.isEmailVerified,
        pat: userDoc.encryptedPat || '',
        webhookSecret: userDoc.encryptedWebhookSecret || ''
      });

      // Log out all other sessions for security
      await destroyAllUserSessions(user.userId);

      logger.info('Password changed successfully', {
        requestId,
        userId: user.userId,
        username: user.username
      });

      res.status(200).json({
        success: true,
        data: {
          message: 'Password changed successfully. All other sessions have been logged out.'
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Failed to change password', {
        requestId,
        userId: user.userId,
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof ValidationError) {
        sendErrorResponse(res, {
          type: 'ValidationError',
          message: error.message,
          code: 'VALIDATION_FAILED',
          field: error.field
        }, 400, requestId);
      } else {
        sendErrorResponse(res, {
          type: 'InternalError',
          message: 'Failed to change password',
          code: 'PASSWORD_CHANGE_ERROR'
        }, 500, requestId);
      }
    }
  }
);

/**
 * GET /users/me/sessions
 * Get all active sessions for current user
 */
usersRouter.get('/me/sessions',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      logger.debug('User sessions request', {
        requestId,
        userId: user.userId,
        username: user.username
      });

      const sessions = await getUserSessions(user.userId);

      // Don't expose sensitive session data
      const safeSessions = sessions.map(session => ({
        sessionId: session.sessionId,
        userAgent: session.userAgent,
        ipAddress: session.ipAddress,
        lastActivity: session.lastActivity,
        createdAt: session.createdAt,
        isCurrentSession: session.sessionId === user.sessionId
      }));

      res.status(200).json({
        success: true,
        data: {
          sessions: safeSessions,
          totalSessions: sessions.length
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Failed to get user sessions', {
        requestId,
        userId: user.userId,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to get user sessions',
        code: 'SESSIONS_ERROR'
      }, 500, requestId);
    }
  }
);

/**
 * DELETE /users/me/sessions/:sessionId
 * Terminate a specific session
 */
usersRouter.delete('/me/sessions/:sessionId',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;
    const targetSessionId = req.params.sessionId;

    try {
      if (!targetSessionId) {
        sendErrorResponse(res, {
          type: 'ValidationError',
          message: 'Session ID is required',
          code: 'VALIDATION_FAILED'
        }, 400, requestId);
        return;
      }

      // Don't allow users to terminate their current session via this endpoint
      if (targetSessionId === user.sessionId) {
        sendErrorResponse(res, {
          type: 'ValidationError',
          message: 'Cannot terminate current session. Use logout instead.',
          code: 'CANNOT_TERMINATE_CURRENT_SESSION'
        }, 400, requestId);
        return;
      }

      logger.info('Session termination attempt', {
        requestId,
        userId: user.userId,
        username: user.username,
        targetSessionId
      });

      // Verify the session belongs to the current user
      const sessions = await getUserSessions(user.userId);
      const targetSession = sessions.find(s => s.sessionId === targetSessionId);

      if (!targetSession) {
        sendErrorResponse(res, {
          type: 'NotFound',
          message: 'Session not found',
          code: 'SESSION_NOT_FOUND'
        }, 404, requestId);
        return;
      }

      await destroySession(targetSessionId);

      logger.info('Session terminated successfully', {
        requestId,
        userId: user.userId,
        targetSessionId
      });

      res.status(200).json({
        success: true,
        data: {
          message: 'Session terminated successfully'
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Failed to terminate session', {
        requestId,
        userId: user.userId,
        targetSessionId,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to terminate session',
        code: 'SESSION_TERMINATION_ERROR'
      }, 500, requestId);
    }
  }
);

/**
 * DELETE /users/me/sessions
 * Terminate all sessions except current one
 */
usersRouter.delete('/me/sessions',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      logger.info('Terminate all other sessions attempt', {
        requestId,
        userId: user.userId,
        username: user.username,
        currentSessionId: user.sessionId
      });

      // Get all sessions and terminate all except current
      const sessions = await getUserSessions(user.userId);
      const otherSessions = sessions.filter(s => s.sessionId !== user.sessionId);

      for (const session of otherSessions) {
        await destroySession(session.sessionId);
      }

      logger.info('All other sessions terminated successfully', {
        requestId,
        userId: user.userId,
        terminatedSessions: otherSessions.length
      });

      res.status(200).json({
        success: true,
        data: {
          message: `Terminated ${otherSessions.length} other sessions`,
          terminatedSessions: otherSessions.length
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Failed to terminate other sessions', {
        requestId,
        userId: user.userId,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to terminate other sessions',
        code: 'SESSIONS_TERMINATION_ERROR'
      }, 500, requestId);
    }
  }
);

export default usersRouter;
