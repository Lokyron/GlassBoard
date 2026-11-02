/* Calendar routes, mounted by the registry at /api/m/calendar.
 *
 * Every one of these is a read off SQLite, or a message to the worker. None
 * of them waits on somebody else's calendar server from the event loop — the
 * rule the modules were built for.
 *
 * There is no route here that writes to a calendar, because an iCalendar feed
 * is a file you download: the protocol has no way to. That is worth saying
 * out loud, because it is the thing a reader of this file will wonder about.
 *
 * Every handler takes req.user.id and never an id from the request: an
 * account reaches its own feeds and has no way to name anyone else's. */
import { cacheGet, cacheGetStale } from '../../server/db.js';
import { getConfig } from '../../server/store.js';
import { runInWorker } from '../../server/modules/workers.js';
import * as ical from '../../server/integrations/ical.js';
import { boundsOf, validMonth, warmMonths } from './months.js';

const shownFeeds = (settings) => (settings?.feeds ?? []).filter((feed) => feed.shown);

export function routes(router) {
  /* ------------------------------- status -------------------------------- */

  /** What the card and the settings need to know before anything is drawn.
   *  Addresses never come back — only whether each feed has one. */
  router.get('/status', (req, res) => {
    const settings = getConfig(req.user.id).integrations.calendar;
    const feeds = (settings?.feeds ?? []).map((feed) => ({
      id: feed.id,
      name: feed.name,
      colour: feed.colour,
      shown: feed.shown,
      hasUrl: Boolean(ical.getFeedUrl(req.user.id, feed.id)),
    }));
    res.json({
      ok: true,
      feeds,
      // "Configured" is the one question the card asks: is there anything to
      // draw at all.
      configured: feeds.some((feed) => feed.hasUrl),
    });
  });

  /* ------------------------------ the feeds ------------------------------ */

  /* An address is sent once and stored encrypted; it never comes back. The
     feed's id comes from the configuration the browser is about to save, so
     this is a write of a secret and not of the dashboard. */
  router.put('/feeds/:id/url', (req, res) => {
    try {
      ical.setFeedUrl(req.user.id, feedId(req.params.id), req.body?.url);
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.delete('/feeds/:id/url', (req, res) => {
    ical.forgetFeed(req.user.id, feedId(req.params.id));
    res.json({ ok: true });
  });

  /* "Check this address." It goes to the worker like every other fetch, and
     it is the only way somebody finds out they pasted the page they look at
     the calendar on rather than the .ics address. */
  router.post('/probe', async (req, res) => {
    try {
      const url = ical.normaliseUrl(req.body?.url);
      const result = await runInWorker('calendar', { task: 'probe', url });
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  /* -------------------------------- months ------------------------------- */

  /**
   * One month of events.
   *
   * Warm months are a read and nothing else. A month the reader has paged to
   * outside that window is fetched once, in the worker, and cached like the
   * others — so a wander through last year costs one fetch per month and no
   * more, however many times it is paged over.
   */
  router.get('/month/:month', async (req, res) => {
    const label = validMonth(req.params.month);
    if (!label) return res.status(400).json({ error: 'Not a month.' });

    const settings = getConfig(req.user.id).integrations.calendar;
    const { timeMin, timeMax } = boundsOf(label);
    const key = ical.windowKey(req.user.id, timeMin, timeMax);

    const cached = cacheGet(key);
    if (cached) return res.json({ ok: true, configured: true, month: label, ...cached, stale: false });

    const feeds = shownFeeds(settings).filter((feed) => ical.getFeedUrl(req.user.id, feed.id));
    if (!feeds.length) {
      return res.json({ ok: true, configured: false, month: label, events: [], calendars: [] });
    }

    try {
      const payload = await runInWorker(
        'calendar',
        { task: 'month', userId: req.user.id, month: label, feeds, ttlSeconds: settings.refreshMinutes * 60 },
        `cal-month:${req.user.id}:${label}`
      );
      res.json({ ok: true, configured: true, month: label, ...payload, stale: false });
    } catch (error) {
      /* An expired entry beats an empty grid: a month fetched this morning is
         still very nearly this month, and the browser is told it is old. */
      const stale = cacheGetStale(key);
      if (stale) return res.json({ ok: true, configured: true, month: label, ...stale.value, stale: true });
      res.status(502).json({ error: error.message });
    }
  });

  /** Which months the dashboard can expect to be instant, so the browser can
   *  ask for them without wondering. */
  router.get('/warm', (req, res) => res.json({ ok: true, months: warmMonths() }));
}

/* A feed id is the configuration's own id format, and it becomes part of a
   secret's name — so it is checked here rather than trusted. */
function feedId(raw) {
  const id = String(raw ?? '');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw Object.assign(new Error('Not a feed.'), { status: 400 });
  return id;
}
