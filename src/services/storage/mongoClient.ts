import type { MongoClient, Db, MongoClientOptions } from 'mongodb';
import { config } from '../../utils/config';
import logger from '../../utils/logger';

let client: MongoClient | null = null;
let dbInstance: Db | null = null;

function ensureMongoConfig(): void {
  if (!config.platform.hasMongoCredentials) {
    throw new Error('MongoDB configuration is not complete. Please set MONGODB_URI, MONGODB_DB and ENCRYPTION_KEY.');
  }
}

async function createClient(): Promise<MongoClient> {
  // Defer import to allow jest virtual mocks without the real driver installed.
  const { MongoClient: DriverMongoClient } = await import('mongodb');
  const options: MongoClientOptions = {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
  };

  const instance = new DriverMongoClient(config.mongodb.uri, options);
  await instance.connect();
  logger.info('MongoDB connection established', { dbName: config.mongodb.dbName });
  return instance;
}

export async function getMongoClient(): Promise<MongoClient> {
  ensureMongoConfig();

  if (client) {
    return client;
  }

  client = await createClient();
  return client;
}

export async function getMongoDb(): Promise<Db> {
  ensureMongoConfig();

  if (dbInstance) {
    return dbInstance;
  }

  const mongoClient = await getMongoClient();
  dbInstance = mongoClient.db(config.mongodb.dbName);
  return dbInstance;
}

export async function closeMongoConnection(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    dbInstance = null;
    logger.info('MongoDB connection closed');
  }
}

export function getMongoConnectionState(): { client: MongoClient | null; db: Db | null } {
  return { client, db: dbInstance };
}
