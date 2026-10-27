/* Calendar feeds, read over iCalendar.
 *
 * A subscription link and nothing else: the address of a .ics file that the
 * server fetches and parses. There is no account to connect, no consent
 * screen, no token to refresh and nothing to revoke — which is the whole
 * reason this replaced an OAuth client. The price is plain and not worth
 * hiding: a feed is **read-only**. Nothing here can create, move or delete
 * anything, because the protocol has no way to.
 *
 * Every calendar worth subscribing to publishes one. In Google Calendar it is
 * "Secret address in iCal format", under a calendar's own settings; Apple,
 * Nextcloud, Outlook and most association tools have the same thing.
 *
 * None of this runs on the request path: parsing a year of a busy calendar is
 * real work, and modules/README.md says where that belongs. The module's
 * worker is the only caller. */
import ICAL from 'ical.js';
import { setSecret, getSecret } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';

/* A feed is a credential. The "secret address" of a Google calendar grants
   anyone holding it a read of that calendar, for as long as it is not reset —
   so it is encrypted with APP_SECRET and kept out of the configuration
   document, which is a file people mail each other. */
const secretName = (feedId) => `ical.url.${feedId}`;

export const getFeedUrl = (userId, feedId) => decrypt(getSecret(userId, secretName(feedId)));

export const forgetFeed = (userId, feedId) => setSecret(userId, secretName(feedId), null);

/**
 * Store a feed's address.
 *
 * `webcal:` is the scheme calendar applications hand out so that clicking a
 * link opens them rather than a browser. It is https in every other respect,
 * so it is rewritten rather than refused — refusing it would mean telling
 * people to edit a URL by hand for no reason.
 */
export function normaliseUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('A calendar address is required.');
  let url;
  try {
    url = new URL(text.replace(/^webcal:/i, 'https:'));
  } catch {
    throw new Error('That is not a valid address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('A calendar address has to start with https:// (or webcal://).');
  }
  return url.toString();
}

export function setFeedUrl(userId, feedId, raw) {
  const url = normaliseUrl(raw);
  setSecret(userId, secretName(feedId), encrypt(url));
  return url;
}

/* Enough for years of a busy calendar, small enough that a wrong address
   cannot fill the disk while nobody is watching. */
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 25_000;

/**
 * Fetch a feed's text.
 *
 * The address is one the account's own owner typed, and on a self-hosted
 * dashboard it is quite normally a calendar on the same network — a Nextcloud
 * upstairs, an association's server. So private addresses are not blocked:
 * blocking them would break the ordinary case to guard against somebody
 * attacking their own instance. What is bounded is the damage a wrong address
 * can do: two schemes, one timeout, one size.
 */
export async function fetchFeed(url) {
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: { Accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    /* "fetch failed" is what Node says when a host does not resolve, refuses
       the connection or presents a certificate it does not like, and it tells
       a reader nothing they can act on. The cause underneath usually does. */
    if (error.name === 'TimeoutError') {
      throw new Error('That calendar took too long to answer.');
    }
    const cause = error.cause?.code || error.cause?.message || '';
    throw new Error(
      cause ? `That address could not be reached (${cause}).` : 'That address could not be reached.'
    );
  }
  if (!response.ok) {
    throw new Error(`The calendar answered ${response.status}. Check the address.`);
  }
  const text = await readCapped(response);
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    /* The usual mistake is the page you look at rather than the file you
       subscribe to, and an HTML page parses as nothing at all. */
    throw new Error('That address did not return a calendar file. Use the iCal (.ics) address, not the page you view the calendar on.');
  }
  return text;
}

async function readCapped(response) {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, MAX_BYTES);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error('That calendar is too large to read.');
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

/* -------------------------------- parsing -------------------------------- */

/** The calendar's own name, when it gives one. */
export function feedName(text) {
  try {
    const comp = new ICAL.Component(ICAL.parse(text));
    return String(comp.getFirstPropertyValue('x-wr-calname') || '').slice(0, 120);
  } catch {
    return '';
  }
}

/** A guard, not a design limit: a feed with a daily repeat and no end would
 *  otherwise be iterated for as long as the window allows. */
const MAX_OCCURRENCES = 2000;

/**
 * Every occurrence a window contains, as the dashboard draws them.
 *
 * The three things that make this more than a loop over VEVENTs, and that a
 * hand-written parser gets wrong in silence:
 *
 *  - a repeating event is one VEVENT and many occurrences, so it is expanded;
 *  - EXDATE removes occurrences from that expansion — the week the class was
 *    cancelled;
 *  - an occurrence moved or renamed on its own travels as a second VEVENT
 *    with the same UID and a RECURRENCE-ID, which has to be related back to
 *    the series or the calendar shows both the old slot and the new one.
 *
 * VTIMEZONE definitions are registered first: without them every timed event
 * in a feed that carries its own timezone is read as floating time, which is
 * wrong by an hour for half the year.
 */
