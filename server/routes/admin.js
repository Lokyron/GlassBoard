// Accounts, invitations and the mail server they are sent through.
//
// Everything here is behind requireAdmin. The role is read from the session's
// own account and never from the request, so the only way to reach these is to
// be an administrator — and the only way to become one is for another
// administrator to say so, or to have been the first account on the instance.
import express from 'express';
import {
  requireAuth, requireAdmin, createUser, listAccounts, setRole, setEmail, deleteUser,
  destroyAllSessions, createInvitation, listInvitations, revokeInvitation, markInvitationSent,
  assertPasswordStrength, normaliseEmail, findUserById, INVITE_TTL_HOURS,
} from '../auth.js';
import { getSmtpSettings, saveSmtpSettings, setSmtpPassword, smtpConfigured, sendMail, testSmtp } from '../smtp.js';
import { invitationMail } from '../mail-templates.js';

export const adminRouter = express.Router();
adminRouter.use(requireAuth, requireAdmin);

const fail = (res, error) => res.status(400).json({ error: error.message });

/* -------------------------------- accounts -------------------------------- */

adminRouter.get('/accounts', (req, res) => {
  res.json({
    ok: true,
    accounts: listAccounts(),
    invitations: listInvitations(),
    me: req.user.id,
    smtp: { configured: smtpConfigured() },
    inviteTtlHours: INVITE_TTL_HOURS,
  });
});

/** Create an account outright, with a password the administrator hands over
 *  by whatever means they like. The person enrols their own second factor the
 *  first time they sign in — nobody else can, and nobody else should. */
adminRouter.post('/accounts', async (req, res) => {
  try {
    assertPasswordStrength(req.body?.password);
    const user = await createUser(req.body?.username, req.body.password, {
      role: req.body?.role === 'admin' ? 'admin' : 'user',
      email: req.body?.email ?? '',
    });
    res.json({ ok: true, account: listAccounts().find((a) => a.id === user.id) });
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.patch('/accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  try {
    if (typeof req.body?.role === 'string') {
      // Taking the role away from yourself is allowed, as long as someone else
      // still has it: that is how an administrator steps down.
      setRole(id, req.body.role);
    }
    if (typeof req.body?.email === 'string') setEmail(id, req.body.email);
    res.json({ ok: true, account: listAccounts().find((a) => a.id === id) ?? null });
  } catch (error) {
    fail(res, error);
  }
});

/** End every session an account holds, without deleting it: what to press when
 *  someone's laptop goes missing. */
adminRouter.post('/accounts/:id/sign-out', (req, res) => {
  const id = Number(req.params.id);
  if (!findUserById(id)) return res.status(404).json({ error: 'Unknown account.' });
  destroyAllSessions(id);
  res.json({ ok: true });
});

adminRouter.delete('/accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete the account you are signed in with.' });
  }
  try {
    deleteUser(id);
    res.json({ ok: true });
  } catch (error) {
    fail(res, error);
  }
});

/* ------------------------------- invitations ------------------------------ */

const inviteLink = (req, token) => `${req.protocol}://${req.get('host')}/invite#${token}`;

/**
 * Invite someone. The link is returned to the administrator either way, so an
 * instance with no mail server still works: copy it and send it yourself. When
 * an address is given and SMTP is set up, it is also sent.
 *
 * The token appears in this one answer and in the message, and nowhere else:
 * only its hash is stored, so it cannot be read back out of the database or
 * out of this endpoint a second time.
 */
adminRouter.post('/invitations', async (req, res) => {
  try {
    const email = normaliseEmail(req.body?.email ?? '');
    const invitation = createInvitation({
      username: req.body?.username ?? '',
      email,
      role: req.body?.role === 'admin' ? 'admin' : 'user',
      invitedBy: req.user.id,
    });
    const link = inviteLink(req, invitation.token);
    const payload = { ok: true, link, expiresAt: invitation.expiresAt, sent: false, mailError: null };

    if (email && smtpConfigured()) {
      try {
        const message = invitationMail({
          link,
          invitedBy: req.user.username,
          expiresAt: invitation.expiresAt,
          host: req.get('host'),
        });
        await sendMail({ to: email, ...message });
        markInvitationSent(invitation.id, email);
        payload.sent = true;
      } catch (error) {
        // The invitation stands whatever the mail server did: the link in the
        // answer is the one that matters, and it still works.
        payload.mailError = error.message;
      }
    }
    res.json({ ...payload, invitations: listInvitations() });
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.delete('/invitations/:id', (req, res) => {
  const removed = revokeInvitation(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Unknown invitation.' });
  res.json({ ok: true, invitations: listInvitations() });
});

/* ---------------------------------- SMTP ---------------------------------- */

adminRouter.get('/smtp', (_req, res) => {
  res.json({ ok: true, smtp: getSmtpSettings() });
});

adminRouter.put('/smtp', (req, res) => {
  const settings = saveSmtpSettings(req.body ?? {});
  // Absent means "leave it alone", empty string means "forget it". Without the
  // difference, saving the form would wipe the password every time.
  if (typeof req.body?.password === 'string') setSmtpPassword(req.body.password);
  res.json({ ok: true, smtp: getSmtpSettings(), saved: settings });
});

adminRouter.post('/smtp/test', async (req, res) => {
  try {
    // Test what is on screen, not only what is stored: the point is to find
    // out before saving whether these settings work.
    const overrides = req.body && Object.keys(req.body).length > 0 ? req.body : null;
    await testSmtp(overrides);
    if (req.body?.to) {
      const message = invitationMail({
        link: `${req.protocol}://${req.get('host')}/invite#example`,
        invitedBy: req.user.username,
        expiresAt: new Date(Date.now() + INVITE_TTL_HOURS * 3_600_000).toISOString(),
        host: req.get('host'),
        preview: true,
      });
      await sendMail({ to: normaliseEmail(req.body.to), ...message });
      return res.json({ ok: true, sent: true });
    }
    res.json({ ok: true, sent: false });
  } catch (error) {
    res.status(400).json({ error: error.message, code: error.code ?? null });
  }
});
