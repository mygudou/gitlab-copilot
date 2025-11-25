import { Router, Request, Response } from 'express';
import { GitLabConfigService } from '../services/gitlabConfigService';
import {
  GitLabConfigInput,
  ConfigurationError,
  ValidationError
} from '../types/auth';
import {
  addRequestId,
  authenticateJWT,
  sendErrorResponse
} from '../middleware/auth';
import {
  validateGitLabConfig,
  validateContentType,
  validateJsonBody
} from '../middleware/validation';
import logger from '../utils/logger';
import { config } from '../utils/config';
import { decryptSecret } from '../utils/secretVault';

const gitlabConfigRouter = Router();
const gitlabConfigService = new GitLabConfigService();

function resolveBaseUrl(req: Request): string {
  const forwardedProto = req.get('x-forwarded-proto');
  const protocol = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol;
  const host = (req.get('x-forwarded-host') || req.get('host'))?.trim();

  if (protocol && host) {
    return `${protocol}://${host}`;
  }

  return process.env.PUBLIC_URL || 'http://localhost:3000';
}

function maskToken(value: string | undefined | null, options: { prefix?: number; suffix?: number } = {}): string {
  const token = value?.trim();
  if (!token) {
    return '';
  }

  const prefixLength = options.prefix ?? 4;
  const suffixLength = options.suffix ?? 4;

  if (token.length <= prefixLength + suffixLength) {
    if (token.length <= 2) {
      return `${token.charAt(0) ?? ''}***`;
    }
    return `${token.slice(0, 1)}***${token.slice(-1)}`;
  }

  return `${token.slice(0, prefixLength)}***${token.slice(-suffixLength)}`;
}

// Apply request ID middleware to all routes
gitlabConfigRouter.use(addRequestId);

// Apply content type validation to POST/PUT routes
gitlabConfigRouter.use(validateContentType);
gitlabConfigRouter.use(validateJsonBody);

/**
 * GET /gitlab-config
 * Get all GitLab configurations for the current user
 */
gitlabConfigRouter.get('/',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      logger.debug('Get GitLab configurations request', {
        requestId,
        userId: user.userId,
        username: user.username
      });

      const configs = await gitlabConfigService.getUserConfigs(user.userToken);
      const baseUrl = resolveBaseUrl(req);

      // Return decrypted secrets for easy copying
      const safeConfigs = configs.map(config => {
        const decryptedAccessToken = config.encryptedAccessToken
          ? decryptSecret(config.encryptedAccessToken)
          : '';
        const maskedAccessToken = maskToken(decryptedAccessToken);

        // 每个配置都有自己专属的webhook URL
        const webhookUrl = `${baseUrl}/webhook/${config.configToken}`;

        return {
          id: config.id,
          name: config.name,
          gitlabUrl: config.gitlabUrl,
          description: config.description,
          isDefault: config.isDefault,
          isActive: config.isActive,
          lastTested: config.lastTested,
          createdAt: config.createdAt,
          updatedAt: config.updatedAt,
          webhookUrl: webhookUrl,
          maskedAccessToken,
          hasAccessToken: Boolean(decryptedAccessToken),
          webhookSecret: config.encryptedWebhookSecret ? decryptSecret(config.encryptedWebhookSecret) : ''
        };
      });

      res.status(200).json({
        success: true,
        data: {
          configurations: safeConfigs,
          totalConfigurations: configs.length,
          defaultGitlabUrl: config.gitlab.baseUrl
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Failed to get GitLab configurations', {
        requestId,
        userId: user.userId,
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof ConfigurationError) {
        sendErrorResponse(res, {
          type: 'ConfigurationError',
          message: error.message,
          code: 'CONFIG_ERROR'
        }, 400, requestId);
      } else {
        sendErrorResponse(res, {
          type: 'InternalError',
          message: 'Failed to get GitLab configurations',
          code: 'GET_CONFIGS_ERROR'
        }, 500, requestId);
      }
    }
  }
);

/**
 * POST /gitlab-config
 * Create a new GitLab configuration
 */
