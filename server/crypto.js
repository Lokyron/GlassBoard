// Symmetric encryption for stored secrets, plus cookie signing helpers.
import crypto from 'node:crypto';
import { APP_SECRET } from './env.js';

const KEY = crypto.scryptSync(APP_SECRET, 'glassboard.secretbox.v1', 32);
const SIGNING_KEY = crypto.scryptSync(APP_SECRET, 'glassboard.cookie.v1', 32);
const PREFIX = 'v1';

/** Encrypt a UTF-8 string with AES-256-GCM. Returns "v1:iv:tag:ciphertext" in base64url. */
export function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(':');
}

/** Decrypt a value produced by encrypt(). Returns null when the payload is unusable. */
export function decrypt(payload) {
  if (!payload) return null;
  const parts = String(payload).split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong APP_SECRET or tampered payload.
    return null;
  }
}

export function sign(value) {
  const mac = crypto.createHmac('sha256', SIGNING_KEY).update(value).digest('base64url');
  return `${value}.${mac}`;
}

export function unsign(signed) {
  if (!signed) return null;
  const dot = signed.lastIndexOf('.');
  if (dot === -1) return null;
  const value = signed.slice(0, dot);
  const expected = crypto.createHmac('sha256', SIGNING_KEY).update(value).digest('base64url');
  const given = signed.slice(dot + 1);
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

export const randomId = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
