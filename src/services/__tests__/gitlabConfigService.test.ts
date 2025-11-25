import { GitLabConfigService } from '../gitlabConfigService';
import { ConfigurationError } from '../../types/auth';
import * as gitlabConfigRepository from '../storage/gitlabConfigRepository';
import * as userRepository from '../storage/userRepository';
import { Gitlab } from '@gitbeaker/node';

// Mock dependencies
jest.mock('../storage/gitlabConfigRepository');
jest.mock('../storage/userRepository');
jest.mock('@gitbeaker/node');
jest.mock('../../utils/logger');

const mockedGitlabConfigRepository = gitlabConfigRepository as jest.Mocked<typeof gitlabConfigRepository>;
const mockedUserRepository = userRepository as jest.Mocked<typeof userRepository>;
const MockedGitlab = Gitlab as jest.MockedClass<typeof Gitlab>;

// Test data
const testUser = {
  _id: 'user123',
  userToken: 'gitlab_12345',
  username: 'testuser',
  email: 'test@example.com',
  passwordHash: '$2b$12$hashedpassword',
  encryptedPat: 'encrypted_pat',
  encryptedWebhookSecret: 'encrypted_secret',
  createdAt: new Date(),
  updatedAt: new Date()
};

const testConfig = {
  id: 'config123',
  userId: 'user123',
  name: 'Test Config',
  gitlabUrl: 'https://gitlab.example.com',
  encryptedAccessToken: 'encrypted_token',
  encryptedWebhookSecret: 'encrypted_secret',
  description: 'Test configuration',
  isDefault: true,
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date()
};

const testConfigInput = {
  name: 'Test Config',
  gitlabUrl: 'https://gitlab.example.com',
  accessToken: 'glpat-test-token',
  webhookSecret: 'webhook-secret',
  description: 'Test configuration'
};

const mockGitlabUser = {
  id: 1,
  username: 'testuser',
  email: 'test@gitlab.com',
  name: 'Test User'
};