gitlabConfigRouter.post('/',
  authenticateJWT,
  validateGitLabConfig,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      const configData: GitLabConfigInput = req.body;

      logger.info('Create GitLab configuration attempt', {
        requestId,
        userId: user.userId,
        username: user.username,
        gitlabUrl: configData.gitlabUrl
      });

      const config = await gitlabConfigService.createConfig(user.userToken, configData);

      logger.info('GitLab configuration created successfully', {
        requestId,
        userId: user.userId,
        configId: config.id,
        configToken: config.configToken,
        hasConfigToken: Boolean(config.configToken)
      });

      // Calculate webhook URL using config-specific token
      const baseUrl = resolveBaseUrl(req);
      const webhookUrl = `${baseUrl}/webhook/${config.configToken}`;

      logger.info('Generated webhook URL', {
        configId: config.id,
        configToken: config.configToken,
        webhookUrl
      });

      // Decrypt webhook secret for display
      const decryptedSecret = config.encryptedWebhookSecret ? decryptSecret(config.encryptedWebhookSecret) : '';

      logger.info('Returning config with decrypted webhook secret', {
        configId: config.id,
        encryptedSecretLength: config.encryptedWebhookSecret?.length,
        decryptedSecretLength: decryptedSecret?.length,
        secretPreview: decryptedSecret ? `${decryptedSecret.substring(0, 8)}...` : 'empty'
      });

      // Return configuration with webhook info and plain text webhook secret
      const safeConfig = {
        id: config.id,
        name: config.name,
        gitlabUrl: config.gitlabUrl,
        description: config.description,
        isDefault: config.isDefault,
        isActive: config.isActive,
        lastTested: config.lastTested,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
        webhookUrl: webhookUrl,
        webhookSecret: decryptedSecret
      };

      res.status(201).json({
        success: true,
        data: {
          configuration: safeConfig,
          webhookUrl: webhookUrl
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Failed to create GitLab configuration', {
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
      } else if (error instanceof ConfigurationError) {
        sendErrorResponse(res, {
          type: 'ConfigurationError',
          message: error.message,
          code: 'CONFIG_ERROR'
        }, 400, requestId);
      } else {
        sendErrorResponse(res, {
          type: 'InternalError',
          message: 'Failed to create GitLab configuration',
          code: 'CREATE_CONFIG_ERROR'
        }, 500, requestId);
      }
    }
  }
);

/**
 * GET /gitlab-config/:configId
 * Get a specific GitLab configuration
 */
gitlabConfigRouter.get('/:configId',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;
    const configId = req.params.configId;

    try {
      if (!configId) {
        sendErrorResponse(res, {
          type: 'ValidationError',
          message: 'Configuration ID is required',
          code: 'VALIDATION_FAILED'
        }, 400, requestId);
        return;
      }

      logger.debug('Get GitLab configuration request', {
        requestId,
        userId: user.userId,
        configId
      });

      const config = await gitlabConfigService.getConfigById(configId);
      if (!config) {
        sendErrorResponse(res, {
          type: 'NotFound',
          message: 'Configuration not found',
          code: 'CONFIG_NOT_FOUND'
        }, 404, requestId);
        return;
      }

      // Verify the config belongs to the current user
      if (config.userId !== user.userId) {
        sendErrorResponse(res, {
          type: 'AuthorizationError',
          message: 'Access denied',
          code: 'INSUFFICIENT_PERMISSIONS'
        }, 403, requestId);
        return;
      }

      const decryptedAccessToken = config.encryptedAccessToken
        ? decryptSecret(config.encryptedAccessToken)
        : '';

      // Calculate webhook URL using config-specific token
      const baseUrl = resolveBaseUrl(req);
      const webhookUrl = `${baseUrl}/webhook/${config.configToken}`;

      // Don't expose sensitive data
      const safeConfig = {
        id: config.id,
        name: config.name,
        gitlabUrl: config.gitlabUrl,
        description: config.description,
        isDefault: config.isDefault,
        isActive: config.isActive,
        lastTested: config.lastTested,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
        webhookUrl: webhookUrl,
        maskedAccessToken: maskToken(decryptedAccessToken),
        hasAccessToken: Boolean(decryptedAccessToken),
        webhookSecret: config.encryptedWebhookSecret ? decryptSecret(config.encryptedWebhookSecret) : ''
      };

      res.status(200).json({
        success: true,
        data: {
          configuration: safeConfig
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Failed to get GitLab configuration', {
        requestId,
        userId: user.userId,
        configId,
        error: error instanceof Error ? error.message : String(error)
      });

      sendErrorResponse(res, {
        type: 'InternalError',
        message: 'Failed to get GitLab configuration',
        code: 'GET_CONFIG_ERROR'
      }, 500, requestId);
    }
  }
);

/**
 * PUT /gitlab-config/:configId
 * Update a GitLab configuration
 */
