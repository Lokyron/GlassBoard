/* The calendar module.
 *
 * Nothing here opens a socket. What is worth checking without Google is the
 * part that is ours: which months the dashboard keeps warm and what a month
 * is as far as a query is concerned, the OAuth sign-in's own bookkeeping —
 * the state that ties a callback to the account that started it, and the fact
 * that it is good once — and that a stored credential never comes back out of
 * a route in the clear.
 *
 * The pieces that do talk to Google are the three functions this file does
 * not call. They are reached only through the worker, which test/workers has
 * its own say about. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('calendar');
const google = await import('../server/integrations/google-calendar.js');
const months = await import('../modules/calendar/months.js');
const { callbackUri } = await import('../modules/calendar/server.js');
const manifest = (await import('../modules/calendar/manifest.js')).default;
const { validateConfig } = await import('../server/config-schema.js');
const { db, now, getSecret } = await import('../server/db.js');

const makeUser = (name) => db
  .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) RETURNING id')
  .get(name, 'x', now()).id;

const USER = makeUser('tester');
const OTHER = makeUser('somebody-else');

const CLIENT_ID = '1234567890-abcdefghijklmnop.apps.googleusercontent.com';

describe('the months the dashboard keeps warm', () => {
  it('is the month before, this one and the two after', () => {
    const warm = months.warmMonths(new Date('2026-10-25T12:00:00Z'));
    assert.deepEqual(warm, ['2026-09', '2026-10', '2026-11', '2026-12']);
  });

  it('carries the year across December', () => {
    assert.deepEqual(
      months.warmMonths(new Date('2026-12-02T12:00:00Z')),
      ['2026-11', '2026-12', '2027-01', '2027-02']
    );
    assert.equal(months.shiftMonth('2026-01', -1), '2025-12');
  });

  it('asks for a month a day wider on each side', () => {
    /* The server does not know the reader's timezone — the browser places
       each event into a day itself — and without the slack an event late on
       the last of the month falls outside the window for anyone far enough
       east. */
    const { timeMin, timeMax } = months.boundsOf('2026-10');
    assert.equal(timeMin, '2026-09-30T00:00:00.000Z');
    assert.equal(timeMax, '2026-11-02T00:00:00.000Z');
  });

  it('takes a month and refuses anything else', () => {
    assert.equal(months.validMonth('2026-10'), '2026-10');
    assert.equal(months.validMonth('2026-13'), null);
    assert.equal(months.validMonth('2026-00'), null);
    assert.equal(months.validMonth('206-10'), null);
    assert.equal(months.validMonth('../../etc/passwd'), null);
    // A century either side of now is plenty, and a year nobody will page to
    // is a cache entry nobody will ever read.
    assert.equal(months.validMonth('9999-01'), null);
  });
});

describe('the redirect URI', () => {
  /* The failure this prevents happens at Google, four clicks away, as
     "Invalid redirect_uri contains reserved response param iss" — which tells
     a reader nothing about which of the settings' two URL boxes they filled
     in. Both take a URL and one of them is the address you land on. */
  const saved = (redirectUri) =>
    validateConfig({ integrations: { calendar: { redirectUri } } }).value.integrations.calendar.redirectUri;

  const LOOPBACK = 'http://127.0.0.1:33333/';

  it('keeps an address that is one', () => {
    assert.equal(saved('https://glassboard.example.com/api/m/calendar/oauth/callback'),
      'https://glassboard.example.com/api/m/calendar/oauth/callback');
    assert.equal(saved(LOOPBACK), LOOPBACK);
  });

  it('keeps only the redirect URI out of the address Google sent you back to', () => {
    assert.equal(
      saved('http://127.0.0.1:33333/?state=AbC&code=4%2F0AX&scope=x&iss=https%3A%2F%2Faccounts.google.com'),
      LOOPBACK
    );
    assert.equal(
      saved('https://glassboard.example.com/api/m/calendar/oauth/callback?code=4%2F0AX#done'),
      'https://glassboard.example.com/api/m/calendar/oauth/callback'
    );
  });

  it('falls back to the loopback rather than leave a sign-in impossible to start', () => {
    for (const unusable of ['', '   ', 'not a url', 'javascript:alert(1)', 'ftp://example.com/']) {
      assert.equal(saved(unusable), LOOPBACK, JSON.stringify(unusable));
    }
  });

  it('repairs a configuration that was saved before any of this', () => {
    /* getConfig validates on every read, so an instance that stored the
       landed address comes back usable without anybody editing anything. */
    const stored = { integrations: { calendar: { redirectUri: `${LOOPBACK}?code=4%2F0AX&state=z` } } };
    assert.equal(saved(stored.integrations.calendar.redirectUri), LOOPBACK);
  });
});

