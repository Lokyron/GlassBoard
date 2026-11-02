// The one message Glassboard sends.
//
// Written in English, like the sign-in screens: an invitation goes out before
// the person has an account, so there is no language setting to follow and no
// browser to ask. Deliberately plain — mail clients disagree about almost
// everything, so this is a table, inline styles, no image, no web font, and a
// link that is also written out in full for whoever cannot click it.
import { escapeHtml } from './html.js';

const BG = '#0b1120';
const CARD = '#151a28';
const TEXT = '#f4f6fb';
const MUTED = '#a1a1a6';
const ACCENT = '#0a84ff';

/** Hours until a timestamp, rounded down, for "valid for 48 hours". */
const hoursUntil = (iso) => Math.max(1, Math.floor((new Date(iso).getTime() - Date.now()) / 3_600_000));

export function invitationMail({ link, invitedBy, expiresAt, host, preview = false }) {
  const hours = hoursUntil(expiresAt);
  const who = invitedBy ? `${invitedBy} has` : 'Someone has';
  const subject = preview
    ? 'Glassboard — test message'
    : `${invitedBy || 'Someone'} invited you to ${host || 'their Glassboard'}`;

  const intro = preview
    ? 'This is a test message from a Glassboard instance. If it reached you, the mail settings work. The link below leads nowhere.'
    : `${who} invited you to create an account on their Glassboard, the dashboard at ${host || 'their server'}.`;

  const text = [
    preview ? 'Glassboard — test message' : 'You have been invited to Glassboard',
    '',
    intro,
    '',
    'Open this link to choose a username and a password:',
    link,
    '',
    `The link works once, and stops working in ${hours} hours.`,
    '',
    'You will be asked to set up two-factor authentication straight after, with',
    'an authenticator app on your phone. Have it to hand.',
    '',
    'If you were not expecting this, you can ignore this message: nothing is',
    'created until someone opens the link.',
  ].join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${BG};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:32px 16px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${CARD};border-radius:18px;border:1px solid rgba(255,255,255,.09);">
  <tr><td style="padding:32px 28px 8px;">
    <p style="margin:0 0 6px;font:600 12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:${MUTED};">Glassboard</p>
    <h1 style="margin:0;font:700 22px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${TEXT};">
      ${escapeHtml(preview ? 'Test message' : 'You have been invited')}
    </h1>
  </td></tr>
  <tr><td style="padding:12px 28px 0;">
    <p style="margin:0 0 18px;font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${TEXT};">
      ${escapeHtml(intro)}
    </p>
  </td></tr>
  <tr><td style="padding:6px 28px 0;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:999px;background:${ACCENT};">
      <a href="${escapeHtml(link)}" style="display:inline-block;padding:13px 26px;font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#fff;text-decoration:none;border-radius:999px;">
        Create my account
      </a>
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:20px 28px 0;">
    <p style="margin:0 0 6px;font:400 13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};">
      Or copy this link into your browser:
    </p>
    <p style="margin:0;font:400 12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:${MUTED};word-break:break-all;">
      ${escapeHtml(link)}
    </p>
  </td></tr>
  <tr><td style="padding:22px 28px 28px;">
    <p style="margin:0 0 10px;padding-top:18px;border-top:1px solid rgba(255,255,255,.09);font:400 13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};">
      The link works once, and stops working in ${hours} hours. You will be asked to
      set up two-factor authentication straight after, with an authenticator app
      on your phone — have it to hand.
    </p>
    <p style="margin:0;font:400 13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};">
      If you were not expecting this, ignore this message: nothing is created
      until someone opens the link.
    </p>
  </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  return { subject, text, html };
}
