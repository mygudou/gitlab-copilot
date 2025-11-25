import { getMongoDb } from '../services/storage/mongoClient';
import logger from '../utils/logger';

interface IndexDefinition {
  collection: string;
  name: string;
  spec: any;
  options?: any;
}

const indexes: IndexDefinition[] = [
  // Users collection indexes
  {
    collection: 'users',
    name: 'email_unique',
    spec: { email: 1 },
    options: { unique: true, sparse: true }
  },
  {
    collection: 'users',
    name: 'username_unique',
    spec: { username: 1 },
    options: { unique: true, sparse: true }
  },
  {
    collection: 'users',
    name: 'userToken_unique',
    spec: { userToken: 1 },
    options: { unique: true }
  },
  {
    collection: 'users',
    name: 'lockUntil_expiry',
    spec: { lockUntil: 1 },
    options: { expireAfterSeconds: 0, sparse: true }
  },

  // GitLab configs collection indexes
  {
    collection: 'gitlab_configs',
    name: 'userId_index',
    spec: { userId: 1 }
  },
  {
    collection: 'gitlab_configs',
    name: 'userId_isDefault',
    spec: { userId: 1, isDefault: 1 }
  },
  {
    collection: 'gitlab_configs',
    name: 'userId_isActive',
    spec: { userId: 1, isActive: 1 }
  },
  {
    collection: 'gitlab_configs',
    name: 'userToken_index',
    spec: { userToken: 1 }
  },

  // Web sessions collection indexes
  {
    collection: 'web_sessions',
    name: 'sessionId_unique',
    spec: { sessionId: 1 },
    options: { unique: true }
  },
  {
    collection: 'web_sessions',
    name: 'userId_index',
    spec: { userId: 1 }
  },
  {
    collection: 'web_sessions',
    name: 'expiresAt_expiry',
    spec: { expiresAt: 1 },
    options: { expireAfterSeconds: 0 }
  },
  {
    collection: 'web_sessions',
    name: 'isActive_expiresAt',
    spec: { isActive: 1, expiresAt: 1 }
  },
  {
    collection: 'web_sessions',
    name: 'accessTokenHash_index',
    spec: { accessTokenHash: 1 }
  },
  {
    collection: 'web_sessions',
    name: 'refreshTokenHash_index',
    spec: { refreshTokenHash: 1 }
  }
];

async function createIndex(db: any, indexDef: IndexDefinition): Promise<boolean> {
  try {
    const collection = db.collection(indexDef.collection);

    // Check if index already exists
    const existingIndexes = await collection.indexes();
    const indexExists = existingIndexes.some((idx: any) => idx.name === indexDef.name);

    if (indexExists) {
      logger.info(`Index ${indexDef.name} already exists on collection ${indexDef.collection}`);
      return true;
    }

    // Create the index
    await collection.createIndex(indexDef.spec, {
      name: indexDef.name,
      ...indexDef.options
    });

    logger.info(`Created index ${indexDef.name} on collection ${indexDef.collection}`);
    return true;
  } catch (error) {
    logger.error(`Failed to create index ${indexDef.name} on collection ${indexDef.collection}`, {
      error: error instanceof Error ? error.message : String(error),
      spec: indexDef.spec,
      options: indexDef.options
    });
    return false;
  }
}

async function createAllIndexes(): Promise<void> {
  let successCount = 0;
  let failCount = 0;

  try {
    const db = await getMongoDb();
    logger.info(`Starting database index creation for ${indexes.length} indexes`);

    for (const indexDef of indexes) {
      const success = await createIndex(db, indexDef);
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
    }

    logger.info('Database index creation completed', {
      total: indexes.length,
      successful: successCount,
      failed: failCount
    });

    if (failCount > 0) {
      logger.warn(`${failCount} indexes failed to create. Check logs for details.`);
      process.exit(1);
    } else {
      logger.info('All database indexes created successfully');
    }
  } catch (error) {
    logger.error('Database index creation failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  }
}

async function listIndexes(): Promise<void> {
  try {
    const db = await getMongoDb();
    const collections = ['users', 'gitlab_configs', 'web_sessions'];

    for (const collectionName of collections) {
      logger.info(`\nIndexes for collection: ${collectionName}`);

      try {
        const collection = db.collection(collectionName);
        const indexes = await collection.indexes();

        for (const index of indexes) {
          logger.info(`  - ${index.name}: ${JSON.stringify(index.key)}`);
        }
      } catch (error) {
        logger.warn(`Collection ${collectionName} does not exist or is not accessible`);
      }
    }
  } catch (error) {
    logger.error('Failed to list indexes', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function dropIndexes(): Promise<void> {
  try {
    const db = await getMongoDb();
    logger.info('Dropping all custom indexes...');

    for (const indexDef of indexes) {
      try {
        const collection = db.collection(indexDef.collection);
        await collection.dropIndex(indexDef.name);
        logger.info(`Dropped index ${indexDef.name} from collection ${indexDef.collection}`);
      } catch (error) {
        // Index might not exist, which is fine
        logger.warn(`Could not drop index ${indexDef.name} from collection ${indexDef.collection}: ${error}`);
      }
    }

    logger.info('Finished dropping indexes');
  } catch (error) {
    logger.error('Failed to drop indexes', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// Command line interface
async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case 'create':
      await createAllIndexes();
      break;
    case 'list':
      await listIndexes();
      break;
    case 'drop':
      await dropIndexes();
      break;
    default:
      console.log(`
Usage: npm run db:indexes <command>

Commands:
  create    Create all database indexes
  list      List existing indexes
  drop      Drop all custom indexes

Examples:
  npm run db:indexes create
  npm run db:indexes list
  npm run db:indexes drop
      `);
      process.exit(1);
  }

  process.exit(0);
}

// Only run if this script is executed directly
if (require.main === module) {
  main().catch((error) => {
    logger.error('Script execution failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    process.exit(1);
  });
}

export { createAllIndexes, listIndexes, dropIndexes };