describe('the callback address the settings offer', () => {
  /* Google takes no http callback outside localhost. A dashboard behind a
     reverse proxy that does not pass X-Forwarded-Proto looks, from inside, as
     though it were reached over plain http — and offering an address that
     cannot work is worse than offering none. */
  it('is https on a real hostname, whatever the request arrived as', () => {
    assert.equal(callbackUri('dashboard.example.com', 'http'),
      'https://dashboard.example.com/api/m/calendar/oauth/callback');
    assert.equal(callbackUri('dashboard.example.com', 'https'),
      'https://dashboard.example.com/api/m/calendar/oauth/callback');
  });

  it('is https on an IP address too, which Google refuses for another reason', () => {
    // Refused as a raw IP host, not for its scheme — but never offered as http.
    assert.equal(callbackUri('192.168.1.50', 'http'),
      'https://192.168.1.50/api/m/calendar/oauth/callback');
  });

  it('leaves localhost alone, where http is the one that works', () => {
    assert.equal(callbackUri('127.0.0.1:3000', 'http'),
      'http://127.0.0.1:3000/api/m/calendar/oauth/callback');
    assert.equal(callbackUri('localhost:3000', 'http'),
      'http://localhost:3000/api/m/calendar/oauth/callback');
  });
});

describe('the OAuth client', () => {
  it('is nothing until both halves are given', () => {
    assert.equal(google.client(USER), null);
    assert.equal(google.credentialStatus(USER).configured, false);
    assert.throws(() => google.setClient(USER, CLIENT_ID, ''), /client secret/i);
  });

  it('says so when the client ID is plainly not one', () => {
    /* Caught here rather than discovered as an opaque "invalid_client" from
       Google three clicks later. */
    assert.throws(() => google.setClient(USER, 'my-client', 'secret'), /googleusercontent/);
  });

  it('is stored encrypted, never in the clear', () => {
    google.setClient(USER, CLIENT_ID, 'the-secret');
    const stored = getSecret(USER, 'google.clientSecret');
    assert.ok(stored.startsWith('v1:'), 'the secret is a sealed box');
    assert.ok(!stored.includes('the-secret'));
    assert.equal(google.client(USER).secret, 'the-secret');
  });

  it('belongs to one account and is invisible to the next', () => {
    assert.equal(google.client(OTHER), null);
    assert.equal(google.credentialStatus(OTHER).configured, false);
  });

  it('reports what it has without handing the secret back', () => {
    const status = google.credentialStatus(USER);
    assert.equal(status.configured, true);
    assert.equal(status.connected, false);
    assert.equal(status.clientId, CLIENT_ID);
    assert.equal(JSON.stringify(status).includes('the-secret'), false);
  });
});

describe('starting a sign-in', () => {
  it('refuses before there is a client to authorise against', () => {
    assert.throws(() => google.startAuth(OTHER, google.LOOPBACK_REDIRECT), /client ID/);
  });

  it('asks Google for a refresh token and for PKCE', () => {
    const { url } = google.startAuth(USER, google.LOOPBACK_REDIRECT);
    const query = new URL(url).searchParams;
    assert.equal(query.get('client_id'), CLIENT_ID);
    assert.equal(query.get('redirect_uri'), google.LOOPBACK_REDIRECT);
    assert.equal(query.get('response_type'), 'code');
    assert.equal(query.get('code_challenge_method'), 'S256');
    assert.ok(query.get('code_challenge'));
    /* Without both of these Google hands back no refresh token on a second
       authorisation, and the dashboard would work until its first restart. */
    assert.equal(query.get('access_type'), 'offline');
    assert.equal(query.get('prompt'), 'consent');
    assert.ok(query.get('scope').includes('auth/calendar'));
  });

  it('never puts the client secret in the address the browser opens', () => {
    const { url } = google.startAuth(USER, google.LOOPBACK_REDIRECT);
    assert.equal(url.includes('the-secret'), false);
  });

  it('gives each sign-in a state of its own', () => {
    const first = google.startAuth(USER, google.LOOPBACK_REDIRECT).state;
    const second = google.startAuth(USER, google.LOOPBACK_REDIRECT).state;
    assert.notEqual(first, second);
    assert.ok(first.length >= 24);
  });
});

