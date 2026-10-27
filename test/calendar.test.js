/* The calendar module.
 *
 * Nothing here opens a socket. What is worth checking without somebody else's
 * calendar server is the part that is ours: which months the dashboard keeps
 * warm and what a month is as far as a fetch is concerned, that a
 * subscription address is treated as the credential it is, and — the reason
 * this module carries a parsing library at all — that a feed's repeating
 * events are expanded into the occurrences a grid has to draw.
 *
 * The fixture below is the shape a real Google feed has: a VTIMEZONE, a
 * weekly series, an EXDATE that cancels one week, an occurrence moved to
 * another hour under a RECURRENCE-ID, an all-day span, and an event crossing
 * midnight. Every one of those is a thing a hand-written parser gets wrong in
 * silence, and this is where that would be caught. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('calendar');
const ical = await import('../server/integrations/ical.js');
const months = await import('../modules/calendar/months.js');
const manifest = (await import('../modules/calendar/manifest.js')).default;
const { validateConfig } = await import('../server/config-schema.js');
const { db, now, getSecret } = await import('../server/db.js');

const makeUser = (name) => db
  .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) RETURNING id')
  .get(name, 'x', now()).id;

const USER = makeUser('tester');
const OTHER = makeUser('somebody-else');

const FEED = { id: 'cal-one', name: 'Agenda de test', colour: '#0a84ff' };

const SAMPLE = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'X-WR-CALNAME:Agenda de test',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Paris',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
  // A weekly class, with one week cancelled.
  'BEGIN:VEVENT',
  'DTSTART;TZID=Europe/Paris:20261013T190000',
  'DTEND;TZID=Europe/Paris:20261013T203000',
  'RRULE:FREQ=WEEKLY;BYDAY=TU',
  'EXDATE;TZID=Europe/Paris:20261103T190000',
  'UID:cours@test', 'SUMMARY:Cours parkour', 'LOCATION:Gymnase',
  'END:VEVENT',
  // One occurrence of it, moved and renamed.
  'BEGIN:VEVENT',
  'DTSTART;TZID=Europe/Paris:20261110T200000',
  'DTEND;TZID=Europe/Paris:20261110T213000',
  'RECURRENCE-ID;TZID=Europe/Paris:20261110T190000',
  'UID:cours@test', 'SUMMARY:Cours decale',
  'END:VEVENT',
  // An all-day span of two days.
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261103',
  'UID:weekend@test', 'SUMMARY:Week-end',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const WINDOW = { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-12-01T00:00:00Z' };
const parsed = () => ical.eventsInWindow(SAMPLE, FEED, WINDOW);

describe('reading a feed', () => {
  it('gives the calendar its own name when it states one', () => {
    assert.equal(ical.feedName(SAMPLE), 'Agenda de test');
    assert.equal(ical.feedName('not a calendar at all'), '');
  });

  it('expands a weekly series into its occurrences', () => {
    const days = parsed().filter((e) => e.title === 'Cours parkour').map((e) => e.start.slice(0, 10));
    assert.ok(days.includes('2026-10-13'), 'the first one');
    assert.ok(days.includes('2026-10-20'));
    assert.ok(days.length >= 5, `expanded, got ${days.length}`);
  });

  it('honours an EXDATE, so a cancelled week is really gone', () => {
    const onThatDay = parsed().filter((e) => e.start.startsWith('2026-11-03'));
    assert.deepEqual(onThatDay, [], 'the 3rd of November was cancelled');
  });

  it('shows an occurrence that was moved, once, where it was moved to', () => {
    const tenth = parsed().filter((e) => e.start.startsWith('2026-11-10'));
    assert.equal(tenth.length, 1, 'not both the old slot and the new one');
    assert.equal(tenth[0].title, 'Cours decale');
    // 20:00 in Paris in November is 19:00 UTC.
    assert.equal(tenth[0].start, '2026-11-10T19:00:00.000Z');
  });

  it('keeps an all-day event a day and not an instant', () => {
    const weekend = parsed().find((e) => e.title === 'Week-end');
    assert.equal(weekend.allDay, true);
    assert.equal(weekend.start, '2026-11-01');
    assert.equal(weekend.end, '2026-11-03');
  });

  it('carries the feed it came from, for the colour and the legend', () => {
    for (const event of parsed()) {
      assert.equal(event.calendarId, FEED.id);
      assert.equal(event.colour, FEED.colour);
    }
  });

  it('leaves out what the dashboard never shows', () => {
    /* An iCalendar file carries attendees, organisers and alarms. None of
       that is on screen, so none of it should be on the wire. */
    const written = JSON.stringify(parsed());
    for (const field of ['attendee', 'organizer', 'valarm']) {
      assert.equal(written.toLowerCase().includes(field), false, field);
    }
  });
});

