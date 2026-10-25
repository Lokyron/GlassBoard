/* The calendar worker.
 *
 * Everything that talks to Google runs here: the sign-in exchange, the month
 * fetches, the writes. Not because a month of events is heavy — it is not,
 * next to a month of GPS positions — but because it is a round trip to a
 * third party, and modules/README.md is clear that a request handler must not
 * wait on one. Four calendars that each take a second would otherwise be four
 * seconds in which this instance answers nobody.
 *
 * It opens its own database connection, which is safe: the file is in WAL
 * mode, where a writer does not block readers. */
import { serve } from '../../server/modules/worker-host.js';
import { cacheSet } from '../../server/db.js';
import * as google from '../../server/integrations/google-calendar.js';
import { boundsOf } from './months.js';

/** A month, fetched and filed under its own key. */
async function month({ userId, month: label, calendarIds, ttlSeconds }) {
  const { timeMin, timeMax } = boundsOf(label);
  const payload = await google.fetchWindow(userId, { calendarIds, timeMin, timeMax });
  /* Kept well past the refresh interval on purpose. The entry is replaced by
     every sync, so its lifetime is not how fresh the card is — it is how long
     a month stays readable while Google is unreachable, and a calendar from
     this morning beats an empty grid. */
  cacheSet(google.windowKey(userId, timeMin, timeMax), payload, Math.max(3600, ttlSeconds * 8));
  cacheSet(google.calendarsKey(userId), payload.calendars, 86_400);
  return payload;
}

serve({
  month,

  /** Several months in one task, so the job is one message and not four. */
  async months({ userId, months, calendarIds, ttlSeconds }) {
    const done = [];
    for (const label of months) {
      // In series: the same account's four months down one connection, rather
      // than four bursts at Google's rate limiter.
      await month({ userId, month: label, calendarIds, ttlSeconds });
      done.push(label);
    }
    return { months: done };
  },

  async calendars({ userId }) {
    const calendars = await google.listCalendars(userId);
    cacheSet(google.calendarsKey(userId), calendars, 86_400);
    return { calendars };
  },

  exchange: ({ userId, code, state }) =>
    google.completeAuth({ code, state, expectedUserId: userId ?? null }),

  paste: ({ userId, pasted }) => google.completeFromPaste(userId, pasted),

  disconnect: async ({ userId }) => {
    await google.disconnect(userId);
    return { ok: true };
  },

  /* The three writes. Each drops the cached months afterwards: the next read
     has to see what was just done, and working out which months an event
     touched is more code than fetching them again. */
  create: async ({ userId, calendarId, draft }) => {
    const id = await google.createEvent(userId, calendarId, draft);
    google.invalidate(userId);
    return { id };
  },

  update: async ({ userId, calendarId, eventId, draft }) => {
    await google.updateEvent(userId, calendarId, eventId, draft);
    google.invalidate(userId);
    return { ok: true };
  },

  remove: async ({ userId, calendarId, eventId }) => {
    await google.deleteEvent(userId, calendarId, eventId);
    google.invalidate(userId);
    return { ok: true };
  },
});
