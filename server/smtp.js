// A small SMTP client, written against RFC 5321, and the one message Glassboard
// ever sends: an invitation.
//
// Hand-written for the same reason the IMAP reader next door is: this project
// keeps four runtime dependencies, and sending one message over a protocol this
// small does not justify a fifth. Only what an invitation needs — connect,
// greet, upgrade to TLS if the port asks for it, authenticate, hand over one
// message, hang up. There is no queue, no retry and no bounce handling: a
// failure is reported to the administrator who pressed the button, who is the
// only person who can do anything about it.
//
// The subtleties worth knowing are all in sendMessage below: a line of exactly
// "." ends the DATA phase, so a body line starting with one has to be doubled,
// and a header carrying anything but ASCII has to be encoded word by word.
import net from 'node:net';
import tls from 'node:tls';
import { getMeta, setMeta } from './db.js';
import { encrypt, decrypt } from './crypto.js';

const CRLF = '\r\n';
const CONNECT_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;

/* SMTP settings belong to the instance and not to an account: they are the
   address invitations come from, and only an administrator ever sets them.
   That is why they live in `meta` rather than in `secrets`, which became
   per-account when accounts did. The password is encrypted with APP_SECRET
   exactly as a secret would be. */
const KEYS = {
  host: 'smtp.host',
  port: 'smtp.port',
  security: 'smtp.security',   // 'tls' | 'starttls' | 'none'
  user: 'smtp.user',
  from: 'smtp.from',
  fromName: 'smtp.from_name',
  password: 'smtp.password',   // encrypted
};

class SmtpError extends Error {
  constructor(message, code = 'smtp_error') {
    super(message);
    this.code = code;
  }
}

/**
 * A readable reason from a socket failure. Node reports a dual-stack connection
 * refusal as an AggregateError whose own message is empty, which would leave
 * the settings panel saying nothing at all.
 */
function socketReason(error) {
  if (Array.isArray(error?.errors) && error.errors.length > 0) {
    const reasons = [...new Set(error.errors.map((one) => one?.message || one?.code).filter(Boolean))];
    if (reasons.length > 0) return reasons.join('; ');
  }
  return error?.message || error?.code || 'the connection failed';
}

/* -------------------------------- settings -------------------------------- */

export function getSmtpSettings() {
  return {
    host: getMeta(KEYS.host, ''),
    port: Number(getMeta(KEYS.port, '587')) || 587,
    security: getMeta(KEYS.security, 'starttls'),
    user: getMeta(KEYS.user, ''),
    from: getMeta(KEYS.from, ''),
    fromName: getMeta(KEYS.fromName, 'Glassboard'),
    hasPassword: Boolean(getMeta(KEYS.password, '')),
  };
}

export function saveSmtpSettings(settings = {}) {
  const port = Number(settings.port);
  const security = ['tls', 'starttls', 'none'].includes(settings.security) ? settings.security : 'starttls';
  setMeta(KEYS.host, String(settings.host || '').trim().slice(0, 200));
  setMeta(KEYS.port, String(Number.isFinite(port) && port > 0 && port < 65536 ? port : 587));
  setMeta(KEYS.security, security);
  setMeta(KEYS.user, String(settings.user || '').trim().slice(0, 200));
  setMeta(KEYS.from, String(settings.from || '').trim().slice(0, 200));
  setMeta(KEYS.fromName, String(settings.fromName || '').trim().slice(0, 80));
  return getSmtpSettings();
}

/** Write-only, like every other credential here: it goes in, it never comes out. */
export function setSmtpPassword(password) {
  setMeta(KEYS.password, password ? encrypt(String(password)) : '');
}

export const smtpConfigured = () => Boolean(getMeta(KEYS.host, '') && getMeta(KEYS.from, ''));

const smtpPassword = () => {
  const stored = getMeta(KEYS.password, '');
  return stored ? decrypt(stored) : null;
};

/* ------------------------------- the protocol ------------------------------ */

/** One connection, driven command by command. */
class Session {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.pending = null;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.fail(new SmtpError(socketReason(error), 'network')));
    socket.on('close', () => this.fail(new SmtpError('The server closed the connection.', 'network')));
  }

  onData(chunk) {
    this.buffer += chunk;
    // A reply is one or more lines; every line but the last has a hyphen after
    // the code ("250-SIZE" then "250 HELP"), which is how a multi-line reply
    // says it has more to come.
    const lines = this.buffer.split(CRLF);
    for (let i = 0; i < lines.length - 1; i += 1) {
      if (/^\d{3} /.test(lines[i])) {
        const reply = lines.slice(0, i + 1);
        this.buffer = lines.slice(i + 1).join(CRLF);
        this.settle(Number(lines[i].slice(0, 3)), reply.join('\n'));
        return;
      }
    }
  }

  settle(code, text) {
    const pending = this.pending;
    this.pending = null;
    if (pending) pending.resolve({ code, text });
  }

  fail(error) {
    const pending = this.pending;
    this.pending = null;
    this.closed = true;
    if (pending) pending.reject(error);
  }

  /** Wait for one reply. */
  read() {
    if (this.closed) return Promise.reject(new SmtpError('The connection is closed.', 'network'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new SmtpError('The server stopped answering.', 'timeout')),
        COMMAND_TIMEOUT_MS
      );
      this.pending = {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
    });
  }

  /** Send a command and read its reply, failing on anything but `expected`. */
  async command(line, expected) {
    const reply = this.read();
    this.socket.write(line + CRLF);
    const answer = await reply;
    if (expected && !expected.includes(answer.code)) {
      // The server's own words, which say far more than anything written here:
      // "Username and Password not accepted", "relay not permitted", and so on.
      throw new SmtpError(answer.text.trim(), answer.code === 535 || answer.code === 530 ? 'auth' : 'refused');
    }
    return answer;
  }
}

