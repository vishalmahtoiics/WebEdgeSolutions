import crypto from 'node:crypto';
import { config } from '../config.js';

// Provider API tokens are stored encrypted so a database dump alone does not
// leak working credentials. AES-256-GCM gives us authenticated encryption, so a
// tampered ciphertext fails to decrypt rather than silently returning garbage.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey() {
  const key = Buffer.from(config.encryptionKey, 'hex');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
  }
  return key;
}

export function encrypt(plainText) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

export function decrypt(payload) {
  const [ivB64, tagB64, dataB64] = String(payload).split(':');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Stored credential is malformed.');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/// Last four characters of a token, so the UI can show which key is configured
/// without ever handing the real value to the browser.
export function tokenHint(token) {
  const tail = String(token).slice(-4);
  return `••••${tail}`;
}

/// Decrypts a value that may predate encryption.
///
/// The FTP password was stored in the clear before this, so a value that is not
/// in our `iv:tag:data` form is taken as legacy plaintext and returned as-is.
/// It is re-encrypted the next time the record is saved.
export function decryptMaybe(payload) {
  if (!payload) return null;
  const parts = String(payload).split(':');
  if (parts.length !== 3) return String(payload);
  try {
    return decrypt(payload);
  } catch {
    return String(payload);
  }
}

/// True when a value is already in our encrypted form.
export const isEncrypted = (value) =>
  typeof value === 'string' && value.split(':').length === 3;
