import { Gitlab } from '@gitbeaker/node';
import {
  GitLabConfigInput,
  GitLabConfig,
  ConnectionTestResult,
  ConfigurationError
} from '../types/auth';
import {
  createConfig,
  getUserConfigs,
  getConfigById,
  updateConfig,
  deleteConfig,
  setDefaultConfig,
  getDefaultConfig,
  updateTestResult,
  getDecryptedConfig
} from './storage/gitlabConfigRepository';
import { findUserByToken } from './storage/userRepository';
import logger from '../utils/logger';

export class GitLabConfigService {
  async createConfig(userToken: string, configData: GitLabConfigInput, skipTest = false): Promise<GitLabConfig> {
    try {
      // Validate user exists
      const user = await findUserByToken(userToken);
      if (!user) {
        throw new ConfigurationError('User not found');
      }

      let testResult: ConnectionTestResult | null = null;

      // Validate GitLab configuration (optional)
      if (!skipTest) {
        testResult = await this.testConnection(configData);
        if (!testResult.success) {
          logger.warn('GitLab connection test failed, but allowing config creation', {
            userToken,
            gitlabUrl: configData.gitlabUrl,
            error: testResult.message
          });
          // Don't throw error - allow config creation even if test fails
        }
      }

      // Create configuration
      const userId = user._id?.toString() || user.userToken;
      const config = await createConfig(userId, userToken, configData);

      // Update test result if we ran the test
      if (testResult) {
        await updateTestResult(config.id, testResult);
      }

      logger.info('GitLab configuration created successfully', {
        userToken,
        configId: config.id,
        configName: config.name,
        gitlabUrl: config.gitlabUrl,
        testSkipped: skipTest,
        testSuccess: testResult?.success
      });

      return config;
    } catch (error) {
      logger.error('Failed to create GitLab configuration', {
        userToken,
        configName: configData.name,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async getUserConfigs(userToken: string): Promise<GitLabConfig[]> {
    try {
      // Validate user exists
      const user = await findUserByToken(userToken);
      if (!user) {
        throw new ConfigurationError('User not found');
      }

      const userId = user._id?.toString() || user.userToken;
      return await getUserConfigs(userId);
    } catch (error) {
      logger.error('Failed to get user configurations', {
        userToken,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async getConfigById(configId: string): Promise<GitLabConfig | null> {
    try {
      return await getConfigById(configId);
    } catch (error) {
      logger.error('Failed to get configuration by ID', {
        configId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async updateConfig(configId: string, updates: Partial<GitLabConfigInput>): Promise<GitLabConfig> {
    try {
      // If access token or URL is being updated, test the connection
      if (updates.accessToken || updates.gitlabUrl) {
        const currentConfig = await getDecryptedConfig(configId);
        if (!currentConfig) {
          throw new ConfigurationError('Configuration not found');
        }

        const testData: GitLabConfigInput = {
          ...currentConfig,
          ...updates
        };

        const testResult = await this.testConnection(testData);
        if (!testResult.success) {
          throw new ConfigurationError(`GitLab connection test failed: ${testResult.message}`);
        }

        // Update configuration
        const updatedConfig = await updateConfig(configId, updates);

        // Update test result
        await updateTestResult(configId, testResult);

        return updatedConfig;
      } else {
        // Only updating metadata, no need to test connection
        return await updateConfig(configId, updates);
      }
    } catch (error) {
      logger.error('Failed to update configuration', {
        configId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async deleteConfig(configId: string): Promise<void> {
    try {
      await deleteConfig(configId);
      logger.info('GitLab configuration deleted successfully', { configId });
    } catch (error) {
      logger.error('Failed to delete configuration', {
        configId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async setDefaultConfig(userToken: string, configId: string): Promise<void> {
    try {
      // Validate user exists
      const user = await findUserByToken(userToken);
      if (!user) {
        throw new ConfigurationError('User not found');
      }

      const userId = user._id?.toString() || user.userToken;

      // Validate config belongs to user
      const config = await getConfigById(configId);
      if (!config || config.userId !== userId) {
        throw new ConfigurationError('Configuration not found or does not belong to user');
      }

      await setDefaultConfig(userId, configId);

      logger.info('Default GitLab configuration set successfully', {
        userToken,
        configId
      });
    } catch (error) {
      logger.error('Failed to set default configuration', {
        userToken,
        configId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async getDefaultConfig(userToken: string): Promise<GitLabConfig | null> {
    try {
      // Validate user exists
      const user = await findUserByToken(userToken);
      if (!user) {
        throw new ConfigurationError('User not found');
      }

      const userId = user._id?.toString() || user.userToken;
      return await getDefaultConfig(userId);
    } catch (error) {
      logger.error('Failed to get default configuration', {
        userToken,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  async testConnection(configData: GitLabConfigInput): Promise<ConnectionTestResult> {
    try {
      // Validate URL format
      let gitlabUrl = configData.gitlabUrl.trim();
      if (!gitlabUrl.startsWith('http://') && !gitlabUrl.startsWith('https://')) {
        gitlabUrl = `https://${gitlabUrl}`;
      }

      // Remove trailing slash
      gitlabUrl = gitlabUrl.replace(/\/$/, '');

      // Validate URL format
      try {
        new URL(gitlabUrl);
      } catch {
        return {
          success: false,
          message: 'Invalid GitLab URL format'
        };
      }

      // Test GitLab API connection
      const api = new Gitlab({
        host: gitlabUrl,
        token: configData.accessToken
      });

      // Test by getting current user info
      const userInfo = await api.Users.current();

      const details = {
        id: userInfo.id,
        username: userInfo.username,
        email: userInfo.email,
        name: userInfo.name
      };

      logger.info('GitLab connection test successful', {
        gitlabUrl,
        username: details.username,
        userId: details.id
      });

      return {
        success: true,
        message: `Successfully connected to GitLab as ${userInfo.username}`,
        details
      };
    } catch (error) {
      logger.warn('GitLab connection test failed', {
        gitlabUrl: configData.gitlabUrl,
        error: error instanceof Error ? error.message : String(error)
      });

      let message = 'Connection test failed';

      if (error instanceof Error) {
        if (error.message.includes('401')) {
          message = 'Invalid access token or insufficient permissions';
        } else if (error.message.includes('403')) {
          message = 'Access forbidden - check token permissions';
        } else if (error.message.includes('404')) {
          message = 'GitLab instance not found - check URL';
        } else if (error.message.includes('timeout') || error.message.includes('ECONNREFUSED')) {
          message = 'Connection timeout - check URL and network connectivity';
        } else if (error.message.includes('SSL') || error.message.includes('certificate')) {
          message = 'SSL certificate error - check if instance uses valid certificates';
        } else {
          message = error.message;
        }
      }

      return {
        success: false,
        message,
        details: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async validateWebhookSecret(configId: string, providedSecret: string): Promise<boolean> {
    try {
      const config = await getDecryptedConfig(configId);
      if (!config) {
        return false;
      }

      return config.webhookSecret === providedSecret;
    } catch (error) {
      logger.error('Failed to validate webhook secret', {
        configId,
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  async getDecryptedConfigForUser(userToken: string, configId?: string): Promise<GitLabConfigInput | null> {
    try {
      // Validate user exists
      const user = await findUserByToken(userToken);
      if (!user) {
        throw new ConfigurationError('User not found');
      }

      const userId = user._id?.toString() || user.userToken;

      let config: GitLabConfig | null;

      if (configId) {
        // Get specific config
        config = await getConfigById(configId);
        if (!config || config.userId !== userId) {
          throw new ConfigurationError('Configuration not found or does not belong to user');
        }
      } else {
        // Get default config
        config = await getDefaultConfig(userId);
      }

      if (!config) {
        return null;
      }

      return await getDecryptedConfig(config.id);
    } catch (error) {
      logger.error('Failed to get decrypted configuration', {
        userToken,
        configId,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}
