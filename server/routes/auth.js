// Authentication endpoints: first-run setup, TOTP enrolment, login, logout.
import express from 'express';
import QRCode from 'qrcode';
import {
  SESSION_COOKIE,
  PENDING_COOKIE,
  createChallenge,
  resolveChallenge,
  destroyChallenge,
  needsSetup,
  createUser,
  findUserByName,
  findUserById,
  checkPassword,
  setPassword,
  startTotpEnrolment,
  confirmTotpEnrolment,
  checkUserTotp,
  useRecoveryCode,
  generateRecoveryCodes,
  countUnusedRecoveryCodes,
  recordAttempt,
  checkThrottle,
  clearAttempts,
  createSession,
  destroySession,
  destroyAllSessions,
  sessionCookieOptions,
  signSessionId,
  requireAuth,
} from '../auth.js';
import { SESSION_TTL_HOURS } from '../env.js';

export const authRouter = express.Router();

const clientIp = (req) => req.ip || req.socket.remoteAddress || 'unknown';

function openSession(req, res, user) {
  const { id } = createSession(user.id, req.get('user-agent'));
  res.cookie(SESSION_COOKIE, signSessionId(id), sessionCookieOptions(req, SESSION_TTL_HOURS * 3_600_000));
}

/** Public: tells the front-end which screen to show. */
authRouter.get('/state', (req, res) => {
  res.json({
    setupRequired: needsSetup(),
    authenticated: Boolean(req.user),
    totpEnrolmentRequired: Boolean(req.user && !req.user.totp_enabled),
    username: req.user?.username ?? null,
  });
});

/** Public, but only while no account exists. */
authRouter.post('/setup', async (req, res) => {
  if (!needsSetup()) return res.status(409).json({ error: 'An account already exists.' });
  try {
    const user = await createUser(req.body?.username, req.body?.password);
    openSession(req, res, user);
    res.json({ ok: true, username: user.username, totpEnrolmentRequired: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/** Start (or restart) TOTP enrolment for the signed-in account. */
authRouter.post('/totp/start', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  if (req.user.totp_enabled) return res.status(409).json({ error: 'Two-factor authentication is already enabled.' });
  const { secret, uri } = await startTotpEnrolment(req.user);
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
  res.json({ secret, uri, qr });
});

/** Confirm enrolment with a code from the authenticator app. */
authRouter.post('/totp/confirm', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  try {
    const recoveryCodes = await confirmTotpEnrolment(req.user, req.body?.token);
    res.json({ ok: true, recoveryCodes });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/* Sign-in happens in two steps. The password step never opens a session: it
   hands out a single-use challenge cookie that only allows presenting a second
   factor for that account. */

function throttled(res, bucket) {
  const throttle = checkThrottle(bucket);
  if (!throttle.locked) return false;
  res.status(429).json({
    error: `Too many failed attempts. Try again in ${Math.ceil(throttle.retryInSeconds / 60)} minute(s).`,
    code: 'locked',
    retryInSeconds: throttle.retryInSeconds,
  });
  return true;
}

/** Step 1 — username and password. */
authRouter.post('/login', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const bucket = `${clientIp(req)}|${username}`;

  if (throttled(res, bucket)) return;

  const user = findUserByName(username);
  const passwordOk = await checkPassword(user, password);
  if (!user || !passwordOk) {
    recordAttempt(bucket, false);
    // Deliberately vague: do not reveal whether the account exists.
    return res.status(401).json({ error: 'Invalid credentials.', code: 'invalid_credentials' });
  }

  // No second factor enrolled yet: the only thing this account can do is
  // finish its enrolment, so a session is opened straight away.
  if (!user.totp_enabled) {
    recordAttempt(bucket, true);
    clearAttempts(bucket);
    openSession(req, res, user);
    return res.json({ ok: true, step: 'done', username: user.username, totpEnrolmentRequired: true });
  }

  const challenge = createChallenge(user.id);
  res.cookie(PENDING_COOKIE, signSessionId(challenge.id), sessionCookieOptions(req, challenge.ttlSeconds * 1000));
  res.json({ ok: true, step: 'otp', username: user.username, expiresInSeconds: challenge.ttlSeconds });
});

/** Step 2 — authenticator code, or one of the recovery codes. */
authRouter.post('/login/verify', async (req, res) => {
  const pending = resolveChallenge(req.cookies?.[PENDING_COOKIE]);
  if (!pending) {
    res.clearCookie(PENDING_COOKIE, { path: '/' });
    return res.status(401).json({ error: 'This sign-in attempt expired. Start again.', code: 'challenge_expired' });
  }

  const { user, challenge } = pending;
  const bucket = `${clientIp(req)}|${user.username}`;
  if (throttled(res, bucket)) return;

  const token = String(req.body?.token || '').trim();
  const accepted = (await checkUserTotp(user, token)) || useRecoveryCode(user.id, token);
  if (!accepted) {
    recordAttempt(bucket, false);
    return res.status(401).json({ error: 'That code is not valid.', code: 'invalid_code' });
  }

  // One challenge, one use.
  destroyChallenge(challenge.id);
  res.clearCookie(PENDING_COOKIE, { path: '/' });
  recordAttempt(bucket, true);
  clearAttempts(bucket);
  openSession(req, res, user);
  res.json({
    ok: true,
    step: 'done',
    username: user.username,
    totpEnrolmentRequired: false,
    recoveryCodesLeft: countUnusedRecoveryCodes(user.id),
  });
});

/** Abandon a pending sign-in, for the "use another account" link. */
authRouter.post('/login/cancel', (req, res) => {
  const pending = resolveChallenge(req.cookies?.[PENDING_COOKIE]);
  if (pending) destroyChallenge(pending.challenge.id);
  res.clearCookie(PENDING_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.post('/logout', (req, res) => {
  destroySession(req.session?.id);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(PENDING_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({
    username: req.user.username,
    createdAt: req.user.created_at,
    recoveryCodesLeft: countUnusedRecoveryCodes(req.user.id),
  });
});

authRouter.post('/password', requireAuth, async (req, res) => {
  const current = String(req.body?.currentPassword || '');
  const next = String(req.body?.newPassword || '');
  if (!(await checkPassword(findUserById(req.user.id), current))) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  try {
    await setPassword(req.user.id, next);
    destroyAllSessions(req.user.id);
    openSession(req, res, findUserById(req.user.id));
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

authRouter.post('/recovery-codes', requireAuth, async (req, res) => {
  if (!(await checkPassword(findUserById(req.user.id), String(req.body?.password || '')))) {
    return res.status(401).json({ error: 'Password is incorrect.' });
  }
  res.json({ ok: true, recoveryCodes: generateRecoveryCodes(req.user.id) });
});
