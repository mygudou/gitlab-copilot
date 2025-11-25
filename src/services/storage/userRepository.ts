import crypto from 'crypto';
import type { Collection } from 'mongodb';
import { getMongoDb } from './mongoClient';
import { decryptSecret, encryptSecret } from '../../utils/secretVault';
import { TenantUserContext } from '../../types/tenant';
import { config } from '../../utils/config';
import logger from '../../utils/logger';
import { getUserConfigs, getDefaultConfig, getConfigByToken } from './gitlabConfigRepository';

export interface UserDocument {
  _id?: unknown;
  userToken: string;
  username?: string; // New field for web authentication
  email?: string;
  passwordHash?: string; // New field for web authentication
  displayName?: string;
  gitlabHost?: string;
  encryptedPat: string;
  encryptedWebhookSecret: string;
  isEmailVerified?: boolean; // New field for email verification
  loginAttempts?: number; // New field for account lockout protection
  lockUntil?: Date; // New field for account lockout
  lastLogin?: Date; // New field for tracking last login
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ResolvedTenantUser {
  user: TenantUserContext;
  secret: string;
}

export interface UpsertUserInput {
  userToken?: string;
  username?: string; // New field for web authentication
  email?: string;
  passwordHash?: string; // New field for web authentication
  displayName?: string;
  gitlabHost?: string;
  pat: string;
  webhookSecret: string;
  isEmailVerified?: boolean; // New field for email verification
}

export interface UpsertUserResult {
  userToken: string;
  operation: 'created' | 'updated';
}

const COLLECTION_NAME = 'users';

function ensurePlatformMode(): void {
  if (!config.platform.hasMongoCredentials) {
    throw new Error('MongoDB is not configured for platform mode');
  }
}

async function getUsersCollection(): Promise<Collection<UserDocument>> {
  ensurePlatformMode();
  const db = await getMongoDb();
  return db.collection<UserDocument>(COLLECTION_NAME);
}

function normalizeId(id: unknown, fallback: string): string {
  if (typeof id === 'string') {
    return id;
  }

  if (id && typeof (id as { toString?: () => string }).toString === 'function') {
    try {
      return (id as { toString: () => string }).toString();
    } catch (error) {
      logger.warn('Failed to convert Mongo _id to string', { error });
    }
  }

  return fallback;
}

export async function findUserByToken(userToken: string): Promise<UserDocument | null> {
  if (!config.platform.hasMongoCredentials) {
    return null;
  }

  try {
    const collection = await getUsersCollection();
    return await collection.findOne({ userToken });
  } catch (error) {
    logger.error('Failed to find user by token', {
      userToken,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function findUserByEmail(email: string): Promise<UserDocument | null> {
  if (!config.platform.hasMongoCredentials) {
    return null;
  }

  try {
    const collection = await getUsersCollection();
    return await collection.findOne({ email });
  } catch (error) {
    logger.error('Failed to find user by email', {
      email,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function findUserByUsername(username: string): Promise<UserDocument | null> {
  if (!config.platform.hasMongoCredentials) {
    return null;
  }

  try {
    const collection = await getUsersCollection();
    return await collection.findOne({ username });
  } catch (error) {
    logger.error('Failed to find user by username', {
      username,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function findUserByEmailOrUsername(identifier: string): Promise<UserDocument | null> {
  if (!config.platform.hasMongoCredentials) {
    return null;
  }

  try {
    const collection = await getUsersCollection();
    return await collection.findOne({
      $or: [{ email: identifier }, { username: identifier }]
    });
  } catch (error) {
    logger.error('Failed to find user by email or username', {
      identifier,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function mapUserToTenant(user: UserDocument): ResolvedTenantUser | null {
  const pat = decryptSecret(user.encryptedPat);
  const webhookSecret = decryptSecret(user.encryptedWebhookSecret);

  if (!pat || !webhookSecret) {
    logger.warn('User secrets are empty after decryption', {
      userToken: user.userToken,
      hasPat: Boolean(pat),
      hasWebhookSecret: Boolean(webhookSecret),
    });
    return null;
  }

  const gitlabBaseUrl = user.gitlabHost?.trim() || config.gitlab.baseUrl;
  const tenantUser: TenantUserContext = {
    userId: normalizeId(user._id, user.userToken),
    userToken: user.userToken,
    gitlabBaseUrl,
    gitlabAccessToken: pat,
    displayName: user.displayName,
    email: user.email,
    platformUserId: normalizeId(user._id, user.userToken),
    isLegacyFallback: false,
  };

  return {
    user: tenantUser,
    secret: webhookSecret,
  };
}

export async function resolveTenantByToken(token: string): Promise<ResolvedTenantUser | null> {
  if (!config.platform.hasMongoCredentials) {
    return null;
  }

  try {
    // 优先尝试作为 configToken 解析（支持多配置）
    if (token.startsWith('glconfig_')) {
      const gitlabConfig = await getConfigByToken(token);
      if (gitlabConfig) {
        const pat = decryptSecret(gitlabConfig.encryptedAccessToken);
        const webhookSecret = decryptSecret(gitlabConfig.encryptedWebhookSecret);

        if (!pat || !webhookSecret) {
          logger.warn('GitLab config secrets are empty after decryption', {
            configToken: token,
            configId: gitlabConfig.id,
            hasPat: Boolean(pat),
            hasWebhookSecret: Boolean(webhookSecret),
          });
          return null;
        }

        logger.info('Resolved tenant via configToken', {
          configToken: token,
          configId: gitlabConfig.id,
          gitlabUrl: gitlabConfig.gitlabUrl,
        });

        const tenantUser: TenantUserContext = {
          userId: gitlabConfig.id,
          userToken: gitlabConfig.userToken,
          gitlabBaseUrl: gitlabConfig.gitlabUrl,
          gitlabAccessToken: pat,
          displayName: gitlabConfig.name,
          gitlabConfigId: gitlabConfig.id,
          platformUserId: gitlabConfig.userId,
          isLegacyFallback: false,
        };

        return {
          user: tenantUser,
          secret: webhookSecret,
        };
      }

      // configToken格式但未找到配置
      logger.warn('Config token not found', { configToken: token });
      return null;
    }

    // 回退：作为 userToken 解析（兼容旧方式）
    const user = await findUserByToken(token);
    if (!user) {
      return null;
    }

    const userId = normalizeId(user._id, user.userToken);

    // Try to get GitLab configuration from gitlabConfig table (new way)
    // Use the default config if available, otherwise fallback to first config
    let gitlabConfig = await getDefaultConfig(userId);

    if (!gitlabConfig) {
      const configs = await getUserConfigs(userId);
      if (configs.length > 0) {
        gitlabConfig = configs[0];
        logger.warn('No default config found, using first config', {
          userToken: token,
          configId: gitlabConfig.id,
        });
      }
    }

    if (gitlabConfig) {

      const pat = decryptSecret(gitlabConfig.encryptedAccessToken);
      const webhookSecret = decryptSecret(gitlabConfig.encryptedWebhookSecret);

      if (!pat || !webhookSecret) {
        logger.warn('GitLab config secrets are empty after decryption', {
          userToken: token,
          configId: gitlabConfig.id,
          hasPat: Boolean(pat),
          hasWebhookSecret: Boolean(webhookSecret),
        });
        return null;
      }

      logger.info('Resolved tenant via gitlab_configs (default config)', {
        userToken: token,
        configId: gitlabConfig.id,
        gitlabUrl: gitlabConfig.gitlabUrl,
      });

      const tenantUser: TenantUserContext = {
        userId: gitlabConfig.id,
        userToken: token,
        gitlabBaseUrl: gitlabConfig.gitlabUrl,
        gitlabAccessToken: pat,
        displayName: gitlabConfig.name,
        gitlabConfigId: gitlabConfig.id,
        platformUserId: userId,
        isLegacyFallback: false,
      };

      return {
        user: tenantUser,
        secret: webhookSecret,
      };
    }

    // Fallback: use secrets stored on legacy users collection (backward compatibility)
    const legacyTenant = mapUserToTenant(user);
    if (legacyTenant) {
      logger.info('Resolved tenant via legacy users collection', {
        userToken: token,
        gitlabUrl: legacyTenant.user.gitlabBaseUrl,
        isLegacyFallback: true,
      });
    }

    return legacyTenant;
  } catch (error) {
    logger.error('Failed to resolve tenant by token', {
      token,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function generateUserToken(): string {
  const base = crypto.randomUUID().replace(/-/g, '');
  return `gitlab_${base}`;
}

export async function upsertUser(input: UpsertUserInput): Promise<UpsertUserResult> {
  ensurePlatformMode();

  const collection = await getUsersCollection();
  const now = new Date();

  let userToken = input.userToken?.trim();
  if (!userToken && input.email) {
    const existingByEmail = await findUserByEmail(input.email.trim());
    if (existingByEmail) {
      userToken = existingByEmail.userToken;
    }
  }

  if (!userToken) {
    userToken = generateUserToken();
  }

  const normalizedHost = input.gitlabHost?.trim();

  const update: Partial<UserDocument> = {
    userToken,
    username: input.username?.trim() || undefined,
    email: input.email?.trim() || undefined,
    passwordHash: input.passwordHash || undefined,
    displayName: input.displayName?.trim() || undefined,
    gitlabHost: normalizedHost && normalizedHost.length > 0 ? normalizedHost : undefined,
    encryptedPat: encryptSecret(input.pat),
    encryptedWebhookSecret: encryptSecret(input.webhookSecret),
    isEmailVerified: input.isEmailVerified !== undefined ? input.isEmailVerified : undefined,
    updatedAt: now,
  };

  const result = await collection.updateOne(
    { userToken },
    {
      $set: update,
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true }
  );

  const operation: UpsertUserResult['operation'] = result.upsertedId ? 'created' : 'updated';

  return {
    userToken,
    operation,
  };
}
