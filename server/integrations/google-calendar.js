/* Google Calendar.
 *
 * One account's calendars, read and written through the Calendar v3 API with
 * an OAuth 2.0 refresh token the dashboard holds encrypted. Nothing here is
 * called from a request handler without going through the module's worker:
 * every function below either talks to Google or parses what Google said, and
 * modules/README.md says where that belongs.
 *
 * Why the dashboard asks for its own client id and secret rather than
 * shipping one: Glassboard is self-hosted, so there is no "our" Google
 * project to put a shared credential in, and a credential shared across
 * installations would be a single quota and a single thing to revoke. Each
 * instance registers its own client, which is also what lets the consent
 * screen name the dashboard it is granting access to.
 *
 * Why the redirect URI is a setting rather than derived from the request:
 * Google refuses a redirect URI whose host is a raw IP address and requires
 * HTTPS for everything but localhost, so a dashboard reached at
 * https://192.168.1.50 cannot receive the redirect at all. Such an instance
 * uses a loopback redirect and pastes the answer back (completeFromPaste
 * below); an instance with a public hostname points the redirect at its own
 * callback route and never sees the paste box. The setting is what lets the
 * same code serve both. */
import crypto from 'node:crypto';
import { setSecret, getSecret, cacheGet, cacheSet, cacheDeletePrefix } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

/* Read and write, because the panel creates and edits events. `email` is not
   decoration: the status line has to be able to say which Google account is
   connected, or a reader with two of them cannot tell what they are looking
   at. */
export const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/userinfo.email',
];

/* The loopback redirect offered by default. Any port on 127.0.0.1 is a valid
   redirect URI for a Google client and nothing listens on it — the browser
   lands on a dead page whose address carries the authorization code, which is
   the whole trick. */
export const LOOPBACK_REDIRECT = 'http://127.0.0.1:33333/';

/** How long a half-finished sign-in is allowed to sit before it is forgotten. */
const AUTH_TTL_SECONDS = 600;

/* Google's clock and ours are never quite the same, and an access token used
   in the second it expires fails the whole sync. A minute of margin costs one
   extra refresh an hour. */
const TOKEN_MARGIN_SECONDS = 60;

const NAME = {
  clientId: 'google.clientId',
  clientSecret: 'google.clientSecret',
  refreshToken: 'google.refreshToken',
  account: 'google.account',
};

const read = (userId, name) => decrypt(getSecret(userId, name));
const write = (userId, name, value) =>
  setSecret(userId, name, value === null ? null : encrypt(value));

/* ------------------------------ credentials ------------------------------- */

/** The OAuth client this account authorises against, or null when there is none. */
export function client(userId) {
  const id = read(userId, NAME.clientId);
  const secret = read(userId, NAME.clientSecret);
  return id && secret ? { id, secret } : null;
}

export function setClient(userId, clientId, clientSecret) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!id || !secret) throw new Error('A client ID and a client secret are both required.');
  if (!id.includes('.apps.googleusercontent.com')) {
    // Said here rather than discovered as an opaque "invalid_client" from
    // Google three clicks later.
    throw new Error('That does not look like a Google client ID — it should end in .apps.googleusercontent.com.');
  }
  write(userId, NAME.clientId, id);
  write(userId, NAME.clientSecret, secret);
}

/** Forget the client as well as the grant: the pane's "disconnect everything". */
export function forget(userId) {
  for (const name of Object.values(NAME)) write(userId, name, null);
  cacheDeletePrefix(`gcal:${userId}:`);
}

