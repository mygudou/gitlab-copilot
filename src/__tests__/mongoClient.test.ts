const configMock = {
  anthropic: { baseUrl: '', authToken: undefined },
  ai: { executor: 'claude' as const, displayName: 'Claude' },
  gitlab: { baseUrl: '', token: '' },
  webhook: { secret: '', port: 3000 },
  mongodb: { uri: 'mongodb://localhost:27017', dbName: 'gitlab-copilot' },
  encryption: { key: 'dummy-key' },
  platform: { hasLegacyCredentials: false, hasMongoCredentials: true },
  session: {
    enabled: false,
    maxIdleTime: 0,
    maxSessions: 0,
    cleanupInterval: 0,
    storagePath: '',
  },
  workDir: '',
  logLevel: 'info',
};

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../utils/config', () => ({
  config: configMock,
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: mockLogger,
}));

const mockConnect = jest.fn();
const mockDb = jest.fn();
const mockClose = jest.fn();

const mockMongoClientInstance = {
  connect: mockConnect,
  db: mockDb,
  close: mockClose,
};

const mongoClientConstructor = jest.fn(() => mockMongoClientInstance);

jest.mock(
  'mongodb',
  () => ({
    MongoClient: class {
      constructor(uri: string, options?: unknown) {
        return mongoClientConstructor(uri, options);
      }
    },
  }),
  { virtual: true }
);

import {
  getMongoClient,
  getMongoDb,
  closeMongoConnection,
  getMongoConnectionState,
} from '../services/storage/mongoClient';

describe('mongoClient', () => {
  beforeEach(async () => {
    configMock.platform.hasMongoCredentials = true;
    configMock.mongodb.uri = 'mongodb://localhost:27017';
    configMock.mongodb.dbName = 'gitlab-copilot';

    mockConnect.mockReset();
    mockDb.mockReset();
    mockClose.mockReset();
    mongoClientConstructor.mockClear();

    mockConnect.mockResolvedValue(mockMongoClientInstance as never);
    mockDb.mockReturnValue({ name: 'gitlab-copilot' } as never);
    mockClose.mockResolvedValue(undefined as never);

    await closeMongoConnection();

    jest.clearAllMocks();
  });

  afterAll(async () => {
    await closeMongoConnection();
  });

  it('throws when MongoDB credentials are incomplete', async () => {
    configMock.platform.hasMongoCredentials = false;

    await expect(getMongoClient()).rejects.toThrow('MongoDB configuration is not complete');
    expect(mongoClientConstructor).not.toHaveBeenCalled();
  });

  it('creates a MongoClient only once and caches the instance', async () => {
    const client = await getMongoClient();
    expect(client).toBe(mockMongoClientInstance);
    expect(mongoClientConstructor).toHaveBeenCalledTimes(1);
    expect(mongoClientConstructor).toHaveBeenCalledWith(
      'mongodb://localhost:27017',
      expect.objectContaining({ maxPoolSize: 10 })
    );
    expect(mockConnect).toHaveBeenCalledTimes(1);

    const cachedClient = await getMongoClient();
    expect(cachedClient).toBe(client);
    expect(mongoClientConstructor).toHaveBeenCalledTimes(1);
  });

  it('returns the database instance and reuses cached client', async () => {
    const db = await getMongoDb();
    expect(db).toEqual({ name: 'gitlab-copilot' });
    expect(mockDb).toHaveBeenCalledWith('gitlab-copilot');
    expect(mongoClientConstructor).toHaveBeenCalledTimes(1);

    const state = getMongoConnectionState();
    expect(state.client).toBe(mockMongoClientInstance);
    expect(state.db).toEqual({ name: 'gitlab-copilot' });
  });

  it('closes and clears cached instances', async () => {
    await getMongoClient();
    await closeMongoConnection();

    expect(mockClose).toHaveBeenCalledTimes(1);

    const state = getMongoConnectionState();
    expect(state.client).toBeNull();
    expect(state.db).toBeNull();
  });
});