export function eventsInWindow(text, feed, { timeMin, timeMax }) {
  const comp = new ICAL.Component(ICAL.parse(text));
  for (const zone of comp.getAllSubcomponents('vtimezone')) {
    const timezone = new ICAL.Timezone(zone);
    if (!ICAL.TimezoneService.has(timezone.tzid)) ICAL.TimezoneService.register(timezone.tzid, timezone);
  }

  const from = ICAL.Time.fromJSDate(new Date(timeMin), true);
  const to = ICAL.Time.fromJSDate(new Date(timeMax), true);

  const all = comp.getAllSubcomponents('vevent').map((c) => new ICAL.Event(c));
  const masters = all.filter((event) => !event.isRecurrenceException());
  const byUid = new Map(masters.map((event) => [event.uid, event]));
  for (const exception of all.filter((event) => event.isRecurrenceException())) {
    byUid.get(exception.uid)?.relateException(exception);
  }

  const events = [];
  for (const event of masters) {
    if (events.length >= MAX_OCCURRENCES) break;
    try {
      if (!event.isRecurring()) {
        if (overlaps(event.startDate, event.endDate, from, to)) events.push(shape(event, event.startDate, event.endDate, feed));
        continue;
      }
      const iterator = event.iterator();
      let next;
      let seen = 0;
      while ((next = iterator.next()) && seen++ < MAX_OCCURRENCES) {
        if (next.compare(to) > 0) break;
        const details = event.getOccurrenceDetails(next);
        if (details.endDate.compare(from) <= 0) continue;
        events.push(shape(details.item, details.startDate, details.endDate, feed));
        if (events.length >= MAX_OCCURRENCES) break;
      }
    } catch (error) {
      /* One malformed event is not the calendar. Google and Nextcloud both
         emit the odd VEVENT that nothing can make sense of. */
      console.warn(`[glassboard] ical: an event in "${feed.name}" was skipped — ${error.message}`);
    }
  }
  return events;
}

const overlaps = (start, end, from, to) =>
  (end ?? start).compare(from) > 0 && start.compare(to) <= 0;

/** A URL the browser may be handed, or an empty string. Only http(s): a feed
 *  is a third party, and a `javascript:` URL in an href is a hole. */
function httpUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString().slice(0, 2000) : '';
  } catch {
    return '';
  }
}

/* DESCRIPTION is meant to be plain text, and most of the time it is. Some
 * tools put HTML in it anyway — Google itself does on invitations — and a
 * reader should see the words rather than the markup around them.
 *
 * This turns such a description back into text. It does NOT sanitise HTML for
 * display, because nothing here is ever displayed as HTML: the browser builds
 * the links itself out of the text below, which is the only way a calendar
 * belonging to somebody else cannot put markup on this dashboard.
 *
 * A link keeps its address beside its words — "the minutes (https://…)" —
 * because the address is the part a reader can act on, and dropping it would
 * lose exactly what this is for. */
function plainText(raw) {
  const text = String(raw ?? '');
  if (!/[<&]/.test(text)) return text;
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (whole, href, label) => {
      const words = label.replace(/<[^>]*>/g, '').trim();
      // A link whose words are already the address says it once, not twice.
      return !words || words === href ? href : `${words} (${href})`;
    })
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* What the browser receives: what the calendar draws, and nothing else. An
   iCalendar file carries attendees, organisers and alarms; none of that is on
   screen, so none of it travels. */
function shape(event, startDate, endDate, feed) {
  const allDay = startDate.isDate;
  return {
    // Unique per occurrence: the UID alone repeats across a series.
    id: `${event.uid}@${startDate.toString()}`,
    calendarId: feed.id,
    calendarName: feed.name,
    colour: feed.colour,
    title: String(event.summary || '').slice(0, 300),
    allDay,
    /* An all-day event travels as a plain day, a timed one as an instant, and
       the browser places either into a day itself — it is the only part of
       this that knows what timezone the reader is in. */
    start: allDay ? startDate.toString().slice(0, 10) : startDate.toJSDate().toISOString(),
    end: allDay
      ? (endDate ?? startDate).toString().slice(0, 10)
      : (endDate ?? startDate).toJSDate().toISOString(),
    location: String(event.location || '').slice(0, 300),
    description: plainText(event.description).slice(0, 2000),
    link: httpUrl(event.component?.getFirstPropertyValue('url')),
    recurring: Boolean(event.component?.getFirstPropertyValue('rrule')),
  };
}

/* --------------------------------- cache --------------------------------- */

export const windowKey = (userId, from, to) => `cal:${userId}:win:${from}:${to}`;
export const syncKey = (userId) => `cal-sync:${userId}`;