describe('finishing a sign-in', () => {
  it('refuses a state nobody started', async () => {
    await assert.rejects(
      google.completeAuth({ code: 'x', state: 'made-up', expectedUserId: USER }),
      /Start it again/
    );
  });

  it('refuses a code pasted by another account', async () => {
    /* The state is what ties a callback back to the account that asked for
       it. Without this check, a code is an unauthenticated request carrying a
       grant, and the one question it has to answer is whose grant it is. */
    const { state } = google.startAuth(USER, google.LOOPBACK_REDIRECT);
    await assert.rejects(
      google.completeAuth({ code: 'x', state, expectedUserId: OTHER }),
      /another account/
    );
  });

  it('spends a state once, whatever the outcome', async () => {
    const { state } = google.startAuth(USER, google.LOOPBACK_REDIRECT);
    await assert.rejects(google.completeAuth({ code: 'x', state, expectedUserId: OTHER }), /another account/);
    // The second attempt no longer finds it: an authorization code is good
    // once, and a state left behind is a replay somebody could try.
    await assert.rejects(google.completeAuth({ code: 'x', state, expectedUserId: USER }), /Start it again/);
  });

  it('reads the code out of whatever address was pasted', async () => {
    const { state } = google.startAuth(USER, google.LOOPBACK_REDIRECT);
    /* It gets as far as asking Google and fails there, which is the point:
       the parse found a code and a state, so the complaint is no longer about
       the paste. */
    await assert.rejects(
      google.completeFromPaste(USER, `http://127.0.0.1:33333/?state=${state}&code=4/abc-def&scope=x`),
      (error) => !/authorization code|carries no state|Start it again/.test(error.message)
    );
  });

  it('says what is missing rather than failing obscurely', async () => {
    await assert.rejects(google.completeFromPaste(USER, ''), /Paste the address/);
    await assert.rejects(google.completeFromPaste(USER, 'http://127.0.0.1:33333/'), /no authorization code/);
    await assert.rejects(google.completeFromPaste(USER, 'http://127.0.0.1:33333/?code=abc'), /no state/);
    await assert.rejects(
      google.completeFromPaste(USER, 'http://127.0.0.1:33333/?error=access_denied'),
      /refused the sign-in/
    );
  });
});

describe('disconnecting', () => {
  it('forgets the client and the grant together', () => {
    google.setClient(USER, CLIENT_ID, 'the-secret');
    google.forget(USER);
    assert.equal(google.client(USER), null);
    assert.equal(getSecret(USER, 'google.clientSecret'), null);
    assert.equal(google.isConnected(USER), false);
  });
});

describe('the module', () => {
  it('draws no tile and says it draws part of the page instead', () => {
    assert.deepEqual(manifest.tiles, {});
    assert.equal(manifest.chrome, true);
  });

  it('is off on a dashboard that has never heard of it', () => {
    const { value } = validateConfig({});
    assert.equal(value.modules.calendar.enabled, false);
  });

  it('starts with a loopback redirect, because Google refuses an IP address', () => {
    const { value } = validateConfig({});
    assert.equal(value.integrations.calendar.redirectUri, 'http://127.0.0.1:33333/');
  });

  it('keeps a calendar a reader has chosen, and drops one with no id', () => {
    const { value, errors } = validateConfig({
      integrations: {
        calendar: {
          calendars: [
            { id: 'work@example.com', name: 'Work', colour: '#FF7A18', shown: false },
            { name: 'nameless' },
          ],
          upcomingCount: 4,
          weekStartsMonday: false,
        },
      },
    });
    // A document with no tiles and no links is complained about; the block
    // under test is not.
    assert.deepEqual(errors.filter((line) => line.startsWith('integrations.calendar')), []);
    const calendars = value.integrations.calendar.calendars;
    assert.equal(calendars.length, 1);
    assert.deepEqual(calendars[0], {
      id: 'work@example.com', name: 'Work', colour: '#ff7a18'.toLowerCase(), shown: false,
    });
    assert.equal(value.integrations.calendar.upcomingCount, 4);
    assert.equal(value.integrations.calendar.weekStartsMonday, false);
  });

  it('holds a reader to a list it can draw', () => {
    const { value } = validateConfig({
      integrations: { calendar: { calendars: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}` })) } },
    });
    assert.equal(value.integrations.calendar.calendars.length, 12);
  });

  it('leaves no credential in the configuration document', () => {
    /* The client id and secret live in the secrets table, encrypted. An
       exported configuration is a file people mail each other. */
    const { value } = validateConfig({
      integrations: { calendar: { clientId: CLIENT_ID, clientSecret: 'nope' } },
    });
    const written = JSON.stringify(value.integrations.calendar);
    assert.equal(written.includes(CLIENT_ID), false);
    assert.equal(written.includes('nope'), false);
  });
});
