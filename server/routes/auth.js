// Authentication endpoints: first-run setup, TOTP enrolment, login, logout.
import express from 'express';
import QRCode from 'qrcode';
import {
  SESSION_COOKIE,
  PENDING_COOKIE,
  QR_COOKIE,
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
  listSessions,
  destroyUserSession,
  resolveInvitation,
  acceptInvitation,
  isAdmin,
  createLoginRequest,
  loginRequestState,
  claimApprovedLoginRequest,
  loginRequestIdFromCookie,
  findLoginRequestBySecret,
  approveLoginRequest,
  rejectLoginRequest,
  pairingCode,
  sessionCookieOptions,
  signSessionId,
  requireAuth,
} from '../auth.js';
import { SESSION_TTL_HOURS } from '../env.js';

export const authRouter = express.Router();

const clientIp = (req) => req.ip || req.socket.remoteAddress || 'unknown';

function openSession(req, res, user, origin = 'password') {
  const { id } = createSession(user.id, req.get('user-agent'), origin);
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

/* ------------------------------ invitations ------------------------------ */
/* Public, because the person holding the link has no account yet. Neither
   endpoint says anything about the instance: an invalid or spent token gets
   the same answer as one that never existed. */

/** What a token opens, so the page can show who invited whom. */
authRouter.get('/invite', (req, res) => {
  const invitation = resolveInvitation(req.query.token);
  if (!invitation) return res.status(404).json({ error: 'This invitation has expired or has already been used.' });
  res.json({
    ok: true,
    username: invitation.username,
    // The address is shown back so the person can see the invitation is for
    // them; it is not editable, and it is not what signs them in.
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expires_at,
  });
});

/** Turn a token into an account, and open a session on it: the next screen is
 *  TOTP enrolment, exactly as for the first account on the instance. */
authRouter.post('/invite', async (req, res) => {
  try {
    const user = await acceptInvitation(req.body?.token, req.body?.username, req.body?.password);
    openSession(req, res, user);
    res.json({ ok: true, username: user.username, totpEnrolmentRequired: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/* ------------------------- sign in by QR code ---------------------------- */
/* The screen with no credentials shows a code; a device that already holds a
   session scans it and approves. See the login_requests table for why the
   waiting screen is never told the secret. */

/** Public: open a request and hand back the QR code to display. */
authRouter.post('/qr/start', async (req, res) => {
  if (needsSetup()) return res.status(409).json({ error: 'setup_required' });
  let request;
  try {
    request = createLoginRequest({ ip: clientIp(req), userAgent: req.get('user-agent') });
  } catch (error) {
    return res.status(429).json({ error: error.message, code: error.code });
  }

  // The secret rides in the fragment, which browsers never put on the wire:
  // it stays out of the access log, out of Referer and out of any proxy.
  const origin = `${req.protocol}://${req.get('host')}`;
  const qr = await QRCode.toDataURL(`${origin}/approve#${request.secret}`, { margin: 1, width: 320 });
  // The id goes in a cookie, never in the answer and never in a URL: the
  // browser that opened the request is then the only one able to claim it.
  res.cookie(QR_COOKIE, signSessionId(request.id), sessionCookieOptions(req, request.ttlSeconds * 1000));
  res.json({ ok: true, qr, pairingCode: request.pairingCode, expiresInSeconds: request.ttlSeconds });
});

/** Public: the waiting screen asks whether it may come in yet.
 *  An approved request is spent here, and only here. */
authRouter.get('/qr/state', (req, res) => {
  const id = loginRequestIdFromCookie(req.cookies?.[QR_COOKIE]);
  if (!id) return res.json({ ok: true, state: 'expired' });

  const state = loginRequestState(id);
  if (state === 'pending') return res.json({ ok: true, state });
  res.clearCookie(QR_COOKIE, { path: '/' });
  if (state !== 'approved') return res.json({ ok: true, state });

  const user = claimApprovedLoginRequest(id);
  if (!user) return res.json({ ok: true, state: 'expired' });
  openSession(req, res, user, 'qr');
  res.json({ ok: true, state: 'approved', username: user.username });
});

/** What the approving device shows before anyone taps anything. */
authRouter.get('/qr/pending', requireAuth, (req, res) => {
  const request = findLoginRequestBySecret(req.query.secret);
  if (!request) return res.status(404).json({ error: 'This sign-in request no longer exists.', code: 'qr_unknown' });
  if (request.state !== 'pending') {
    return res.status(409).json({ error: 'This sign-in request is no longer waiting.', code: `qr_${request.state}` });
  }
  res.json({
    ok: true,
    pairingCode: pairingCode(request.id),
    clientIp: request.client_ip,
    userAgent: request.user_agent,
    createdAt: request.created_at,
    expiresAt: request.expires_at,
    username: req.user.username,
  });
});

/** The one deliberate act. The session itself is the second factor: only a
 *  device that already signed in with a password and a code gets here. */
authRouter.post('/qr/approve', (req, res) => {
  if (!req.user || !req.user.totp_enabled) return res.status(401).json({ error: 'unauthenticated' });
  if (!approveLoginRequest(req.body?.secret, req.user.id)) {
    return res.status(409).json({ error: 'This sign-in request expired. Scan a fresh code.', code: 'qr_expired' });
  }
  res.json({ ok: true });
});

authRouter.post('/qr/reject', requireAuth, (req, res) => {
  rejectLoginRequest(req.body?.secret);
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
    email: req.user.email ?? '',
    role: req.user.role,
    admin: isAdmin(req.user),
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

/* ------------------------------- sessions -------------------------------- */
/* A sign-in that can be granted with a camera is a sign-in worth being able to
   look at afterwards. */

authRouter.get('/sessions', requireAuth, (req, res) => {
  res.json({
    ok: true,
    sessions: listSessions(req.user.id).map((row) => ({
      id: row.id,
      current: row.id === req.session?.id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      expiresAt: row.expires_at,
      userAgent: row.user_agent,
      origin: row.origin,
    })),
  });
});

authRouter.delete('/sessions/:id', requireAuth, (req, res) => {
  if (req.params.id === req.session?.id) {
    return res.status(400).json({ error: 'Use Sign out to end the current session.', code: 'current_session' });
  }
  if (!destroyUserSession(req.user.id, req.params.id)) {
    return res.status(404).json({ error: 'That session no longer exists.' });
  }
  res.json({ ok: true });
});