/** Give back the grant but keep the client, so reconnecting is one click. */
export async function disconnect(userId) {
  const token = read(userId, NAME.refreshToken);
  write(userId, NAME.refreshToken, null);
  write(userId, NAME.account, null);
  cacheDeletePrefix(`gcal:${userId}:`);
  if (!token) return;
  /* Telling Google is the difference between "this dashboard can no longer
     reach my calendar" and "this dashboard has stopped asking". Best effort:
     the local token is already gone, which is what the reader asked for. */
  try {
    await fetch(REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* ignored on purpose */
  }
}

export const isConnected = (userId) => Boolean(read(userId, NAME.refreshToken));

export function credentialStatus(userId) {
  const own = client(userId);
  return {
    configured: Boolean(own),
    connected: isConnected(userId),
    clientId: own?.id ?? '',
    account: read(userId, NAME.account) ?? '',
  };
}

/* --------------------------------- OAuth --------------------------------- */
/* Authorization code with PKCE. The verifier never leaves the server and the
   state is what ties a callback back to the account that started it — without
   it, a callback is an unauthenticated request carrying a code, and the one
   question it has to answer is whose code it is. */

const base64url = (buffer) => buffer.toString('base64url');

/**
 * Begin a sign-in.
 * @returns {{url: string, state: string, redirectUri: string}}
 */
export function startAuth(userId, redirectUri) {
  const own = client(userId);
  if (!own) throw new Error('Add the Google client ID and secret first.');
  const target = String(redirectUri || LOOPBACK_REDIRECT).trim();
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(24));

  cacheSet(`gcal:auth:${state}`, { userId, verifier, redirectUri: target }, AUTH_TTL_SECONDS);

  const url = new URL(AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: own.id,
    redirect_uri: target,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // Without both of these Google hands back no refresh token on a second
    // authorisation, and the dashboard would work until its first restart.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  }).toString();

  return { url: url.toString(), state, redirectUri: target };
}

/** The pending sign-in a callback belongs to, consumed on use. */
function takeAuth(state) {
  const key = `gcal:auth:${state}`;
  const pending = cacheGet(key);
  if (!pending) return null;
  // Consumed, not merely read: an authorization code is good once, and a
  // state left behind is a replay somebody could try.
  cacheDeletePrefix(key);
  return pending;
}

/**
 * Finish a sign-in from the authorization code.
 *
 * `expectedUserId` is passed on the paste path, where the account is known
 * from the session, and left out on the callback path, where it comes from
 * the state. Either way the two must agree: a code pasted by one account must
 * not be able to attach a Google grant to another's dashboard.
 */
export async function completeAuth({ code, state, expectedUserId = null }) {
  const pending = takeAuth(String(state || ''));
  if (!pending) throw new Error('That sign-in has expired. Start it again from the settings.');
  if (expectedUserId !== null && pending.userId !== expectedUserId) {
    throw new Error('That sign-in was started by another account.');
  }
  const userId = pending.userId;
  const own = client(userId);
  if (!own) throw new Error('The Google client ID and secret are gone.');

  const tokens = await postForm(TOKEN_ENDPOINT, {
    client_id: own.id,
    client_secret: own.secret,
    code: String(code || ''),
    code_verifier: pending.verifier,
    redirect_uri: pending.redirectUri,
    grant_type: 'authorization_code',
  });

  if (!tokens.refresh_token) {
    /* Google only issues one when it means to, and a grant without one works
       for an hour and then silently stops. Better to refuse the connection
       than to hand back a dashboard that breaks after lunch. */
    throw new Error('Google returned no refresh token. Remove Glassboard from your Google account’s third-party access and try again.');
  }
  write(userId, NAME.refreshToken, tokens.refresh_token);
  cacheSet(`gcal:${userId}:token`, tokens.access_token, Math.max(60, (tokens.expires_in ?? 3600) - TOKEN_MARGIN_SECONDS));

  const account = await whoami(tokens.access_token);
  write(userId, NAME.account, account);
  return { userId, account };
}

/**
 * Finish a sign-in from whatever the reader pasted back.
 *
 * They are asked for the whole address of the page they landed on, because
 * that is the thing they can select without understanding it. A bare code is
 * accepted too, but then the state has to come from somewhere — so only one
 * sign-in may be pending, which is the normal case anyway.
 */
export async function completeFromPaste(userId, pasted) {
  const text = String(pasted || '').trim();
  if (!text) throw new Error('Paste the address of the page you landed on.');
  let code = '';
  let state = '';
  try {
    const url = new URL(text);
    code = url.searchParams.get('code') ?? '';
    state = url.searchParams.get('state') ?? '';
    const refused = url.searchParams.get('error');
    if (refused) throw new Error(`Google refused the sign-in: ${refused}`);
  } catch (error) {
    if (error.message.startsWith('Google refused')) throw error;
    // Not a URL: take it for the code itself.
    code = text;
  }
  if (!code) throw new Error('That address carries no authorization code.');
  if (!state) throw new Error('That address carries no state. Start the sign-in again and paste the whole address.');
  return completeAuth({ code, state, expectedUserId: userId });
}

async function whoami(accessToken) {
  try {
    const response = await fetch(USERINFO, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return '';
    return (await response.json()).email ?? '';
  } catch {
    // A nicety, not a requirement: the connection stands either way.
    return '';
  }
}

/* -------------------------------- tokens --------------------------------- */

/** A usable access token, refreshed when the cached one has run out. */
async function accessToken(userId) {
  const cached = cacheGet(`gcal:${userId}:token`);
  if (cached) return cached;

  const own = client(userId);
  const refresh = read(userId, NAME.refreshToken);
  if (!own || !refresh) throw Object.assign(new Error('Not connected to Google.'), { code: 'not_connected' });

  let tokens;
  try {
    tokens = await postForm(TOKEN_ENDPOINT, {
      client_id: own.id,
      client_secret: own.secret,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    });
  } catch (error) {
    /* A revoked or expired grant is not a transient failure, and retrying it
       every minute for the rest of the week helps nobody. The token goes, so
       the dashboard says "not connected" and the reader knows to reconnect. */
    if (/invalid_grant/i.test(error.message)) {
      write(userId, NAME.refreshToken, null);
      throw Object.assign(
        new Error('Google no longer accepts the stored authorisation. Reconnect the account in the settings.'),
        { code: 'not_connected' }
      );
    }
    throw error;
  }
  cacheSet(`gcal:${userId}:token`, tokens.access_token, Math.max(60, (tokens.expires_in ?? 3600) - TOKEN_MARGIN_SECONDS));
  return tokens.access_token;
}

/* --------------------------------- HTTP ---------------------------------- */

async function postForm(url, fields) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error_description || payload.error || `Google answered ${response.status}`);
  }
  return payload;
}

