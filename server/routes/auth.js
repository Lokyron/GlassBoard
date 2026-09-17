// Authentication endpoints: first-run setup, TOTP enrolment, login, logout.
import express from 'express';
import QRCode from 'qrcode';
import {
  SESSION_COOKIE,
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

authRouter.post('/login', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const token = String(req.body?.token || '').trim();

  const bucket = `${clientIp(req)}|${username}`;
  const throttle = checkThrottle(bucket);
  if (throttle.locked) {
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${Math.ceil(throttle.retryInSeconds / 60)} minute(s).`,
      retryInSeconds: throttle.retryInSeconds,
    });
  }

  const user = findUserByName(username);
  const passwordOk = await checkPassword(user, password);
  if (!user || !passwordOk) {
    recordAttempt(bucket, false);
    // Deliberately vague: do not reveal whether the account exists.
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  if (user.totp_enabled) {
    const totpOk = (await checkUserTotp(user, token)) || useRecoveryCode(user.id, token);
    if (!totpOk) {
      recordAttempt(bucket, false);
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
  }

  recordAttempt(bucket, true);
  clearAttempts(bucket);
  openSession(req, res, user);
  res.json({
    ok: true,
    username: user.username,
    totpEnrolmentRequired: !user.totp_enabled,
    recoveryCodesLeft: user.totp_enabled ? countUnusedRecoveryCodes(user.id) : null,
  });
});

authRouter.post('/logout', (req, res) => {
  destroySession(req.session?.id);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
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
