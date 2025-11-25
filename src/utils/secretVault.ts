import crypto from 'crypto';
import { config } from './config';

const ENCRYPTION_VERSION = 'v1';
const IV_LENGTH = 12; // Recommended size for AES-GCM
const AUTH_TAG_LENGTH = 16; // Bytes

let cachedKey: Buffer | null = null;

function deriveKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }

  const keySource = config.encryption.key;
  if (!keySource) {
    throw new Error('ENCRYPTION_KEY is not configured');
  }

  const normalized = keySource.trim();
  if (normalized.length === 0) {
    throw new Error('ENCRYPTION_KEY must not be empty');
  }

  // Accept common encodings: hex (64 chars for 32 bytes), base64, or raw string.
  if (/^[0-9a-fA-F]{64}$/.test(normalized)) {
    cachedKey = Buffer.from(normalized, 'hex');
    return cachedKey;
  }

  try {
    const base64Decoded = Buffer.from(normalized, 'base64');
    if (base64Decoded.length === 32) {
      cachedKey = base64Decoded;
      return cachedKey;
    }
  } catch {
    // Ignore base64 decode failures and continue with utf8 fallback.
  }

  const utf8Buffer = Buffer.from(normalized, 'utf8');
  if (utf8Buffer.length === 32) {
    cachedKey = utf8Buffer;
    return cachedKey;
  }

  if (utf8Buffer.length < 32) {
    // Expand to 32 bytes via SHA-256 when insufficient entropy.
    cachedKey = crypto.createHash('sha256').update(utf8Buffer).digest();
    return cachedKey;
  }

  // For longer strings we also hash down to 32 bytes to keep AES-256 requirements.
  cachedKey = crypto.createHash('sha256').update(utf8Buffer).digest();
  return cachedKey;
}

function serialize(iv: Buffer, cipherText: Buffer, authTag: Buffer): string {
  return [
    ENCRYPTION_VERSION,
    iv.toString('base64'),
    cipherText.toString('base64'),
    authTag.toString('base64'),
  ].join(':');
}

function deserialize(payload: string): {
  version: string;
  iv: Buffer;
  cipherText: Buffer;
  authTag: Buffer;
} {
  const parts = payload.split(':');
  if (parts.length !== 4) {
    throw new Error('Invalid encrypted payload format');
  }

  const [version, ivB64, cipherB64, tagB64] = parts;
  if (version !== ENCRYPTION_VERSION) {
    throw new Error(`Unsupported encryption version: ${version}`);
  }

  return {
    version,
    iv: Buffer.from(ivB64, 'base64'),
    cipherText: Buffer.from(cipherB64, 'base64'),
    authTag: Buffer.from(tagB64, 'base64'),
  };
}

export function encryptSecret(plaintext: string | null | undefined): string {
  if (plaintext === undefined || plaintext === null) {
    return '';
  }

  const value = String(plaintext);
  if (!value) {
    return '';
  }

  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return serialize(iv, encrypted, authTag);
}

export function decryptSecret(encrypted: string | null | undefined): string {
  if (encrypted === undefined || encrypted === null) {
    return '';
  }

  const value = String(encrypted).trim();
  if (!value) {
    return '';
  }

  if (!value.startsWith(`${ENCRYPTION_VERSION}:`)) {
    // Assume legacy plain-text storage.
    return value;
  }

  const key = deriveKey();
  const { iv, cipherText, authTag } = deserialize(value);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);

  return decrypted.toString('utf8');
}

export function clearCachedEncryptionKey(): void {
  cachedKey = null;
}
