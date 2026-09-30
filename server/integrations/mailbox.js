// Finding parcels in a mailbox.
//
// The scan proposes, it never decides: every number it finds becomes a
// *suggestion* the user accepts or ignores. That is not timidity, it is the
// quota rule of the tracking provider showing through the design — a credit is
// spent the moment a number is registered, so a scanner that registered on its
// own would empty the allowance on parcels nobody asked about.
//
// Because a human confirms, extraction can afford to be generous: a false
// positive costs a glance, a missed parcel costs the whole feature.
//
// Nothing of the mail is kept. Only the number, a short label taken from the
// subject, and the UID of the message so it is not read twice.
import { withMailbox } from './imap.js';
import { readableText, splitMessage, parseHeaders, decodeWords, senderAddress } from './mime.js';
import {
  getSecret, setSecret, getMeta, setMeta, listParcelRows, findParcelByNumber,
  listSuggestionRows, insertSuggestionRow, getSuggestionRow, setSuggestionState,
  updateParcelInfo, now,
} from '../db.js';
import { encrypt, decrypt } from '../crypto.js';

const SECRET_PASSWORD = 'mail.password';
const META_LAST_SCAN = 'mail.last_scan';
const META_LAST_UID = 'mail.last_uid';

/* ------------------------------ credentials ------------------------------ */

export const isConfigured = () => Boolean(decrypt(getSecret(SECRET_PASSWORD)));

export function setPassword(password) {
  setSecret(SECRET_PASSWORD, password ? encrypt(String(password).trim()) : null);
}

const credentials = (settings) => ({
  host: settings.host,
  port: settings.port,
  user: settings.user,
  password: decrypt(getSecret(SECRET_PASSWORD)),
  mailbox: settings.mailbox || 'INBOX',
});

/* ------------------------------- extraction ------------------------------ */

// Hosts whose links carry a tracking number. A link is the strongest signal
// there is: the sender put it there on purpose, for a human to click.
const CARRIER_HOSTS = [
  ['laposte.fr', 'La Poste'], ['colissimo.fr', 'Colissimo'], ['chronopost.fr', 'Chronopost'],
  ['mondialrelay.com', 'Mondial Relay'], ['mondialrelay.fr', 'Mondial Relay'],
  ['ups.com', 'UPS'], ['dhl.com', 'DHL'], ['dhl.de', 'DHL'], ['gls-group.eu', 'GLS'],
  ['gls-group.com', 'GLS'], ['dpd.fr', 'DPD'], ['dpd.com', 'DPD'], ['fedex.com', 'FedEx'],
  ['colisprive.com', 'Colis Privé'], ['colisprive.fr', 'Colis Privé'],
  ['17track.net', null], ['laposte.net', 'La Poste'], ['swiship.com', 'Amazon'],
  ['amazon.fr', 'Amazon'], ['amazon.com', 'Amazon'], ['amazon.de', 'Amazon'],
];

// Query parameters those links use for the number itself.
const NUMBER_PARAMS = [
  'numero', 'number', 'tracking', 'trackingnumber', 'tracknumbers', 'trackingid',
  'code', 'colis', 'expeditionnumber', 'nums', 'idab', 'shipmentid', 'trackid',
];

// Shapes confident enough to propose on their own.
//   UPS      1Z + 16 alphanumerics
//   Amazon   TBA + digits, its own closed network
//   UPU      two letters, nine digits, two letters: Colissimo international,
//            Chronopost, and most postal operators
const NUMBER_PATTERNS = [
  [/\b1Z[0-9A-Z]{16}\b/gi, 'UPS'],
  [/\bTBA[0-9]{9,15}\b/gi, 'Amazon'],
  [/\b[A-Z]{2}[0-9]{9}[A-Z]{2}\b/g, null],
  [/\b[0-9]{2}[A-Z]{2}[0-9]{9,11}\b/g, null],
];

const looksLikeNumber = (value) => /^[A-Za-z0-9-]{5,50}$/.test(value);

