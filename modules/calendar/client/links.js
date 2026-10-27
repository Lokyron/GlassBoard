/* Turning the text of somebody else's calendar into things you can click.
 *
 * The one rule this file exists to keep: **the feed's text is never HTML.**
 * A subscribed calendar belongs to somebody else, and on a shared instance it
 * may not even belong to the reader — so its description is never handed to
 * innerHTML. The links are built here, as elements, out of text that was
 * matched by a pattern. That is the difference between a calendar that can
 * show you a link and a calendar that can put markup on your dashboard.
 *
 * Only http and https are ever turned into a link. `javascript:` in an href
 * is the hole this closes, and a scheme nobody recognises is left as the
 * words it already was. */
import { el } from '/assets/core/kernel.js';

/* Addresses, e-mail addresses and telephone numbers, in that order of
   greed — the URL pattern has to win over the e-mail one inside a link that
   contains an @. */
const PATTERN = /(https?:\/\/[^\s<>"']+)|([\w.+-]+@[\w-]+\.[\w.-]+)|(\+[\d\s().-]{7,}\d)/g;

/* A sentence ending in a link should not swallow the full stop, and a link
   written as "see this (https://x)" should not keep the bracket. */
const TRAILING = /[.,;:!?]+$/;

function trim(url) {
  let text = url.replace(TRAILING, '');
  while (text.endsWith(')') && (text.match(/\(/g) ?? []).length < (text.match(/\)/g) ?? []).length) {
    text = text.slice(0, -1);
  }
  return text;
}

const anchor = (href, label) =>
  el('a', { href, target: '_blank', rel: 'noopener noreferrer nofollow', text: label });

/**
 * Text with its links as elements: a list of strings and anchors, ready to be
 * appended. Never a string of markup, which is the whole point.
 */
export function linkNodes(raw) {
  const text = String(raw ?? '');
  const nodes = [];
  let last = 0;
  for (const match of text.matchAll(PATTERN)) {
    const [whole, url, email, phone] = match;
    const at = match.index;
    if (at > last) nodes.push(text.slice(last, at));

    if (url) {
      const clean = trim(url);
      nodes.push(anchor(clean, clean));
      // Whatever the trim gave back is text again, not part of the link.
      if (clean.length < whole.length) nodes.push(whole.slice(clean.length));
    } else if (email) {
      nodes.push(anchor(`mailto:${email}`, email));
    } else {
      // Spaces and brackets are how people write a number; tel: takes neither.
      nodes.push(anchor(`tel:${phone.replace(/[^\d+]/g, '')}`, phone.trim()));
    }
    last = at + whole.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * Where a place should take you.
 *
 * A location field holds either an address or, more and more often, the link
 * to a meeting — so a value that is already a URL is followed as one rather
 * than searched for on a map. Everything else goes to Google Maps.
 *
 * Not OpenStreetMap, which is what the GeoRide map is drawn with: that one is
 * a map rendered inside the dashboard, where the choice is about tiles and a
 * usage policy. This is a link that leaves, on a phone as often as not, and
 * there it opens the maps application somebody already has their places and
 * their traffic in. The two decisions have nothing in common but the word.
 *
 * `api=1` is Google's documented, stable form for a search link, so it does
 * not depend on the shape of a URL that happens to work today.
 */
export function placeLink(location) {
  const text = String(location ?? '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol === 'http:' || url.protocol === 'https:') return { href: url.toString(), isMap: false };
  } catch {
    /* not a URL: it is a place */
  }
  return {
    href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}`,
    isMap: true,
  };
}