/** A Calendar API call, with the account's token and Google's own message on
 *  failure — "Google answered 403" alone has never helped anybody. */
async function call(userId, path, { method = 'GET', query = null, body = null } = {}) {
  const token = await accessToken(userId);
  const url = new URL(`${API}${path}`);
  if (query) url.search = new URLSearchParams(query).toString();
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25_000),
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error?.message || payload.error_description || `HTTP ${response.status}`;
    throw Object.assign(new Error(detail), { status: response.status });
  }
  return payload;
}

/* ------------------------------- calendars ------------------------------- */

/**
 * The calendars this account can see.
 *
 * `writable` is the access role reduced to the one question the panel asks:
 * may a reader add an event here. A calendar subscribed to read-only — a
 * holiday feed, somebody else's shared agenda — is shown and never offered as
 * a destination.
 */
export async function listCalendars(userId) {
  const payload = await call(userId, '/users/me/calendarList', {
    query: { minAccessRole: 'reader', showHidden: 'false', maxResults: '250' },
  });
  return (payload.items ?? []).map((item) => ({
    id: item.id,
    name: item.summaryOverride || item.summary || item.id,
    colour: item.backgroundColor || '#0a84ff',
    primary: item.primary === true,
    selected: item.selected !== false,
    writable: item.accessRole === 'owner' || item.accessRole === 'writer',
    timeZone: item.timeZone || '',
  }));
}

/* -------------------------------- events --------------------------------- */

/* What the browser receives. Google's own event object is large, deeply
   optional and carries fields the panel has no business seeing — attendees'
   addresses among them. Normalising here means the wire carries what the
   calendar draws and nothing else. */
