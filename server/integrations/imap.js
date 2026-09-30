// A small read-only IMAP client, written against RFC 3501.
//
// Only what the parcel scanner needs: connect over TLS, sign in, open a mailbox
// **read-only**, search by date, and fetch the beginning of messages. There is
// no command here that can modify a mailbox, and the mailbox is opened with
// EXAMINE rather than SELECT, so the server itself refuses any write: a bug on
// this side cannot mark a message as read, move it or delete it.
//
// The one real subtlety of the protocol is the literal: a response line may end
// with `{123}` and continue with exactly 123 raw bytes, which are *not* a line
// and may contain CRLF. The reader below is built around that.
import tls from 'node:tls';
import net from 'node:net';

const CRLF = '\r\n';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** IMAP wants `1-Jan-2026`, always in English and never zero-padded. */
export function imapDate(date) {
  return `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

/** A quoted IMAP string. Backslashes and quotes are the only thing to escape. */
const quoted = (value) => `"${String(value).replace(/([\\"])/g, '\\$1')}"`;

/**
 * A readable reason from a socket failure. Node reports a dual-stack connection
 * refusal as an AggregateError whose own message is empty, which would leave the
 * settings panel saying nothing at all.
 */
function socketReason(error) {
  if (Array.isArray(error?.errors) && error.errors.length > 0) {
    const reasons = [...new Set(error.errors.map((one) => one?.message || one?.code).filter(Boolean))];
    if (reasons.length > 0) return reasons.join('; ');
  }
  return error?.message || error?.code || 'the connection failed';
}

class ImapError extends Error {
  constructor(message, code = 'imap_error') {
    super(message);
    this.code = code;
  }
}

/**
 * One connection. Commands are issued one at a time and awaited, which is all
 * this scanner needs and avoids every pipelining hazard.
 */