gitlabConfigRouter.put('/:configId',
  authenticateJWT,
  validateGitLabConfig,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;
    const configId = req.params.configId;

    try {
      if (!configId) {
        sendErrorResponse(res, {
          type: 'ValidationError',
          message: 'Configuration ID is required',
          code: 'VALIDATION_FAILED'
        }, 400, requestId);
        return;
      }

      const updates: Partial<GitLabConfigInput> = req.body;

      logger.info('Update GitLab configuration attempt', {
        requestId,
        userId: user.userId,
        configId,
        updates: Object.keys(updates)
      });

      // Verify the config belongs to the current user
      const existingConfig = await gitlabConfigService.getConfigById(configId);
      if (!existingConfig) {
        sendErrorResponse(res, {
          type: 'NotFound',
          message: 'Configuration not found',
          code: 'CONFIG_NOT_FOUND'
        }, 404, requestId);
        return;
      }

      if (existingConfig.userId !== user.userId) {
        sendErrorResponse(res, {
          type: 'AuthorizationError',
          message: 'Access denied',
          code: 'INSUFFICIENT_PERMISSIONS'
        }, 403, requestId);
        return;
      }

      const updatedConfig = await gitlabConfigService.updateConfig(configId, updates);

      logger.info('GitLab configuration updated successfully', {
        requestId,
        userId: user.userId,
        configId
      });

      // Don't expose sensitive data
      const safeConfig = {
        id: updatedConfig.id,
        name: updatedConfig.name,
        gitlabUrl: updatedConfig.gitlabUrl,
        description: updatedConfig.description,
        isDefault: updatedConfig.isDefault,
        isActive: updatedConfig.isActive,
        lastTested: updatedConfig.lastTested,
        createdAt: updatedConfig.createdAt,
        updatedAt: updatedConfig.updatedAt
      };

      res.status(200).json({
        success: true,
        data: {
          configuration: safeConfig
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Failed to update GitLab configuration', {
        requestId,
        userId: user.userId,
        configId,
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof ValidationError) {
        sendErrorResponse(res, {
          type: 'ValidationError',
          message: error.message,
          code: 'VALIDATION_FAILED',
          field: error.field
        }, 400, requestId);
      } else if (error instanceof ConfigurationError) {
        sendErrorResponse(res, {
          type: 'ConfigurationError',
          message: error.message,
          code: 'CONFIG_ERROR'
        }, 400, requestId);
      } else {
        sendErrorResponse(res, {
          type: 'InternalError',
          message: 'Failed to update GitLab configuration',
          code: 'UPDATE_CONFIG_ERROR'
        }, 500, requestId);
      }
    }
  }
);

/**
 * DELETE /gitlab-config/:configId
 * Delete a GitLab configuration
 */
gitlabConfigRouter.delete('/:configId',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;
    const configId = req.params.configId;

    try {
      if (!configId) {
        sendErrorResponse(res, {
          type: 'ValidationError',
          message: 'Configuration ID is required',
          code: 'VALIDATION_FAILED'
        }, 400, requestId);
        return;
      }

      logger.info('Delete GitLab configuration attempt', {
        requestId,
        userId: user.userId,
        configId
      });

      // Verify the config belongs to the current user
      const existingConfig = await gitlabConfigService.getConfigById(configId);
      if (!existingConfig) {
        sendErrorResponse(res, {
          type: 'NotFound',
          message: 'Configuration not found',
          code: 'CONFIG_NOT_FOUND'
        }, 404, requestId);
        return;
      }

      if (existingConfig.userId !== user.userId) {
        sendErrorResponse(res, {
          type: 'AuthorizationError',
          message: 'Access denied',
          code: 'INSUFFICIENT_PERMISSIONS'
        }, 403, requestId);
        return;
      }

      await gitlabConfigService.deleteConfig(configId);

      logger.info('GitLab configuration deleted successfully', {
        requestId,
        userId: user.userId,
        configId
      });

      res.status(200).json({
        success: true,
        data: {
          message: 'Configuration deleted successfully'
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Failed to delete GitLab configuration', {
        requestId,
        userId: user.userId,
        configId,
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof ConfigurationError) {
        sendErrorResponse(res, {
          type: 'ConfigurationError',
          message: error.message,
          code: 'CONFIG_ERROR'
        }, 400, requestId);
      } else {
        sendErrorResponse(res, {
          type: 'InternalError',
          message: 'Failed to delete GitLab configuration',
          code: 'DELETE_CONFIG_ERROR'
        }, 500, requestId);
      }
    }
  }
);

/**
 * POST /gitlab-config/:configId/set-default
 * Set a configuration as the default
 */
gitlabConfigRouter.post('/:configId/set-default',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;
    const configId = req.params.configId;

    try {
      if (!configId) {
        sendErrorResponse(res, {
          type: 'ValidationError',
          message: 'Configuration ID is required',
          code: 'VALIDATION_FAILED'
        }, 400, requestId);
        return;
      }

      logger.info('Set default GitLab configuration attempt', {
        requestId,
        userId: user.userId,
        configId
      });

      await gitlabConfigService.setDefaultConfig(user.userToken, configId);

      logger.info('Default GitLab configuration set successfully', {
        requestId,
        userId: user.userId,
        configId
      });

      res.status(200).json({
        success: true,
        data: {
          message: 'Default configuration set successfully'
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Failed to set default GitLab configuration', {
        requestId,
        userId: user.userId,
        configId,
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof ConfigurationError) {
        sendErrorResponse(res, {
          type: 'ConfigurationError',
          message: error.message,
          code: 'CONFIG_ERROR'
        }, 400, requestId);
      } else {
        sendErrorResponse(res, {
          type: 'InternalError',
          message: 'Failed to set default configuration',
          code: 'SET_DEFAULT_CONFIG_ERROR'
        }, 500, requestId);
      }
    }
  }
);

/**
 * POST /gitlab-config/test-connection
 * Test GitLab connection without saving configuration
 */
gitlabConfigRouter.post('/test-connection',
  authenticateJWT,
  validateGitLabConfig,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      const configData: GitLabConfigInput = req.body;

      logger.info('GitLab connection test attempt', {
        requestId,
        userId: user.userId,
        gitlabUrl: configData.gitlabUrl
      });

      const testResult = await gitlabConfigService.testConnection(configData);

      logger.info('GitLab connection test completed', {
        requestId,
        userId: user.userId,
        gitlabUrl: configData.gitlabUrl,
        success: testResult.success
      });

      res.status(200).json({
        success: true,
        data: {
          testResult
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('GitLab connection test failed', {
        requestId,
        userId: user.userId,
        gitlabUrl: req.body.gitlabUrl,
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
          message: 'Connection test failed due to server error',
          code: 'CONNECTION_TEST_ERROR'
        }, 500, requestId);
      }
    }
  }
);

/**
 * GET /gitlab-config/default
 * Get the default GitLab configuration
 */
gitlabConfigRouter.get('/default',
  authenticateJWT,
  async (req: Request, res: Response): Promise<void> => {
    const requestId = req.requestId!;
    const user = req.user!;

    try {
      logger.debug('Get default GitLab configuration request', {
        requestId,
        userId: user.userId
      });

      const defaultConfig = await gitlabConfigService.getDefaultConfig(user.userToken);

      if (!defaultConfig) {
        sendErrorResponse(res, {
          type: 'NotFound',
          message: 'No default configuration found',
          code: 'NO_DEFAULT_CONFIG'
        }, 404, requestId);
        return;
      }

      // Don't expose sensitive data
      const safeConfig = {
        id: defaultConfig.id,
        name: defaultConfig.name,
        gitlabUrl: defaultConfig.gitlabUrl,
        description: defaultConfig.description,
        isDefault: defaultConfig.isDefault,
        isActive: defaultConfig.isActive,
        lastTested: defaultConfig.lastTested,
        createdAt: defaultConfig.createdAt,
        updatedAt: defaultConfig.updatedAt
      };

      res.status(200).json({
        success: true,
        data: {
          configuration: safeConfig
        },
        timestamp: new Date().toISOString(),
        requestId
      });
    } catch (error) {
      logger.error('Failed to get default GitLab configuration', {
        requestId,
        userId: user.userId,
        error: error instanceof Error ? error.message : String(error)
      });

      if (error instanceof ConfigurationError) {
        sendErrorResponse(res, {
          type: 'ConfigurationError',
          message: error.message,
          code: 'CONFIG_ERROR'
        }, 400, requestId);
      } else {
        sendErrorResponse(res, {
          type: 'InternalError',
          message: 'Failed to get default configuration',
          code: 'GET_DEFAULT_CONFIG_ERROR'
        }, 500, requestId);
      }
    }
  }
);

export default gitlabConfigRouter;
