/**
 * 自动迁移：为缺少configToken的配置添加configToken
 */

import { getMongoDb } from './mongoClient';
import { generateConfigToken } from './gitlabConfigRepository';
import logger from '../../utils/logger';
import { config } from '../../utils/config';

export async function ensureConfigTokens(): Promise<void> {
  if (!config.platform.hasMongoCredentials) {
    return;
  }

  try {
    const db = await getMongoDb();
    const collection = db.collection('gitlab_configs');

    // 查找所有没有configToken的配置
    const configsWithoutToken = await collection.find({
      $or: [
        { configToken: { $exists: false } },
        { configToken: null },
        { configToken: '' }
      ]
    }).toArray();

    if (configsWithoutToken.length === 0) {
      logger.debug('All configs have configToken');
      return;
    }

    logger.info(`Found ${configsWithoutToken.length} configs without configToken, migrating...`);

    let updated = 0;
    for (const doc of configsWithoutToken) {
      const configToken = generateConfigToken();

      await collection.updateOne(
        { _id: doc._id },
        {
          $set: {
            configToken,
            updatedAt: new Date()
          }
        }
      );

      logger.info(`Updated config ${doc._id} (${doc.name}) with configToken: ${configToken}`);
      updated++;
    }

    logger.info(`ConfigToken migration completed. Updated ${updated} configs.`);
  } catch (error) {
    logger.error('ConfigToken migration failed:', error);
    // Don't throw - allow app to start even if migration fails
  }
}