describe('GitLabConfigService', () => {
  let service: GitLabConfigService;
  let mockGitlabInstance: {
    Users: {
      current: jest.Mock;
      showCurrentUser: jest.Mock;
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GitLabConfigService();

    // Setup Gitlab mock
    mockGitlabInstance = {
      Users: {
        current: jest.fn(),
        showCurrentUser: jest.fn()
      }
    };

    MockedGitlab.mockImplementation(
      () => mockGitlabInstance as unknown as InstanceType<typeof Gitlab>
    );
  });

  describe('createConfig', () => {
    beforeEach(() => {
      mockedUserRepository.findUserByToken.mockResolvedValue(testUser);
      mockGitlabInstance.Users.current.mockResolvedValue(mockGitlabUser);
      mockedGitlabConfigRepository.createConfig.mockResolvedValue(testConfig);
      mockedGitlabConfigRepository.updateTestResult.mockResolvedValue();
    });

    it('should create config successfully', async () => {
      const result = await service.createConfig('gitlab_12345', testConfigInput);

      expect(result).toEqual(testConfig);
      expect(mockedUserRepository.findUserByToken).toHaveBeenCalledWith('gitlab_12345');
      expect(MockedGitlab).toHaveBeenCalledWith({
        host: 'https://gitlab.example.com',
        token: 'glpat-test-token'
      });
      expect(mockGitlabInstance.Users.current).toHaveBeenCalled();
      expect(mockedGitlabConfigRepository.createConfig).toHaveBeenCalledWith(
        'user123',
        'gitlab_12345',
        testConfigInput
      );
    });

    it('should reject invalid user', async () => {
      mockedUserRepository.findUserByToken.mockResolvedValue(null);

      await expect(service.createConfig('invalid_token', testConfigInput))
        .rejects.toThrow(ConfigurationError);
      await expect(service.createConfig('invalid_token', testConfigInput))
        .rejects.toThrow('User not found');
    });

    it('should record failed connection test but still create config', async () => {
      mockGitlabInstance.Users.current.mockRejectedValue(new Error('401 Unauthorized'));

      const result = await service.createConfig('gitlab_12345', testConfigInput);

      expect(result).toEqual(testConfig);
      expect(mockedGitlabConfigRepository.updateTestResult).toHaveBeenCalledWith(
        testConfig.id,
        expect.objectContaining({
          success: false,
          message: 'Invalid access token or insufficient permissions'
        })
      );
    });

    it('should handle GitLab URL without protocol', async () => {
      const configWithoutProtocol = {
        ...testConfigInput,
        gitlabUrl: 'gitlab.example.com'
      };

      await service.createConfig('gitlab_12345', configWithoutProtocol);

      expect(MockedGitlab).toHaveBeenCalledWith({
        host: 'https://gitlab.example.com',
        token: 'glpat-test-token'
      });
    });
  });

  describe('getUserConfigs', () => {
    beforeEach(() => {
      mockedUserRepository.findUserByToken.mockResolvedValue(testUser);
      mockedGitlabConfigRepository.getUserConfigs.mockResolvedValue([testConfig]);
    });

    it('should get user configs successfully', async () => {
      const result = await service.getUserConfigs('gitlab_12345');

      expect(result).toEqual([testConfig]);
      expect(mockedUserRepository.findUserByToken).toHaveBeenCalledWith('gitlab_12345');
      expect(mockedGitlabConfigRepository.getUserConfigs).toHaveBeenCalledWith('user123');
    });

    it('should reject invalid user', async () => {
      mockedUserRepository.findUserByToken.mockResolvedValue(null);

      await expect(service.getUserConfigs('invalid_token'))
        .rejects.toThrow(ConfigurationError);
      await expect(service.getUserConfigs('invalid_token'))
        .rejects.toThrow('User not found');
    });
  });

  describe('getConfigById', () => {
    it('should get config by ID successfully', async () => {
      mockedGitlabConfigRepository.getConfigById.mockResolvedValue(testConfig);

      const result = await service.getConfigById('config123');

      expect(result).toEqual(testConfig);
      expect(mockedGitlabConfigRepository.getConfigById).toHaveBeenCalledWith('config123');
    });

    it('should return null for non-existent config', async () => {
      mockedGitlabConfigRepository.getConfigById.mockResolvedValue(null);

      const result = await service.getConfigById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('updateConfig', () => {
    const updates = {
      name: 'Updated Config',
      description: 'Updated description'
    };

    beforeEach(() => {
      mockedGitlabConfigRepository.updateConfig.mockResolvedValue({
        ...testConfig,
        ...updates
      });
    });

    it('should update config metadata without testing connection', async () => {
      const result = await service.updateConfig('config123', updates);

      expect(result.name).toBe('Updated Config');
      expect(result.description).toBe('Updated description');
      expect(mockedGitlabConfigRepository.updateConfig).toHaveBeenCalledWith('config123', updates);
      expect(MockedGitlab).not.toHaveBeenCalled();
    });

    it('should test connection when updating access token', async () => {
      const updatesWithToken = { ...updates, accessToken: 'new-token' };

      mockedGitlabConfigRepository.getDecryptedConfig.mockResolvedValue(testConfigInput);
      mockGitlabInstance.Users.current.mockResolvedValue(mockGitlabUser);
      mockedGitlabConfigRepository.updateTestResult.mockResolvedValue();

      await service.updateConfig('config123', updatesWithToken);

      expect(MockedGitlab).toHaveBeenCalled();
      expect(mockGitlabInstance.Users.current).toHaveBeenCalled();
      expect(mockedGitlabConfigRepository.updateTestResult).toHaveBeenCalled();
    });

    it('should reject update if connection test fails', async () => {
      const updatesWithToken = { ...updates, accessToken: 'invalid-token' };

      mockedGitlabConfigRepository.getDecryptedConfig.mockResolvedValue(testConfigInput);
      mockGitlabInstance.Users.current.mockRejectedValue(new Error('401 Unauthorized'));

      await expect(service.updateConfig('config123', updatesWithToken))
        .rejects.toThrow(ConfigurationError);
      await expect(service.updateConfig('config123', updatesWithToken))
        .rejects.toThrow('GitLab connection test failed');
    });
  });

  describe('deleteConfig', () => {
    it('should delete config successfully', async () => {
      mockedGitlabConfigRepository.deleteConfig.mockResolvedValue();

      await service.deleteConfig('config123');

      expect(mockedGitlabConfigRepository.deleteConfig).toHaveBeenCalledWith('config123');
    });
  });

  describe('setDefaultConfig', () => {
    beforeEach(() => {
      mockedUserRepository.findUserByToken.mockResolvedValue(testUser);
      mockedGitlabConfigRepository.getConfigById.mockResolvedValue(testConfig);
      mockedGitlabConfigRepository.setDefaultConfig.mockResolvedValue();
    });

    it('should set default config successfully', async () => {
      await service.setDefaultConfig('gitlab_12345', 'config123');

      expect(mockedUserRepository.findUserByToken).toHaveBeenCalledWith('gitlab_12345');
      expect(mockedGitlabConfigRepository.getConfigById).toHaveBeenCalledWith('config123');
      expect(mockedGitlabConfigRepository.setDefaultConfig).toHaveBeenCalledWith('user123', 'config123');
    });

    it('should reject invalid user', async () => {
      mockedUserRepository.findUserByToken.mockResolvedValue(null);

      await expect(service.setDefaultConfig('invalid_token', 'config123'))
        .rejects.toThrow(ConfigurationError);
      await expect(service.setDefaultConfig('invalid_token', 'config123'))
        .rejects.toThrow('User not found');
    });

    it('should reject config that does not belong to user', async () => {
      mockedGitlabConfigRepository.getConfigById.mockResolvedValue({
        ...testConfig,
        userId: 'different_user'
      });

      await expect(service.setDefaultConfig('gitlab_12345', 'config123'))
        .rejects.toThrow(ConfigurationError);
      await expect(service.setDefaultConfig('gitlab_12345', 'config123'))
        .rejects.toThrow('Configuration not found or does not belong to user');
    });
  });

  describe('testConnection', () => {
    beforeEach(() => {
      mockGitlabInstance.Users.current.mockResolvedValue(mockGitlabUser);
    });

    it('should test connection successfully', async () => {
      const result = await service.testConnection(testConfigInput);

      expect(result.success).toBe(true);
      expect(result.message).toContain('Successfully connected to GitLab as testuser');
      expect(result.details).toEqual(mockGitlabUser);
    });

    it('should handle 401 error', async () => {
      mockGitlabInstance.Users.current.mockRejectedValue(new Error('401 Unauthorized'));

      const result = await service.testConnection(testConfigInput);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Invalid access token or insufficient permissions');
    });

    it('should handle 403 error', async () => {
      mockGitlabInstance.Users.current.mockRejectedValue(new Error('403 Forbidden'));

      const result = await service.testConnection(testConfigInput);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Access forbidden - check token permissions');
    });

    it('should handle 404 error', async () => {
      mockGitlabInstance.Users.current.mockRejectedValue(new Error('404 Not Found'));

      const result = await service.testConnection(testConfigInput);

      expect(result.success).toBe(false);
      expect(result.message).toBe('GitLab instance not found - check URL');
    });

    it('should handle timeout error', async () => {
      mockGitlabInstance.Users.current.mockRejectedValue(new Error('timeout'));

      const result = await service.testConnection(testConfigInput);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Connection timeout - check URL and network connectivity');
    });

    it('should handle SSL certificate error', async () => {
      mockGitlabInstance.Users.current.mockRejectedValue(new Error('SSL certificate error'));

      const result = await service.testConnection(testConfigInput);

      expect(result.success).toBe(false);
      expect(result.message).toBe('SSL certificate error - check if instance uses valid certificates');
    });

    it('should handle invalid URL format', async () => {
      const invalidConfig = {
        ...testConfigInput,
        gitlabUrl: '://bad-url'
      };

      const result = await service.testConnection(invalidConfig);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Invalid GitLab URL format');
    });
  });

  describe('validateWebhookSecret', () => {
    it('should validate webhook secret successfully', async () => {
      mockedGitlabConfigRepository.getDecryptedConfig.mockResolvedValue(testConfigInput);

      const result = await service.validateWebhookSecret('config123', 'webhook-secret');

      expect(result).toBe(true);
      expect(mockedGitlabConfigRepository.getDecryptedConfig).toHaveBeenCalledWith('config123');
    });

    it('should reject invalid webhook secret', async () => {
      mockedGitlabConfigRepository.getDecryptedConfig.mockResolvedValue(testConfigInput);

      const result = await service.validateWebhookSecret('config123', 'wrong-secret');

      expect(result).toBe(false);
    });

    it('should return false for non-existent config', async () => {
      mockedGitlabConfigRepository.getDecryptedConfig.mockResolvedValue(null);

      const result = await service.validateWebhookSecret('nonexistent', 'any-secret');

      expect(result).toBe(false);
    });

    it('should handle errors gracefully', async () => {
      mockedGitlabConfigRepository.getDecryptedConfig.mockRejectedValue(new Error('DB error'));

      const result = await service.validateWebhookSecret('config123', 'webhook-secret');

      expect(result).toBe(false);
    });
  });

  describe('getDecryptedConfigForUser', () => {
    beforeEach(() => {
      mockedUserRepository.findUserByToken.mockResolvedValue(testUser);
      mockedGitlabConfigRepository.getDecryptedConfig.mockResolvedValue(testConfigInput);
    });

    it('should get specific config for user', async () => {
      mockedGitlabConfigRepository.getConfigById.mockResolvedValue(testConfig);

      const result = await service.getDecryptedConfigForUser('gitlab_12345', 'config123');

      expect(result).toEqual(testConfigInput);
      expect(mockedGitlabConfigRepository.getConfigById).toHaveBeenCalledWith('config123');
    });

    it('should get default config for user', async () => {
      mockedGitlabConfigRepository.getDefaultConfig.mockResolvedValue(testConfig);

      const result = await service.getDecryptedConfigForUser('gitlab_12345');

      expect(result).toEqual(testConfigInput);
      expect(mockedGitlabConfigRepository.getDefaultConfig).toHaveBeenCalledWith('user123');
    });

    it('should reject invalid user', async () => {
      mockedUserRepository.findUserByToken.mockResolvedValue(null);

      await expect(service.getDecryptedConfigForUser('invalid_token'))
        .rejects.toThrow(ConfigurationError);
      await expect(service.getDecryptedConfigForUser('invalid_token'))
        .rejects.toThrow('User not found');
    });

    it('should reject config that does not belong to user', async () => {
      mockedGitlabConfigRepository.getConfigById.mockResolvedValue({
        ...testConfig,
        userId: 'different_user'
      });

      await expect(service.getDecryptedConfigForUser('gitlab_12345', 'config123'))
        .rejects.toThrow(ConfigurationError);
      await expect(service.getDecryptedConfigForUser('gitlab_12345', 'config123'))
        .rejects.toThrow('Configuration not found or does not belong to user');
    });

    it('should return null when no config found', async () => {
      mockedGitlabConfigRepository.getDefaultConfig.mockResolvedValue(null);

      const result = await service.getDecryptedConfigForUser('gitlab_12345');

      expect(result).toBeNull();
    });
  });
});
