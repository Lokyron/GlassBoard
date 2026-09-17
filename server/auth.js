// Accounts, sessions, TOTP enrolment and login throttling.
import crypto from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { generateSecret, generate as totpGenerate, generateURI, verify as totpVerify } from 'otplib';
import { db, now, getMeta, setMeta } from './db.js';
import { encrypt, decrypt, sign, unsign, randomId, sha256 } from './crypto.js';
import {
  SESSION_TTL_HOURS,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_LOCKOUT_MINUTES,
  COOKIE_SECURE,
} from './env.js';

export const SESSION_COOKIE = 'glassboard_session';
const TOTP_ISSUER = 'Glassboard';
const TOTP_TOLERANCE_SECONDS = 30; // one time step of drift either way, per RFC 6238 §5.2

/* ------------------------------- accounts -------------------------------- */

export const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
export const needsSetup = () => userCount() === 0;

export const findUserByName = (username) =>
  db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim().toLowerCase());

export const findUserById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

const hashPassword = (password) =>
  argonHash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });

export async function createUser(username, password) {
  const name = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(name)) {
    throw new Error('Username must be 3-40 characters (letters, digits, dot, dash, underscore).');
  }
  assertPasswordStrength(password);
  const passwordHash = await hashPassword(password);
  const info = db
    .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run(name, passwordHash, now());
  return findUserById(Number(info.lastInsertRowid));
}

export function assertPasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('Password must be at least 12 characters long.');
  }
  if (password.length > 200) {
    throw new Error('Password must be at most 200 characters long.');
  }
}

export async function setPassword(userId, password) {
  assertPasswordStrength(password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), userId);
}

export async function checkPassword(user, password) {
  if (!user || typeof password !== 'string') return false;
  try {
    return await argonVerify(user.password_hash, password);
  } catch {
    return false;
  }
}

/* --------------------------------- TOTP ---------------------------------- */

/** Create a pending TOTP secret for a user and return what the enrolment screen needs. */
export async function startTotpEnrolment(user) {
  const secret = await generateSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(encrypt(secret), user.id);
  const uri = await generateURI({ secret, label: user.username, issuer: TOTP_ISSUER });
  return { secret, uri };
}

export async function confirmTotpEnrolment(user, token) {
  const fresh = findUserById(user.id);
  const secret = decrypt(fresh.totp_secret);
  if (!secret) throw new Error('No enrolment in progress. Restart the process.');
  if (!(await checkTotp(secret, token))) throw new Error('That code is not valid. Check your authenticator app.');
  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(user.id);
  return generateRecoveryCodes(user.id);
}

export async function checkTotp(secret, token) {
  const code = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  try {
    const result = await totpVerify({ secret, token: code, epochTolerance: TOTP_TOLERANCE_SECONDS });
    return Boolean(result?.valid);
  } catch {
    return false;
  }
}

export async function checkUserTotp(user, token) {
  const secret = decrypt(user.totp_secret);
  if (!secret) return false;
  return checkTotp(secret, token);
}

/** Used by the enrolment screen to show a live code when a user wants to double-check. */
export const currentTotp = (secret) => totpGenerate({ secret });

/* ----------------------------- recovery codes ---------------------------- */

export function generateRecoveryCodes(userId, count = 10) {
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId);
  const codes = [];
  const insert = db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)');
  for (let i = 0; i < count; i += 1) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    codes.push(code);
    insert.run(userId, sha256(code));
  }
  return codes;
}

export function countUnusedRecoveryCodes(userId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL')
    .get(userId).n;
}

/** Consume a recovery code. Returns true when it was valid and unused. */
export function useRecoveryCode(userId, code) {
  const normalised = String(code || '').trim().toUpperCase();
  if (!normalised) return false;
  const row = db
    .prepare('SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
    .get(userId, sha256(normalised));
  if (!row) return false;
  db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').run(now(), row.id);
  return true;
}

/* ------------------------------- throttling ------------------------------ */

export function recordAttempt(bucket, success) {
  db.prepare('INSERT INTO login_attempts (bucket, at, success) VALUES (?, ?, ?)').run(
    bucket,
    now(),
    success ? 1 : 0
  );
  // Keep the table from growing forever.
  db.prepare("DELETE FROM login_attempts WHERE at < datetime('now', '-1 day')").run();
}

/** @returns {{locked: boolean, retryInSeconds: number, remaining: number}} */
export function checkThrottle(bucket) {
  const since = new Date(Date.now() - LOGIN_LOCKOUT_MINUTES * 60_000).toISOString();
  const rows = db
    .prepare('SELECT at, success FROM login_attempts WHERE bucket = ? AND at > ? ORDER BY at DESC')
    .all(bucket, since);
  let failures = 0;
  let lastFailureAt = null;
  for (const row of rows) {
    if (row.success) break; // a success resets the streak
    failures += 1;
    if (!lastFailureAt) lastFailureAt = row.at;
  }
  if (failures < LOGIN_MAX_ATTEMPTS) {
    return { locked: false, retryInSeconds: 0, remaining: LOGIN_MAX_ATTEMPTS - failures };
  }
  const unlockAt = new Date(new Date(lastFailureAt).getTime() + LOGIN_LOCKOUT_MINUTES * 60_000);
  const retryInSeconds = Math.max(1, Math.ceil((unlockAt - Date.now()) / 1000));
  return { locked: true, retryInSeconds, remaining: 0 };
}

export function clearAttempts(bucket) {
  db.prepare('DELETE FROM login_attempts WHERE bucket = ?').run(bucket);
}

/* -------------------------------- sessions ------------------------------- */

export function createSession(userId, userAgent) {
  const id = randomId(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3_600_000).toISOString();
  db.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)'
  ).run(id, userId, now(), expiresAt, String(userAgent || '').slice(0, 200));
  purgeExpiredSessions();
  return { id, expiresAt };
}

export function destroySession(id) {
  if (id) db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function destroyAllSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function purgeExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

export function resolveSession(signedValue) {
  const id = unsign(signedValue);
  if (!id) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    destroySession(id);
    return null;
  }
  const user = findUserById(session.user_id);
  if (!user) return null;
  return { session, user };
}

export function sessionCookieOptions(req, maxAgeMs) {
  const secure =
    COOKIE_SECURE === 'true' ? true : COOKIE_SECURE === 'false' ? false : Boolean(req.secure);
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: maxAgeMs,
  };
}

export const signSessionId = (id) => sign(id);

/* ------------------------------ middleware ------------------------------- */

/** Attaches req.user when a valid session cookie is present. */
export function attachUser(req, _res, next) {
  const raw = req.cookies?.[SESSION_COOKIE];
  const resolved = raw ? resolveSession(raw) : null;
  req.user = resolved?.user ?? null;
  req.session = resolved?.session ?? null;
  next();
}

/** Guards the API. Never redirects — the front-end decides what to do with a 401. */
export function requireAuth(req, res, next) {
  if (needsSetup()) return res.status(409).json({ error: 'setup_required' });
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  if (!req.user.totp_enabled) return res.status(403).json({ error: 'totp_enrolment_required' });
  next();
}

/* --------------------------- instance bootstrap -------------------------- */

/** A stable identifier for this instance, used in export filenames. */
export function instanceId() {
  let id = getMeta('instance_id');
  if (!id) {
    id = randomId(8);
    setMeta('instance_id', id);
  }
  return id;
}
