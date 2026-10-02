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
export const PENDING_COOKIE = 'glassboard_pending';
/* The waiting browser holds its request id here rather than in the URL it polls.
   A path is written to every access log in front of this server; a cookie is
   not, and it also ties the claim to the browser that opened the request. */
export const QR_COOKIE = 'glassboard_qr';
const CHALLENGE_TTL_MINUTES = 5;
/* Long enough to lift a phone, open the camera and tap once; short enough that
   a QR code left on a screen is worthless by the time anyone walks past it. */
const LOGIN_REQUEST_TTL_SECONDS = 120;
/* Per address, so one machine cannot fill the table. Behind a reverse proxy
   this only separates devices when TRUST_PROXY is on; without it they all share
   the proxy's address, which is why the cap is generous rather than tight. */
const MAX_PENDING_REQUESTS_PER_IP = 10;
/* No I, O, 0 or 1: this code exists to be read off one screen and compared
   with another, and those four are where that goes wrong. */
const PAIRING_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SESSION_TOUCH_MINUTES = 5;
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

export function createSession(userId, userAgent, origin = 'password') {
  const id = randomId(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3_600_000).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, last_seen_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, now(), expiresAt, String(userAgent || '').slice(0, 200), now(), origin);
  purgeExpiredSessions();
  return { id, expiresAt };
}

/** Sessions are long-lived, so "last used" is the only way to tell a forgotten
 *  one from a live one. Written at most once every few minutes: the alternative
 *  is a database write on every single request. */
export function touchSession(session) {
  if (!session) return;
  const last = session.last_seen_at ? new Date(session.last_seen_at).getTime() : 0;
  if (Date.now() - last < SESSION_TOUCH_MINUTES * 60_000) return;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now(), session.id);
}

export function listSessions(userId) {
  return db
    .prepare('SELECT id, created_at, expires_at, user_agent, last_seen_at, origin FROM sessions WHERE user_id = ? ORDER BY COALESCE(last_seen_at, created_at) DESC')
    .all(userId);
}

/** Scoped to the owner on purpose: a session id is never enough to delete one. */
export function destroyUserSession(userId, id) {
  return db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
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

/* --------------------------- login challenges ---------------------------- */
/* Between the password step and the second-factor step the browser holds a
   challenge, not a session: it grants nothing but the right to present a code
   for one specific account, once, within a few minutes. */

export function createChallenge(userId) {
  const id = randomId(32);
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MINUTES * 60_000).toISOString();
  db.prepare(
    'INSERT INTO login_challenges (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, userId, now(), expiresAt);
  purgeExpiredChallenges();
  return { id, expiresAt, ttlSeconds: CHALLENGE_TTL_MINUTES * 60 };
}

export function resolveChallenge(signedValue) {
  const id = unsign(signedValue);
  if (!id) return null;
  const row = db.prepare('SELECT * FROM login_challenges WHERE id = ?').get(id);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    destroyChallenge(id);
    return null;
  }
  const user = findUserById(row.user_id);
  if (!user) return null;
  return { challenge: row, user };
}

export function destroyChallenge(id) {
  if (id) db.prepare('DELETE FROM login_challenges WHERE id = ?').run(id);
}

export function purgeExpiredChallenges() {
  db.prepare("DELETE FROM login_challenges WHERE expires_at < datetime('now')").run();
}

/* --------------------------- QR login requests ---------------------------- */
/* Signing in from a screen that holds no credentials: that screen opens a
   request and waits, and a device that already carries a session approves it.
   The waiting browser is given the request id only. Approving needs the secret,
   which exists nowhere but inside the QR code it displays, so knowing the id
   buys an attacker nothing but the same wait. */

/** A short code both screens can derive from the request id, so the person can
 *  check that the phone is approving the sign-in in front of them. Not a
 *  secret: its whole job is to be read out loud and compared. */
export const pairingCode = (id) => {
  const digest = sha256(`glassboard.pairing:${id}`);
  let code = '';
  for (let i = 0; i < 4; i += 1) {
    code += PAIRING_ALPHABET[Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16) % PAIRING_ALPHABET.length];
  }
  return code;
};

export function createLoginRequest({ ip, userAgent }) {
  purgeExpiredLoginRequests();
  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM login_requests WHERE client_ip = ? AND expires_at > datetime('now')")
    .get(String(ip || 'unknown')).n;
  if (pending >= MAX_PENDING_REQUESTS_PER_IP) {
    const error = new Error('Too many sign-in requests at once. Wait a moment and try again.');
    error.code = 'too_many_requests';
    throw error;
  }

  const id = randomId(32);
  const secret = randomId(32);
  const expiresAt = new Date(Date.now() + LOGIN_REQUEST_TTL_SECONDS * 1000).toISOString();
  db.prepare(
    `INSERT INTO login_requests (id, secret_hash, client_ip, user_agent, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, sha256(secret), String(ip || 'unknown'), String(userAgent || '').slice(0, 200), now(), expiresAt);

  return { id, secret, expiresAt, ttlSeconds: LOGIN_REQUEST_TTL_SECONDS, pairingCode: pairingCode(id) };
}

/** What the waiting browser is allowed to know: nothing but the state. */
export function loginRequestState(id) {
  const row = db.prepare('SELECT * FROM login_requests WHERE id = ?').get(String(id || ''));
  if (!row || new Date(row.expires_at) < new Date()) return 'expired';
  if (row.consumed_at) return 'used';
  return row.approved_at ? 'approved' : 'pending';
}

/** Turn an approved request into a session, once.
 *  The UPDATE is the lock: two polls landing together, only one changes a row. */
export function claimApprovedLoginRequest(id) {
  const claimed = db
    .prepare(
      `UPDATE login_requests SET consumed_at = ?
       WHERE id = ? AND approved_at IS NOT NULL AND consumed_at IS NULL AND expires_at > datetime('now')`
    )
    .run(now(), String(id || '')).changes;
  if (!claimed) return null;
  const row = db.prepare('SELECT user_id FROM login_requests WHERE id = ?').get(String(id || ''));
  return findUserById(row.user_id) ?? null;
}

/** Look a request up by the secret carried in the QR code. */
export function findLoginRequestBySecret(secret) {
  const value = String(secret || '');
  if (!value) return null;
  const row = db.prepare('SELECT * FROM login_requests WHERE secret_hash = ?').get(sha256(value));
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return { ...row, state: 'expired' };
  return { ...row, state: row.consumed_at ? 'used' : row.approved_at ? 'approved' : 'pending' };
}

export function approveLoginRequest(secret, userId) {
  const changed = db
    .prepare(
      `UPDATE login_requests SET approved_at = ?, user_id = ?
       WHERE secret_hash = ? AND approved_at IS NULL AND expires_at > datetime('now')`
    )
    .run(now(), userId, sha256(String(secret || ''))).changes;
  return changed > 0;
}

/** Refusing destroys the request outright: there is nothing left to approve. */
export function rejectLoginRequest(secret) {
  return db.prepare('DELETE FROM login_requests WHERE secret_hash = ?').run(sha256(String(secret || ''))).changes > 0;
}

/** The id the waiting browser carries, or null if the cookie is absent or forged. */
export const loginRequestIdFromCookie = (value) => unsign(String(value || ''));

export function purgeExpiredLoginRequests() {
  db.prepare("DELETE FROM login_requests WHERE expires_at < datetime('now')").run();
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
  if (req.session) touchSession(req.session);
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
