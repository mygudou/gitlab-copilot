declare module 'mongodb' {
  export interface MongoClientOptions {
    maxPoolSize?: number;
    serverSelectionTimeoutMS?: number;
    [key: string]: unknown;
  }

  export class MongoClient {
    constructor(uri: string, options?: MongoClientOptions);
    connect(): Promise<MongoClient>;
    db(name: string): Db;
    close(force?: boolean): Promise<void>;
  }

  export interface Db {
    collection<TSchema = any>(name: string): Collection<TSchema>;
    client: MongoClient;
  }

  export interface Collection<TSchema = any> {
    findOne(filter: Record<string, unknown>, options?: Record<string, unknown>): Promise<TSchema | null>;
    insertOne(doc: TSchema, options?: Record<string, unknown>): Promise<{ insertedId: unknown }>;
    updateOne(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options?: Record<string, unknown>
    ): Promise<{ matchedCount: number; modifiedCount: number; upsertedId?: unknown }>;
    updateMany(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options?: Record<string, unknown>
    ): Promise<{ matchedCount: number; modifiedCount: number }>;
    findOneAndUpdate(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options?: Record<string, unknown>
    ): Promise<TSchema | null>;
    find(filter: Record<string, unknown>, options?: Record<string, unknown>): Cursor<TSchema>;
    countDocuments(filter: Record<string, unknown>, options?: Record<string, unknown>): Promise<number>;
    indexes(): Promise<Array<{ name: string; key: Record<string, unknown> }>>;
    createIndex(
      keys: Record<string, unknown>,
      options?: Record<string, unknown>
    ): Promise<string>;
    dropIndex(indexName: string): Promise<void>;
    deleteOne(
      filter: Record<string, unknown>,
      options?: Record<string, unknown>
    ): Promise<{ deletedCount: number }>;
  }

  export interface Cursor<TSchema = any> {
    sort(sort: Record<string, unknown>): Cursor<TSchema>;
    toArray(): Promise<TSchema[]>;
  }

  export interface ObjectId {
    toString(): string;
  }

  export interface ServerApiVersion {
    version: string;
  }
}