describe('a subscription address', () => {
  it('is stored encrypted, and never in the configuration', () => {
    ical.setFeedUrl(USER, FEED.id, 'https://example.com/private-abc/basic.ics');
    const stored = getSecret(USER, `ical.url.${FEED.id}`);
    assert.ok(stored.startsWith('v1:'), 'a sealed box');
    assert.ok(!stored.includes('private-abc'));
    assert.equal(ical.getFeedUrl(USER, FEED.id), 'https://example.com/private-abc/basic.ics');
  });

  it('belongs to one account and is invisible to the next', () => {
    assert.equal(ical.getFeedUrl(OTHER, FEED.id), null);
  });

  it('takes webcal:, which is what calendar apps hand out', () => {
    assert.equal(ical.normaliseUrl('webcal://example.com/x.ics'), 'https://example.com/x.ics');
  });

  it('refuses anything that is not a calendar address', () => {
    assert.throws(() => ical.normaliseUrl(''), /required/);
    assert.throws(() => ical.normaliseUrl('not a url'), /valid address/);
    assert.throws(() => ical.normaliseUrl('javascript:alert(1)'), /https/);
    assert.throws(() => ical.normaliseUrl('file:///etc/passwd'), /https/);
  });

  it('is forgotten on request', () => {
    ical.forgetFeed(USER, FEED.id);
    assert.equal(ical.getFeedUrl(USER, FEED.id), null);
  });
});

describe('the months the dashboard keeps warm', () => {
  it('is the month before, this one and the two after', () => {
    assert.deepEqual(months.warmMonths(new Date('2026-10-25T12:00:00Z')), ['2026-09', '2026-10', '2026-11', '2026-12']);
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
    for (const bad of ['2026-13', '2026-00', '206-10', '../../etc/passwd', '9999-01']) {
      assert.equal(months.validMonth(bad), null, bad);
    }
  });
});

describe('the module', () => {
  it('draws no tile and says it draws part of the page instead', () => {
    assert.deepEqual(manifest.tiles, {});
    assert.equal(manifest.chrome, true);
  });

  it('is off on a dashboard that has never heard of it', () => {
    assert.equal(validateConfig({}).value.modules.calendar.enabled, false);
  });

  it('keeps a feed a reader has set up, without its address', () => {
    const { value } = validateConfig({
      integrations: {
        calendar: {
          feeds: [{ id: 'cal-work', name: 'Work', colour: '#FF7A18', shown: false,
            url: 'https://example.com/secret.ics' }],
          upcomingCount: 4, weekStartsMonday: false,
        },
      },
    });
    const feeds = value.integrations.calendar.feeds;
    assert.deepEqual(feeds, [{ id: 'cal-work', name: 'Work', colour: '#ff7a18', shown: false }]);
    /* The address is the credential. An exported configuration is a file
       people mail each other, so it must not be able to carry one. */
    assert.equal(JSON.stringify(feeds).includes('secret.ics'), false);
    assert.equal(value.integrations.calendar.upcomingCount, 4);
    assert.equal(value.integrations.calendar.weekStartsMonday, false);
  });

  it('holds a reader to a list the card can keep legible', () => {
    const { value } = validateConfig({
      integrations: { calendar: { feeds: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}` })) } },
    });
    assert.equal(value.integrations.calendar.feeds.length, 8);
  });
});
