#!/usr/bin/env node
/**
 * 数据迁移脚本：为现有的GitLab配置添加configToken字段
 * 运行方式：npx ts-node src/scripts/migrateConfigTokens.ts
 */

import { getMongoDb } from '../services/storage/mongoClient';
import { generateConfigToken } from '../services/storage/gitlabConfigRepository';
import logger from '../utils/logger';

async function migrateConfigTokens() {
  try {
    logger.info('Starting configToken migration...');

    const db = await getMongoDb();
    const collection = db.collection('gitlab_configs');

    // 查找所有没有configToken的配置
    const configsWithoutToken = await collection.find({
      configToken: { $exists: false }
    }).toArray();

    logger.info(`Found ${configsWithoutToken.length} configs without configToken`);

    let updated = 0;
    for (const config of configsWithoutToken) {
      const configToken = generateConfigToken();

      await collection.updateOne(
        { _id: config._id },
        {
          $set: {
            configToken,
            updatedAt: new Date()
          }
        }
      );

      logger.info(`Updated config ${config._id} with configToken: ${configToken}`);
      updated++;
    }

    logger.info(`Migration completed. Updated ${updated} configs.`);
    process.exit(0);
  } catch (error) {
    logger.error('Migration failed:', error);
    process.exit(1);
  }
}

migrateConfigTokens();
