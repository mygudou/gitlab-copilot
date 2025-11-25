const defaultKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const mockConfig = {
  anthropic: { baseUrl: '', authToken: undefined },
  ai: { executor: 'claude' as const, displayName: 'Claude' },
  gitlab: { baseUrl: '', token: '' },
  webhook: { secret: '', port: 3000 },
  mongodb: { uri: '', dbName: '' },
  encryption: { key: defaultKey },
  platform: { hasLegacyCredentials: false, hasMongoCredentials: false },
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

jest.mock('../utils/config', () => ({
  config: mockConfig,
}));

import { encryptSecret, decryptSecret, clearCachedEncryptionKey } from '../utils/secretVault';

describe('secretVault', () => {
  beforeEach(() => {
    mockConfig.encryption.key = defaultKey;
    clearCachedEncryptionKey();
  });

  it('encrypts and decrypts secrets symmetrically', () => {
    const plaintext = 'my-super-secret-token';
    const encrypted = encryptSecret(plaintext);

    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain(plaintext);

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('returns empty string for falsy inputs', () => {
    expect(encryptSecret('')).toBe('');
    expect(encryptSecret(null)).toBe('');
    expect(encryptSecret(undefined)).toBe('');

    expect(decryptSecret('')).toBe('');
    expect(decryptSecret(null)).toBe('');
    expect(decryptSecret(undefined)).toBe('');
  });

  it('falls back to plain text when payload is not encrypted', () => {
    const legacy = 'plain-text-secret';
    expect(decryptSecret(legacy)).toBe(legacy);
  });

  it('throws on invalid encrypted payload formats', () => {
    expect(() => decryptSecret('v1:invalid')).toThrow('Invalid encrypted payload format');
  });

  it('derives a stable key for short inputs via hashing', () => {
    mockConfig.encryption.key = 'short-key';
    clearCachedEncryptionKey();

    const encrypted = encryptSecret('value-to-protect');
    const decrypted = decryptSecret(encrypted);

    expect(decrypted).toBe('value-to-protect');
  });
});