export class ImapConnection {
  constructor(socket, { timeoutMs = 30_000 } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.pending = null;      // { resolve, reject, tag, parts, timer }
    this.counter = 0;
    this.closed = false;

    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#drain();
    });
    socket.on('error', (error) => this.#fail(new ImapError(socketReason(error), 'network')));
    socket.on('close', () => {
      this.closed = true;
      this.#fail(new ImapError('The server closed the connection.', 'network'));
    });
  }

  /** Open a TLS connection and wait for the server greeting. */
  static connect({ host, port = 993, timeoutMs = 30_000 }) {
    return new Promise((resolve, reject) => {
      // SNI carries a host name, never an address: Node refuses an IP here.
      const options = { host, port, ...(net.isIP(host) ? {} : { servername: host }) };
      const socket = tls.connect(options, () => {
        const connection = new ImapConnection(socket, { timeoutMs });
        // The greeting is an untagged line; wait for it before anything else.
        connection.#expectGreeting().then(() => resolve(connection), reject);
      });
      socket.setTimeout(timeoutMs, () => {
        socket.destroy();
        reject(new ImapError('The mail server did not answer in time.', 'timeout'));
      });
      socket.once('error', (error) =>
        reject(new ImapError(`Could not reach the mail server: ${socketReason(error)}`, 'network')));
    });
  }

  #expectGreeting() {
    return new Promise((resolve, reject) => {
      this.pending = {
        greeting: true,
        parts: [],
        resolve,
        reject,
        timer: setTimeout(() => this.#fail(new ImapError('No greeting from the mail server.', 'timeout')), this.timeoutMs),
      };
      this.#drain();
    });
  }

  #fail(error) {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  /**
   * Consume whatever is in the buffer. Returns as soon as it needs more bytes,
   * so a response split across packets is picked up on the next chunk.
   */
  #drain() {
    while (this.pending) {
      const end = this.buffer.indexOf(CRLF);
      if (end === -1) return;                       // no complete line yet
      const line = this.buffer.subarray(0, end);

      // A line ending in {n} announces n raw bytes that follow it.
      const literal = /\{(\d+)\}$/.exec(line.toString('latin1'));
      if (literal) {
        const size = Number(literal[1]);
        const start = end + CRLF.length;
        if (this.buffer.length < start + size) return; // wait for the whole literal
        this.pending.parts.push({ type: 'line', value: line.toString('utf8') });
        this.pending.parts.push({ type: 'literal', value: this.buffer.subarray(start, start + size) });
        this.buffer = this.buffer.subarray(start + size);
        continue;
      }

      this.buffer = this.buffer.subarray(end + CRLF.length);
      const text = line.toString('utf8');

      if (this.pending.greeting) {
        const pending = this.pending;
        this.pending = null;
        clearTimeout(pending.timer);
        if (/^\* (OK|PREAUTH)/i.test(text)) pending.resolve(text);
        else pending.reject(new ImapError(`The mail server refused the connection: ${text}`, 'greeting'));
        continue;
      }

      this.pending.parts.push({ type: 'line', value: text });

      // The tagged line closes the command.
      const done = new RegExp(`^${this.pending.tag} (OK|NO|BAD)\\b(.*)$`, 'i').exec(text);
      if (!done) continue;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      const status = done[1].toUpperCase();
      if (status === 'OK') {
        pending.resolve(pending.parts.slice(0, -1)); // drop the completion line
      } else {
        pending.reject(new ImapError(done[2].trim() || `The server answered ${status}.`,
          status === 'NO' ? 'rejected' : 'bad_command'));
      }
    }
  }

  /** Send one command and resolve with its untagged response parts. */
  send(command) {
    if (this.closed) return Promise.reject(new ImapError('The connection is closed.', 'network'));
    if (this.pending) return Promise.reject(new ImapError('A command is already running.', 'busy'));
    this.counter += 1;
    const tag = `a${String(this.counter).padStart(4, '0')}`;
    return new Promise((resolve, reject) => {
      this.pending = {
        tag,
        parts: [],
        resolve,
        reject,
        timer: setTimeout(() => this.#fail(new ImapError('The mail server stopped answering.', 'timeout')), this.timeoutMs),
      };
      this.socket.write(`${tag} ${command}${CRLF}`);
      this.#drain();
    });
  }

  login(user, password) {
    return this.send(`LOGIN ${quoted(user)} ${quoted(password)}`);
  }

  /** EXAMINE, never SELECT: the mailbox is opened read-only, by the protocol. */
  examine(mailbox = 'INBOX') {
    return this.send(`EXAMINE ${quoted(mailbox)}`);
  }

  /** UIDs of the messages received on or after `since`. */
  async search(since) {
    const parts = await this.send(`UID SEARCH SINCE ${imapDate(since)}`);
    const uids = [];
    for (const part of parts) {
      if (part.type !== 'line') continue;
      const found = /^\* SEARCH([\d ]*)$/i.exec(part.value.trim());
      if (found) uids.push(...found[1].trim().split(/\s+/).filter(Boolean).map(Number));
    }
    return uids.filter(Number.isFinite);
  }

  /**
   * The first `bytes` of each message, headers included, as raw bytes.
   * BODY.PEEK never sets the \Seen flag, and on a mailbox opened with EXAMINE
   * the server would refuse to set it anyway.
   */
  async fetchHeads(uids, bytes = 65_536) {
    if (uids.length === 0) return new Map();
    const parts = await this.send(`UID FETCH ${uids.join(',')} (UID BODY.PEEK[]<0.${bytes}>)`);
    const messages = new Map();
    let uid = null;
    for (const part of parts) {
      if (part.type === 'line') {
        const found = /^\* \d+ FETCH .*?\bUID (\d+)/i.exec(part.value);
        if (found) uid = Number(found[1]);
      } else if (part.type === 'literal' && uid !== null) {
        messages.set(uid, part.value);
        uid = null;
      }
    }
    return messages;
  }

  async logout() {
    try {
      await this.send('LOGOUT');
    } catch {
      // The server hanging up on LOGOUT is normal, and we are leaving anyway.
    }
    this.close();
  }

  close() {
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      // already gone
    }
  }
}

/** Run `work` against a signed-in, read-only connection, and always hang up. */
export async function withMailbox({ host, port, user, password, mailbox = 'INBOX', timeoutMs = 30_000 }, work) {
  const connection = await ImapConnection.connect({ host, port, timeoutMs });
  try {
    try {
      await connection.login(user, password);
    } catch (error) {
      // Gmail answers NO with a long help URL; say the useful part instead.
      throw new ImapError(
        error.code === 'rejected'
          ? 'The mail server refused these credentials. With Gmail, use a 16-character app password, not your account password.'
          : error.message,
        error.code === 'rejected' ? 'bad_credentials' : error.code
      );
    }
    await connection.examine(mailbox);
    return await work(connection);
  } finally {
    await connection.logout();
  }
}