function normalise(event, calendar) {
  const allDay = Boolean(event.start?.date);
  return {
    id: event.id,
    calendarId: calendar.id,
    calendarName: calendar.name,
    colour: calendar.colour,
    title: event.summary || '',
    allDay,
    // An all-day event carries plain YYYY-MM-DD; a timed one carries an
    // instant. Both travel as given and the browser decides how to show them.
    start: allDay ? event.start.date : event.start?.dateTime ?? '',
    end: allDay ? event.end?.date ?? event.start.date : event.end?.dateTime ?? '',
    location: event.location || '',
    description: event.description || '',
    link: event.htmlLink || '',
    status: event.status || 'confirmed',
    /* A single occurrence of a repeating event can be edited, but editing it
       here would quietly change one Tuesday and leave the series alone, which
       is not what anybody means by "move this". The panel sends such an event
       to Google's own interface instead. */
    recurring: Boolean(event.recurringEventId),
    writable: calendar.writable && !event.recurringEventId,
  };
}

/**
 * Every event in a window, across the calendars asked for.
 *
 * singleEvents expands a repeating event into its occurrences, which is the
 * only way a month grid can be drawn from the answer. The calendars are asked
 * in parallel: eight of them in series is eight round trips to Google on the
 * worker thread, and they do not depend on each other.
 */
export async function fetchWindow(userId, { calendarIds = null, timeMin, timeMax } = {}) {
  const calendars = await listCalendars(userId);
  const wanted = calendarIds?.length
    ? calendars.filter((calendar) => calendarIds.includes(calendar.id))
    : calendars.filter((calendar) => calendar.selected);

  const lists = await Promise.all(
    wanted.map(async (calendar) => {
      try {
        const events = [];
        let pageToken = null;
        do {
          const payload = await call(userId, `/calendars/${encodeURIComponent(calendar.id)}/events`, {
            query: {
              timeMin,
              timeMax,
              singleEvents: 'true',
              orderBy: 'startTime',
              maxResults: '2500',
              ...(pageToken ? { pageToken } : {}),
            },
          });
          for (const item of payload.items ?? []) {
            if (item.status === 'cancelled') continue;
            events.push(normalise(item, calendar));
          }
          pageToken = payload.nextPageToken ?? null;
        } while (pageToken);
        return events;
      } catch (error) {
        /* One unreachable calendar must not empty the month. The others are
           drawn and the failure is reported beside them. */
        console.warn(`[glassboard] calendar "${calendar.name}" did not answer: ${error.message}`);
        return [];
      }
    })
  );

  const events = lists.flat().sort((a, b) => String(a.start).localeCompare(String(b.start)));
  return { events, calendars, fetchedAt: new Date().toISOString() };
}

/* ------------------------------ writing back ----------------------------- */

/* The shape the panel sends, turned into the shape Google takes. Only these
   fields: an event created here is a title, when it is, where it is and a
   note, which is what the editor offers. */
function toGoogle({ title, allDay, start, end, location, description, timeZone }) {
  const when = (value) => (allDay ? { date: value } : { dateTime: value, timeZone: timeZone || undefined });
  return {
    summary: String(title || '').slice(0, 1024),
    location: String(location || '').slice(0, 1024) || undefined,
    description: String(description || '').slice(0, 8192) || undefined,
    start: when(start),
    end: when(end),
  };
}

export async function createEvent(userId, calendarId, draft) {
  const created = await call(userId, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: toGoogle(draft),
  });
  return created.id;
}

export async function updateEvent(userId, calendarId, eventId, draft) {
  await call(userId, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: toGoogle(draft),
  });
}

export async function deleteEvent(userId, calendarId, eventId) {
  await call(userId, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
  });
}

/* --------------------------------- cache --------------------------------- */
/* The window the job keeps warm, and the key a month is filed under. A month
   the reader navigates to outside the warm window is fetched once and cached
   for the same interval, so paging back and forth through last year costs one
   call per month and not one per click. */

export const windowKey = (userId, from, to) => `gcal:${userId}:win:${from}:${to}`;
export const calendarsKey = (userId) => `gcal:${userId}:cals`;
export const syncKey = (userId) => `gcal-sync:${userId}`;

/** Drop every cached window: what a write to the calendar makes necessary. */
export const invalidate = (userId) => cacheDeletePrefix(`gcal:${userId}:win:`);
