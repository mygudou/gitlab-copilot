import crypto from 'crypto';
import type { Collection } from 'mongodb';
import { getMongoDb } from './mongoClient';
import { encryptSecret, decryptSecret } from '../../utils/secretVault';
import { GitLabConfigDocument, GitLabConfigInput, GitLabConfig, ConnectionTestResult } from '../../types/auth';
import { config } from '../../utils/config';
import logger from '../../utils/logger';

const COLLECTION_NAME = 'gitlab_configs';

// Use require to import ObjectId (workaround for TypeScript type issues)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ObjectId } = require('mongodb');

// Helper function to convert string to MongoDB ObjectId
function toObjectId(id: string): any {
  return new ObjectId(id);
}

// Helper function to check if string is valid ObjectId
function isValidObjectId(id: string): boolean {
  try {
    return ObjectId.isValid(id);
  } catch {
    return false;
  }
}

function ensurePlatformMode(): void {
  if (!config.platform.hasMongoCredentials) {
    throw new Error('MongoDB is not configured for platform mode');
  }
}

async function getConfigsCollection(): Promise<Collection<GitLabConfigDocument>> {
  ensurePlatformMode();
  const db = await getMongoDb();
  return db.collection<GitLabConfigDocument>(COLLECTION_NAME);
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

function mapDocumentToConfig(doc: GitLabConfigDocument): GitLabConfig {
  return {
    id: normalizeId(doc._id, crypto.randomUUID()),
    userId: doc.userId,
    userToken: doc.userToken,
    configToken: doc.configToken,
    name: doc.name,
    gitlabUrl: doc.gitlabUrl,
    encryptedAccessToken: doc.encryptedAccessToken,
    encryptedWebhookSecret: doc.encryptedWebhookSecret,
    description: doc.description,
    isDefault: doc.isDefault,
    isActive: doc.isActive,
    lastTested: doc.lastTested,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function generateConfigToken(): string {
  const base = crypto.randomUUID().replace(/-/g, '');
  return `glconfig_${base}`;
}

export async function createConfig(userId: string, userToken: string, configData: GitLabConfigInput): Promise<GitLabConfig> {
  ensurePlatformMode();

  const collection = await getConfigsCollection();
  const now = new Date();

  // Check if this is the first config for the user (make it default)
  const existingConfigs = await collection.countDocuments({ userId });
  const isDefault = existingConfigs === 0;

  // Auto-generate webhook secret if not provided
  let webhookSecret = configData.webhookSecret;
  if (!webhookSecret || webhookSecret.trim() === '') {
    // Generate a secure random webhook secret (32 bytes = 64 hex characters)
    webhookSecret = crypto.randomBytes(32).toString('hex');
    logger.info('Auto-generated webhook secret for new config', { userId });
  }

  // Generate unique config token for webhook routing
  const configToken = generateConfigToken();

  // Use default name if not provided
  const configName = configData.name && configData.name.trim() !== ''
    ? configData.name.trim()
    : 'GitLab 配置';

  const document: Omit<GitLabConfigDocument, '_id'> = {
    userId,
    userToken,
    configToken,
    name: configName,
    gitlabUrl: configData.gitlabUrl.trim(),
    encryptedAccessToken: encryptSecret(configData.accessToken),
    encryptedWebhookSecret: encryptSecret(webhookSecret),
    description: configData.description?.trim(),
    isDefault,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const result = await collection.insertOne(document);
    const created: GitLabConfigDocument = { ...document, _id: result.insertedId as any };
    return mapDocumentToConfig(created);
  } catch (error) {
    logger.error('Failed to create GitLab config', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function getUserConfigs(userId: string): Promise<GitLabConfig[]> {
  if (!config.platform.hasMongoCredentials) {
    return [];
  }

  try {
    const collection = await getConfigsCollection();
    const docs = await collection.find({ userId, isActive: true })
      .sort({ isDefault: -1, createdAt: -1 })
      .toArray();

    // 过滤并警告没有configToken的记录
    const validDocs = docs.filter(doc => {
      if (!doc.configToken) {
        logger.warn('Config missing configToken, please run migration script', {
          userId,
          configId: doc._id,
          configName: doc.name
        });
        return false;
      }
      return true;
    });

    return validDocs.map(mapDocumentToConfig);
  } catch (error) {
    logger.error('Failed to get user configs', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function getConfigById(configId: string): Promise<GitLabConfig | null> {
  if (!config.platform.hasMongoCredentials) {
    return null;
  }

  try {
    const collection = await getConfigsCollection();

    // Try to convert to ObjectId, fallback to string if invalid
    let query: any;
    if (isValidObjectId(configId)) {
      query = { _id: toObjectId(configId) };
    } else {
      query = { _id: configId };
    }

    const doc = await collection.findOne(query);

    return doc ? mapDocumentToConfig(doc) : null;
  } catch (error) {
    logger.error('Failed to get config by ID', {
      configId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function getConfigByToken(configToken: string): Promise<GitLabConfig | null> {
  if (!config.platform.hasMongoCredentials) {
    return null;
  }

  try {
    const collection = await getConfigsCollection();
    const doc = await collection.findOne({
      configToken,
      isActive: true
    });

    return doc ? mapDocumentToConfig(doc) : null;
  } catch (error) {
    logger.error('Failed to get config by token', {
      configToken,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function updateConfig(configId: string, updates: Partial<GitLabConfigInput>): Promise<GitLabConfig> {
  ensurePlatformMode();

  const collection = await getConfigsCollection();
  const now = new Date();

  const updateDoc: Partial<GitLabConfigDocument> = {
    updatedAt: now,
  };

  if (updates.name !== undefined) {
    updateDoc.name = updates.name.trim();
  }
  if (updates.gitlabUrl !== undefined) {
    updateDoc.gitlabUrl = updates.gitlabUrl.trim();
  }
  if (updates.accessToken !== undefined) {
    updateDoc.encryptedAccessToken = encryptSecret(updates.accessToken);
  }
  // 仅在明确提供了非空值时才更新webhookSecret
  if (updates.webhookSecret !== undefined && updates.webhookSecret.trim() !== '') {
    updateDoc.encryptedWebhookSecret = encryptSecret(updates.webhookSecret);
  }
  if (updates.description !== undefined) {
    updateDoc.description = updates.description?.trim();
  }

  try {
    // Try to convert to ObjectId, fallback to string if invalid
    let query: any;
    if (isValidObjectId(configId)) {
      query = { _id: toObjectId(configId) };
    } else {
      query = { _id: configId };
    }

    const result = await collection.findOneAndUpdate(
      query,
      { $set: updateDoc },
      { returnDocument: 'after' }
    );

    if (!result) {
      throw new Error(`Config with ID ${configId} not found`);
    }

    return mapDocumentToConfig(result as unknown as GitLabConfigDocument);
  } catch (error) {
    logger.error('Failed to update config', {
      configId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function deleteConfig(configId: string): Promise<void> {
  ensurePlatformMode();

  const collection = await getConfigsCollection();

  try {
    // Try to convert to ObjectId, fallback to string if invalid
    let query: any;
    if (isValidObjectId(configId)) {
      query = { _id: toObjectId(configId) };
    } else {
      query = { _id: configId };
    }

    const result = await collection.updateOne(
      query,
      {
        $set: {
          isActive: false,
          updatedAt: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      throw new Error(`Config with ID ${configId} not found`);
    }

    logger.info('Config marked as inactive', { configId });
  } catch (error) {
    logger.error('Failed to delete config', {
      configId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function setDefaultConfig(userId: string, configId: string): Promise<void> {
  ensurePlatformMode();

  const collection = await getConfigsCollection();

  try {
    // Remove default flag from all user configs
    await collection.updateMany(
      { userId },
      { $set: { isDefault: false, updatedAt: new Date() } }
    );

    // Try to convert to ObjectId, fallback to string if invalid
    let query: any;
    if (isValidObjectId(configId)) {
      query = { _id: toObjectId(configId), userId };
    } else {
      query = { _id: configId, userId };
    }

    // Set the new default config
    const result = await collection.updateOne(
      query,
      { $set: { isDefault: true, updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) {
      throw new Error(`Config with ID ${configId} not found for user ${userId}`);
    }
  } catch (error) {
    logger.error('Failed to set default config', {
      userId,
      configId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function getDefaultConfig(userId: string): Promise<GitLabConfig | null> {
  if (!config.platform.hasMongoCredentials) {
    return null;
  }

  try {
    const collection = await getConfigsCollection();
    const doc = await collection.findOne({
      userId,
      isDefault: true,
      isActive: true
    });

    return doc ? mapDocumentToConfig(doc) : null;
  } catch (error) {
    logger.error('Failed to get default config', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function updateTestResult(configId: string, testResult: ConnectionTestResult): Promise<void> {
  ensurePlatformMode();

  const collection = await getConfigsCollection();

  try {
    // Try to convert to ObjectId, fallback to string if invalid
    let query: any;
    if (isValidObjectId(configId)) {
      query = { _id: toObjectId(configId) };
    } else {
      query = { _id: configId };
    }

    await collection.updateOne(
      query,
      {
        $set: {
          lastTested: new Date(),
          testResult: {
            success: testResult.success,
            message: testResult.message,
            testedAt: new Date()
          },
          updatedAt: new Date()
        }
      }
    );
  } catch (error) {
    logger.error('Failed to update test result', {
      configId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// Helper function to get decrypted config for GitLab API operations
export async function getDecryptedConfig(configId: string): Promise<GitLabConfigInput | null> {
  const config = await getConfigById(configId);
  if (!config) {
    return null;
  }

  try {
    return {
      name: config.name,
      gitlabUrl: config.gitlabUrl,
      accessToken: decryptSecret(config.encryptedAccessToken),
      webhookSecret: decryptSecret(config.encryptedWebhookSecret),
      description: config.description,
    };
  } catch (error) {
    logger.error('Failed to decrypt config', {
      configId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}