/** Every candidate a single message holds, strongest signal first. */
export function extractCandidates(text) {
  const found = new Map(); // number -> carrier name or null

  for (const raw of text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []) {
    let url;
    try {
      url = new URL(raw.replace(/[.,;]+$/, ''));
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    const carrier = CARRIER_HOSTS.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
    if (!carrier) continue;

    for (const [key, value] of url.searchParams) {
      if (!NUMBER_PARAMS.includes(key.toLowerCase())) continue;
      for (const piece of String(value).split(/[,;]/)) {
        if (looksLikeNumber(piece.trim())) found.set(piece.trim().toUpperCase(), carrier[1]);
      }
    }
    // Several carriers put the number in the path instead.
    const tail = url.pathname.split('/').filter(Boolean).pop();
    if (tail && looksLikeNumber(tail) && /\d{6,}/.test(tail)) found.set(tail.toUpperCase(), carrier[1]);
  }

  for (const [pattern, carrier] of NUMBER_PATTERNS) {
    for (const match of text.match(pattern) ?? []) {
      const number = match.toUpperCase();
      if (!found.has(number)) found.set(number, carrier);
    }
  }
  return [...found].map(([number, carrier]) => ({ number, carrier }));
}

// What a sender says has happened, in the two languages these mails arrive in.
// Deliberately narrow: a phrase that is not clearly one of these leaves the
// parcel where it is rather than inventing progress.
// No \b anchors: in a JavaScript regular expression an accented letter is not a
// word character, so `expédié\b` never matches at the end of a word. That trap
// silently disabled every French phrase the first time round.
const STATE_PHRASES = [
  ['delivered', /(a été livré|a bien été livré|est livré|colis livré|livraison effectuée|was delivered|delivered)/i],
  ['delivery', /(arrive aujourd'hui|arrive aujourd’hui|en cours de livraison|sera livré aujourd'hui|out for delivery|arriving today)/i],
  ['transit', /(a été expédié|est en route|vient d'être expédié|has shipped|has been shipped|on its way|is on the way|expédié)/i],
];

export function stateFromSubject(subject) {
  for (const [state, pattern] of STATE_PHRASES) {
    if (pattern.test(subject)) return state;
  }
  return null;
}

/** A readable name from the subject: what the message is about, trimmed. */
function labelFromSubject(subject) {
  return decodeWords(subject)
    .replace(/^(re|fw|fwd|tr)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/* --------------------------------- scanning ------------------------------- */

const matchesSender = (address, allowed) => {
  if (allowed.length === 0) return true; // no list: look at everything in the window
  return allowed.some((entry) => {
    const wanted = entry.trim().toLowerCase();
    if (!wanted) return false;
    return wanted.startsWith('@') ? address.endsWith(wanted) : address === wanted || address.endsWith(`@${wanted}`);
  });
};

/**
 * Read the window, propose what is new, and let the mails move the parcels they
 * are about. Never throws for a mail it cannot parse: one bad message must not
 * cost the whole scan.
 */
export async function scan(settings) {
  if (!settings.enabled) {
    const error = new Error('The mailbox scan is turned off.');
    error.code = 'disabled';
    throw error;
  }
  if (!isConfigured()) {
    const error = new Error('No mailbox password is stored yet.');
    error.code = 'not_configured';
    throw error;
  }

  const senders = String(settings.senders || '').split(',').map((s) => s.trim()).filter(Boolean);
  const since = new Date(Date.now() - Math.max(1, settings.sinceDays) * 86_400_000);
  const known = new Set(listParcelRows().map((row) => row.tracking_no.toUpperCase()).filter(Boolean));
  const seen = new Set(listSuggestionRows().map((row) => row.tracking_no.toUpperCase()));

  let read = 0;
  let proposed = 0;
  let advanced = 0;

  await withMailbox(credentials(settings), async (connection) => {
    const uids = await connection.search(since);
    // Newest first, and capped: a mailbox opened after a long holiday must not
    // turn one scan into a thousand-message download.
    const wanted = uids.sort((a, b) => b - a).slice(0, Math.max(1, settings.maxMessages));

    for (let i = 0; i < wanted.length; i += 25) {
      const batch = wanted.slice(i, i + 25);
      const messages = await connection.fetchHeads(batch);
      for (const [uid, raw] of messages) {
        read += 1;
        try {
          const headers = parseHeaders(splitMessage(raw).head);
          const address = senderAddress(headers.from);
          if (!matchesSender(address, senders)) continue;

          const subject = decodeWords(headers.subject || '');
          const text = `${subject}\n${readableText(raw)}`;
          const candidates = extractCandidates(text);
          if (candidates.length === 0) continue;

          const state = stateFromSubject(subject);
          for (const { number, carrier } of candidates) {
            // A parcel already followed gets the news; it is not proposed again.
            if (known.has(number)) {
              if (state && advanceParcel(number, state, subject)) advanced += 1;
              continue;
            }
            if (seen.has(number)) continue;
            insertSuggestionRow({
              id: `sug-${Math.random().toString(36).slice(2, 10)}`,
              tracking_no: number,
              carrier_name: carrier ?? '',
              label: labelFromSubject(subject),
              sender: address,
              uid,
              state: 'new',
              created_at: now(),
            });
            seen.add(number);
            proposed += 1;
          }
        } catch {
          // A message this parser cannot make sense of is simply skipped.
        }
      }
    }
    if (wanted.length > 0) setMeta(META_LAST_UID, String(Math.max(...wanted)));
  });

  setMeta(META_LAST_SCAN, now());
  return { read, proposed, advanced, at: getMeta(META_LAST_SCAN) };
}

/**
 * Move a followed parcel along from what a mail says.
 * Only ever forwards, and only for a parcel the provider is not already
 * reporting on: a real carrier feed always wins over a sentence in a subject.
 */
const ORDER = { manual: 0, pending: 1, transit: 2, delivery: 3, pickup: 3, delivered: 4, problem: 4 };

function advanceParcel(number, state, subject) {
  const row = findParcelByNumber(number);
  if (!row || row.registered) return false; // the provider is the better source
  let info = null;
  try {
    info = row.info ? JSON.parse(row.info) : null;
  } catch {
    info = null;
  }
  const current = info?.state ?? 'manual';
  if ((ORDER[state] ?? 0) <= (ORDER[current] ?? 0)) return false;

  const event = { at: Date.now(), location: '', description: subject.slice(0, 200), status: state };
  updateParcelInfo(row.id, {
    status: state,
    info: {
      status: state,
      state,
      subStatus: null,
      carrier: info?.carrier ?? { id: null, name: '' },
      lastEvent: event,
      destination: info?.destination ?? '',
      daysInTransit: null,
      daysSinceUpdate: 0,
      events: [event, ...(info?.events ?? [])].slice(0, 40),
      fromMail: true,
    },
    checkedAt: now(),
  });
  return true;
}

/* ------------------------------- suggestions ------------------------------ */

export function listSuggestions() {
  return listSuggestionRows()
    .filter((row) => row.state === 'new')
    .map((row) => ({
      id: row.id,
      trackingNumber: row.tracking_no,
      carrier: row.carrier_name,
      label: row.label,
      sender: row.sender,
      createdAt: row.created_at,
      // Amazon's own network is queryable by nobody, so say so up front rather
      // than letting the user spend a credit to find out.
      trackable: !/^TBA\d/i.test(row.tracking_no),
    }));
}

/** Read a suggestion without consuming it. */
export function getSuggestion(id) {
  const row = getSuggestionRow(id);
  if (!row) {
    const error = new Error('Unknown suggestion.');
    error.code = 'not_found';
    throw error;
  }
  return row;
}

/**
 * Mark a suggestion as taken. Called only once the parcel really exists: doing
 * it any earlier loses the suggestion when the provider refuses the number, and
 * the user would never be offered it again.
 */
export function markAccepted(id) {
  setSuggestionState(id, 'accepted');
}

export function ignoreSuggestion(id) {
  if (!getSuggestionRow(id)) {
    const error = new Error('Unknown suggestion.');
    error.code = 'not_found';
    throw error;
  }
  setSuggestionState(id, 'ignored');
  return true;
}

export function status() {
  return {
    configured: isConfigured(),
    lastScan: getMeta(META_LAST_SCAN),
    pending: listSuggestions().length,
  };
}

/** Sign in and hang up, to tell the user whether the credentials work at all. */
export async function testConnection(settings) {
  const found = await withMailbox(credentials(settings), (connection) =>
    connection.search(new Date(Date.now() - 86_400_000)));
  return { ok: true, recent: found.length };
}
