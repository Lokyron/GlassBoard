// Just enough MIME to read a shipping notification.
//
// A tracking number is routinely cut in half by a quoted-printable soft line
// break, or hidden inside a base64 part, so decoding is not optional: without
// it the scanner would miss most of what it is looking for. Everything here is
// read-only text handling, and anything it cannot make sense of degrades to the
// raw bytes rather than throwing.

const HEADER_END = /\r?\n\r?\n/;

/** Split a raw message into its headers and whatever follows. */
export function splitMessage(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
  const match = HEADER_END.exec(text);
  if (!match) return { head: text, body: '' };
  return { head: text.slice(0, match.index), body: text.slice(match.index + match[0].length) };
}

/** Header fields, unfolded, lowercased keys, last one wins. */
export function parseHeaders(head) {
  const headers = {};
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

/** `=?utf-8?B?…?=` and friends, as they appear in subjects and sender names. */
export function decodeWords(value) {
  return String(value ?? '').replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (whole, charset, encoding, payload) => {
      try {
        const bytes = encoding.toLowerCase() === 'b'
          ? Buffer.from(payload, 'base64')
          : Buffer.from(payload.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
            String.fromCharCode(Number.parseInt(hex, 16))), 'latin1');
        return decodeCharset(bytes, charset);
      } catch {
        return whole;
      }
    }
  ).replace(/\?=\s+=\?/g, '');
}

/** Node knows utf-8 and latin1; anything else falls back to latin1 rather than failing. */
function decodeCharset(bytes, charset) {
  const name = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try {
    if (name === 'utf-8' || name === 'utf8') return bytes.toString('utf8');
    if (name === 'us-ascii' || name === 'ascii') return bytes.toString('ascii');
    return new TextDecoder(name).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

export function decodeQuotedPrintable(text) {
  return Buffer.from(
    text
      .replace(/=\r?\n/g, '')                                   // soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))),
    'latin1'
  );
}

const decodeBody = (text, encoding) => {
  const how = String(encoding || '').toLowerCase();
  if (how === 'base64') return Buffer.from(text.replace(/\s+/g, ''), 'base64');
  if (how === 'quoted-printable') return decodeQuotedPrintable(text);
  return Buffer.from(text, 'latin1');
};

const parameterOf = (header, name) => {
  const found = new RegExp(`${name}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(header || '');
  return found ? (found[2] ?? found[1]) : null;
};

/**
 * The readable text of a message: every text part, decoded and concatenated.
 * HTML is kept, with its tags stripped, because plenty of senders ship a
 * tracking number in the HTML part alone.
 */
export function readableText(raw, { maxChars = 120_000 } = {}) {
  const { head, body } = splitMessage(raw);
  const headers = parseHeaders(head);
  const pieces = [];
  collect(headers, body, pieces, 0);
  const text = pieces.join('\n').slice(0, maxChars);
  // Entities that matter for reading a number out of HTML.
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function collect(headers, body, pieces, depth) {
  if (depth > 6) return; // a malformed message must not spin here
  const contentType = headers['content-type'] || 'text/plain';
  const boundary = parameterOf(contentType, 'boundary');

  if (/^multipart\//i.test(contentType) && boundary) {
    const marker = `--${boundary}`;
    const sections = body.split(marker);
    for (const section of sections.slice(1)) {
      if (/^--/.test(section)) break;                 // closing delimiter
      const { head: subHead, body: subBody } = splitMessage(section.replace(/^\r?\n/, ''));
      collect(parseHeaders(subHead), subBody, pieces, depth + 1);
    }
    return;
  }

  if (!/^text\//i.test(contentType)) return;           // images and attachments hold nothing for us
  const decoded = decodeBody(body, headers['content-transfer-encoding']);
  let text = decodeCharset(decoded, parameterOf(contentType, 'charset') || 'utf-8');
  if (/^text\/html/i.test(contentType)) {
    // The tracking number frequently lives only in an href, so the links are
    // lifted out as plain text before the tags are thrown away.
    const links = [...text.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    text = text
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    if (links.length) text += `\n${links.join('\n')}`;
  }
  pieces.push(text);
}

/** The address part of a From header, lowercased. */
export function senderAddress(from) {
  const angle = /<([^>]+)>/.exec(from || '');
  const address = angle ? angle[1] : String(from || '').trim();
  return address.toLowerCase().replace(/^"|"$/g, '').trim();
}