function connect(settings) {
  return new Promise((resolve, reject) => {
    const options = { host: settings.host, port: settings.port };
    const socket = settings.security === 'tls'
      ? tls.connect({ ...options, servername: settings.host })
      : net.connect(options);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SmtpError(`No answer from ${settings.host}:${settings.port}.`, 'timeout'));
    }, CONNECT_TIMEOUT_MS);
    socket.once(settings.security === 'tls' ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(new SmtpError(socketReason(error), 'network'));
    });
  });
}

/** Upgrade a plain connection in place, as STARTTLS asks. */
function upgrade(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host });
    secure.once('secureConnect', () => resolve(secure));
    secure.once('error', (error) => reject(new SmtpError(socketReason(error), 'tls')));
  });
}

/**
 * Open a session, greet, secure it, authenticate, and hand it to `work`.
 * The socket is destroyed on the way out whatever happened, so a failure
 * halfway never leaves a connection open against someone's mail server.
 */
async function withSession(settings, password, work) {
  if (!settings.host) throw new SmtpError('No SMTP server is configured.', 'not_configured');
  let socket = await connect(settings);
  let session = new Session(socket);
  try {
    const greeting = await session.read();
    if (greeting.code !== 220) throw new SmtpError(greeting.text.trim(), 'refused');

    // EHLO names this machine. "localhost" is honest for a self-hosted box
    // behind a residential connection and is what servers expect to see from
    // a client; a made-up public name would be likelier to be refused.
    await session.command('EHLO localhost', [250]);

    if (settings.security === 'starttls') {
      await session.command('STARTTLS', [220]);
      socket = await upgrade(socket, settings.host);
      session = new Session(socket);
      // The handshake resets what the server will admit to, so EHLO again —
      // and only now does it offer AUTH, which is the point of the exercise.
      await session.command('EHLO localhost', [250]);
    }

    if (settings.user && password) {
      // AUTH LOGIN is the one every server still speaks. Both halves are
      // base64, each on its own line, each answered with a 334.
      await session.command('AUTH LOGIN', [334]);
      await session.command(Buffer.from(settings.user, 'utf8').toString('base64'), [334]);
      await session.command(Buffer.from(password, 'utf8').toString('base64'), [235]);
    }

    const result = await work(session);
    try {
      await session.command('QUIT', [221]);
    } catch {
      // A server that hangs up instead of answering QUIT has still done its job.
    }
    return result;
  } finally {
    socket.destroy();
  }
}

/* -------------------------------- messages -------------------------------- */

/** RFC 2047, for a header that is not plain ASCII — a name, or a subject. */
const encodeHeader = (value) => {
  const text = String(value ?? '');
  // eslint-disable-next-line no-control-regex -- anything outside printable ASCII has to be encoded
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
};

/** A body line of exactly "." would end the DATA phase, so every line that
 *  begins with one gets a second. RFC 5321 §4.5.2, and the oldest way to
 *  truncate an email by accident. */
const dotStuff = (body) => body.replace(/\r\n\./g, '\r\n..').replace(/^\./, '..');

/** Base64, wrapped at 76 characters as the transfer encoding requires. */
const base64Body = (text) =>
  Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, `$1${CRLF}`);

const messageId = (from) => {
  const domain = String(from).split('@')[1] || 'glassboard.local';
  return `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}@${domain}>`;
};

/** Both parts of one message: what a plain-text reader sees, and the page. */
function buildMessage({ from, fromName, to, subject, text, html }) {
  const boundary = `gb-${Math.random().toString(36).slice(2, 18)}`;
  const headers = [
    `From: ${fromName ? `${encodeHeader(fromName)} <${from}>` : from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId(from)}`,
    'MIME-Version: 1.0',
    // An invitation is not a newsletter, but it is unsolicited by definition:
    // saying so plainly is what keeps it out of a spam folder.
    'Auto-Submitted: auto-generated',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const body = [
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(html),
    `--${boundary}--`,
    '',
  ];
  return headers.join(CRLF) + CRLF + body.join(CRLF);
}

/** Send one message. Throws with a readable reason; never retries. */
export async function sendMail({ to, subject, text, html }) {
  const settings = getSmtpSettings();
  if (!smtpConfigured()) throw new SmtpError('No SMTP server is configured.', 'not_configured');
  const password = smtpPassword();
  const from = settings.from;

  return withSession(settings, password, async (session) => {
    await session.command(`MAIL FROM:<${from}>`, [250]);
    await session.command(`RCPT TO:<${to}>`, [250, 251]);
    await session.command('DATA', [354]);
    const message = buildMessage({ from, fromName: settings.fromName, to, subject, text, html });
    session.socket.write(dotStuff(message) + CRLF + '.' + CRLF);
    const reply = await session.read();
    if (reply.code !== 250) throw new SmtpError(reply.text.trim(), 'refused');
    return { ok: true };
  });
}

/** Sign in and hang up, to tell the administrator whether this works at all. */
export async function testSmtp(overrides = null) {
  const settings = overrides ? { ...getSmtpSettings(), ...overrides } : getSmtpSettings();
  if (!settings.host) throw new SmtpError('No SMTP server is configured.', 'not_configured');
  const password = overrides?.password ?? smtpPassword();
  await withSession(settings, password, async () => true);
  return { ok: true };
}
