import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const SALT = 'xc-audit-webapp';

let derivedKey = null;

export function initCrypto(masterPassword) {
  if (!masterPassword) {
    throw new Error('MASTER_PASSWORD is required. Set it in webapp/.env');
  }
  derivedKey = scryptSync(masterPassword, SALT, 32);
}

export function encrypt(plaintext) {
  if (!derivedKey) throw new Error('Crypto not initialized');
  if (!plaintext) return plaintext;
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGO, derivedKey, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `enc:${iv.toString('hex')}:${tag}:${encrypted}`;
}

export function decrypt(value) {
  if (!derivedKey) throw new Error('Crypto not initialized');
  if (!value || !value.startsWith('enc:')) return value;
  const [, ivHex, tagHex, encrypted] = value.split(':');
  const decipher = createDecipheriv(ALGO, derivedKey, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('enc:');
}
