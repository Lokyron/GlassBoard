/* The calendar worker.
 *
 * Everything about this module that costs anything runs here: the fetch of
 * each feed, and the parse. A year of a busy calendar is a few megabytes of
 * text, and expanding a weekly repeat across it is real work — on the main
 * thread that is every other request on the instance held up, which is what
 * modules/README.md exists to prevent.
 *
 * It opens its own database connection, which is safe: the file is in WAL
 * mode, where a writer does not block readers. */
import { serve } from '../../server/modules/worker-host.js';
import { cacheSet } from '../../server/db.js';
import * as ical from '../../server/integrations/ical.js';
import { boundsOf } from './months.js';

/** One month, fetched and parsed from every feed, filed under its own key. */
async function month({ userId, month: label, feeds, ttlSeconds }) {
  const { timeMin, timeMax } = boundsOf(label);

  /* The feeds in parallel: they are separate servers and do not depend on
     each other, and a slow one should not add its seconds to the others. */
  const lists = await Promise.all(
    feeds.map(async (feed) => {
      const url = ical.getFeedUrl(userId, feed.id);
      if (!url) return { events: [], error: 'no address' };
      try {
        const text = await ical.fetchFeed(url);
        return { events: ical.eventsInWindow(text, feed, { timeMin, timeMax }), error: '' };
      } catch (error) {
        /* One unreachable calendar must not empty the month. The others are
           drawn and the failure is reported beside them. */
        console.warn(`[glassboard] calendar "${feed.name}" did not answer: ${error.message}`);
        return { events: [], error: error.message };
      }
    })
  );

  const payload = {
    events: lists.flatMap((l) => l.events).sort((a, b) => String(a.start).localeCompare(String(b.start))),
    calendars: feeds.map((feed, i) => ({ ...feed, error: lists[i].error })),
    fetchedAt: new Date().toISOString(),
  };

  /* Kept well past the refresh interval on purpose. The entry is replaced by
     every sync, so its lifetime is not how fresh the card is — it is how long
     a month stays readable while a calendar is unreachable, and a month from
     this morning beats an empty grid. */
  cacheSet(ical.windowKey(userId, timeMin, timeMax), payload, Math.max(3600, ttlSeconds * 8));
  return payload;
}

serve({
  month,

  /** Several months in one task, so the job is one message and not four. */
  async months({ userId, months, feeds, ttlSeconds }) {
    const done = [];
    for (const label of months) {
      await month({ userId, month: label, feeds, ttlSeconds });
      done.push(label);
    }
    return { months: done };
  },

  /** The pane's "check this address": fetch it once and say what it is. */
  async probe({ url }) {
    const text = await ical.fetchFeed(url);
    const found = ical.eventsInWindow(
      text,
      { id: 'probe', name: '', colour: '#0a84ff' },
      {
        timeMin: new Date(Date.now() - 86_400_000 * 30).toISOString(),
        timeMax: new Date(Date.now() + 86_400_000 * 90).toISOString(),
      }
    );
    return { name: ical.feedName(text), events: found.length };
  },
});
