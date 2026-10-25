/* Calendar routes, mounted by the registry at /api/m/calendar.
 *
 * Every one of these is a read off SQLite, or a message to the worker. None
 * of them waits on Google from the event loop — the rule the modules were
 * built for. The two that look like exceptions are the sign-in and the
 * writes: both are a reader's deliberate click, both go to the worker, and
 * neither happens while a dashboard is being drawn.
 *
 * Every handler takes req.user.id and never an id from the request: an
 * account reaches its own Google grant and has no way to name anyone
 * else's. */
import { cacheGet, cacheGetStale } from '../../server/db.js';
import { getConfig } from '../../server/store.js';
import { runInWorker } from '../../server/modules/workers.js';
import { escapeHtml } from '../../server/html.js';
import * as google from '../../server/integrations/google-calendar.js';
import { boundsOf, validMonth, warmMonths } from './months.js';

/* The settings of the account asking, with the calendars it has chosen
   reduced to the list the fetches take. */
const chosen = (settings) =>
  (settings?.calendars ?? []).filter((calendar) => calendar.shown).map((calendar) => calendar.id);

/** The redirect URI this instance uses, and which of the two flows it means.
 *
 *  "callback" when Google will send the reader back to this very dashboard —
 *  one click, nothing to copy. "paste" otherwise, which is the normal case on
 *  a homelab: Google refuses a raw IP address as a redirect URI, so the
 *  reader lands on a dead loopback page and pastes its address back. */
function flow(req, settings) {
  const redirectUri = settings.redirectUri || google.LOOPBACK_REDIRECT;
  const ours = `${req.protocol}://${req.get('host')}/api/m/calendar/oauth/callback`;
  return { redirectUri, ours, mode: redirectUri === ours ? 'callback' : 'paste' };
}

/* A page for a browser tab that is not the dashboard: the one Google sends
   back on the callback flow. Plain, self-contained and in no language in
   particular — it is on screen for as long as it takes to read one line. */
const closingPage = (title, detail, ok) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
 :root{color-scheme:light dark}
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f17;color:#f5f7fa;
      font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
 .box{max-width:30rem;padding:2rem;text-align:center}
 h1{font-size:1.4rem;margin:0 0 .5rem;color:${ok ? '#34c759' : '#ff453a'}}
 p{margin:0 0 1.5rem;color:#aeb6c2}
 a{color:#0a84ff}
</style></head>
<body><div class="box"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>
<a href="/">Back to the dashboard</a></div></body></html>`;

export function routes(router) {
  /* ------------------------------- status -------------------------------- */

  router.get('/status', (req, res) => {
    const settings = getConfig(req.user.id).integrations.calendar;
    const { redirectUri, ours, mode } = flow(req, settings);
    res.json({
      ok: true,
      ...google.credentialStatus(req.user.id),
      redirectUri,
      callbackUri: ours,
      loopbackUri: google.LOOPBACK_REDIRECT,
      mode,
      calendars: cacheGet(google.calendarsKey(req.user.id)) ?? [],
    });
  });

  /* ---------------------------- the OAuth client ------------------------- */

  router.put('/client', (req, res) => {
    try {
      google.setClient(req.user.id, req.body?.clientId, req.body?.clientSecret);
      res.json({ ok: true, ...google.credentialStatus(req.user.id) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.delete('/client', (req, res) => {
    google.forget(req.user.id);
    res.json({ ok: true, ...google.credentialStatus(req.user.id) });
  });

  /* ------------------------------- sign-in ------------------------------- */

  /* Building the authorisation URL is a hash and a database write, so it
     happens here. Everything after it — the exchange, the account lookup —
     is a round trip to Google and happens in the worker. */
  router.post('/connect', (req, res) => {
    const settings = getConfig(req.user.id).integrations.calendar;
    const { redirectUri, mode } = flow(req, settings);
    try {
      const { url } = google.startAuth(req.user.id, redirectUri);
      res.json({ ok: true, url, mode, redirectUri });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  /* Where Google sends the reader back on an instance that has a hostname it
     can reach. It arrives in the reader's own browser, so the session cookie
     comes with it and requireAuth has already had its say; the state is what
     ties the code to the account that asked for it. */
  router.get('/oauth/callback', async (req, res) => {
    const refused = req.query.error;
    if (refused) {
      return res.status(400).type('html').send(
        closingPage('Sign-in cancelled', `Google answered: ${refused}`, false)
      );
    }
    try {
      const { account } = await runInWorker('calendar', {
        task: 'exchange',
        userId: req.user.id,
        code: String(req.query.code ?? ''),
        state: String(req.query.state ?? ''),
      });
      res.type('html').send(
        closingPage('Calendar connected', account ? `Glassboard now reads ${account}.` : 'Glassboard can now read your calendar.', true)
      );
    } catch (error) {
      res.status(400).type('html').send(closingPage('Sign-in failed', error.message, false));
    }
  });

  /* The other half of the same sign-in, for an instance Google will not
     redirect to. The reader pastes the address of the page they landed on. */
  router.post('/connect/paste', async (req, res) => {
    try {
      const { account } = await runInWorker('calendar', {
        task: 'paste',
        userId: req.user.id,
        pasted: String(req.body?.pasted ?? ''),
      });
      res.json({ ok: true, account, ...google.credentialStatus(req.user.id) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/disconnect', async (req, res) => {
    try {
      await runInWorker('calendar', { task: 'disconnect', userId: req.user.id });
    } catch (error) {
      // The local token is gone either way; only the message to Google failed.
      console.warn(`[glassboard] calendar disconnect for user ${req.user.id}: ${error.message}`);
    }
    res.json({ ok: true, ...google.credentialStatus(req.user.id) });
  });

  /* ------------------------------ calendars ------------------------------ */

  /* The pane's "read my calendars again". A plain read otherwise, so opening
     the settings does not call Google. */
  router.get('/calendars', async (req, res) => {
    if (!google.isConnected(req.user.id)) return res.json({ ok: true, connected: false, calendars: [] });
    if (req.query.refresh !== '1') {
      return res.json({ ok: true, connected: true, calendars: cacheGet(google.calendarsKey(req.user.id)) ?? [] });
    }
    try {
      const { calendars } = await runInWorker(
        'calendar',
        { task: 'calendars', userId: req.user.id },
        `gcal-cals:${req.user.id}`
      );
      res.json({ ok: true, connected: true, calendars });
    } catch (error) {
      res.status(502).json({ error: error.message, code: error.code ?? null });
    }
  });

  /* -------------------------------- months ------------------------------- */

  /**
   * One month of events.
   *
   * Warm months are a read and nothing else. A month the reader has paged to
   * outside that window is fetched once, in the worker, and cached like the
   * others — so a wander through last year costs one call per month and no
   * more, however many times it is paged over.
   */
  router.get('/month/:month', async (req, res) => {
    const label = validMonth(req.params.month);
    if (!label) return res.status(400).json({ error: 'Not a month.' });

    const settings = getConfig(req.user.id).integrations.calendar;
    const { timeMin, timeMax } = boundsOf(label);
    const key = google.windowKey(req.user.id, timeMin, timeMax);

    const cached = cacheGet(key);
    if (cached) return res.json({ ok: true, connected: true, month: label, ...cached, stale: false });

    if (!google.isConnected(req.user.id)) {
      return res.json({ ok: true, connected: false, month: label, events: [], calendars: [] });
    }

    try {
      const payload = await runInWorker(
        'calendar',
        {
          task: 'month',
          userId: req.user.id,
          month: label,
          calendarIds: chosen(settings),
          ttlSeconds: settings.refreshMinutes * 60,
        },
        `gcal-month:${req.user.id}:${label}`
      );
      res.json({ ok: true, connected: true, month: label, ...payload, stale: false });
    } catch (error) {
      /* An expired entry beats an empty grid: a month fetched this morning is
         still very nearly this month, and the browser is told it is old. */
      const stale = cacheGetStale(key);
      if (stale) return res.json({ ok: true, connected: true, month: label, ...stale.value, stale: true });
      const status = error.code === 'not_connected' ? 409 : 502;
      res.status(status).json({ error: error.message, code: error.code ?? null });
    }
  });

  /** Which months the dashboard can expect to be instant, so the browser can
   *  ask for them without wondering. */
  router.get('/warm', (req, res) => res.json({ ok: true, months: warmMonths() }));

  /* -------------------------------- writing ------------------------------ */

  /* Validated here and not only in the browser: a route is reachable without
     one. The draft is four strings and a flag — everything else about a
     Google event is left alone by design, so an edit from the dashboard can
     never drop an attendee or a reminder it did not show. */
  function draftFrom(body) {
    const allDay = body?.allDay === true;
    const title = String(body?.title ?? '').trim();
    const start = String(body?.start ?? '').trim();
    const end = String(body?.end ?? '').trim();
    if (!title) throw new Error('An event needs a title.');
    if (!start || !end) throw new Error('An event needs a start and an end.');
    const shape = allDay ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
    if (!shape.test(start) || !shape.test(end)) throw new Error('That is not a date Google would take.');
    if (end < start) throw new Error('An event cannot end before it starts.');
    return {
      title,
      allDay,
      start,
      end,
      location: String(body?.location ?? '').trim(),
      description: String(body?.description ?? '').trim(),
      timeZone: String(body?.timeZone ?? '').trim(),
    };
  }

  const calendarFor = (req) => {
    const asked = String(req.body?.calendarId ?? '').trim();
    if (asked) return asked;
    const settings = getConfig(req.user.id).integrations.calendar;
    // "primary" is Google's own name for the account's main calendar, which
    // is the right default and needs no lookup to find.
    return settings.defaultCalendarId || 'primary';
  };

  router.post('/events', async (req, res) => {
    try {
      const draft = draftFrom(req.body);
      const { id } = await runInWorker('calendar', {
        task: 'create', userId: req.user.id, calendarId: calendarFor(req), draft,
      });
      res.json({ ok: true, id });
    } catch (error) {
      res.status(error.status === 403 ? 403 : 400).json({ error: error.message });
    }
  });

  router.patch('/events/:id', async (req, res) => {
    try {
      const draft = draftFrom(req.body);
      await runInWorker('calendar', {
        task: 'update', userId: req.user.id, calendarId: calendarFor(req), eventId: req.params.id, draft,
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(error.status === 403 ? 403 : 400).json({ error: error.message });
    }
  });

  router.delete('/events/:id', async (req, res) => {
    try {
      await runInWorker('calendar', {
        task: 'remove',
        userId: req.user.id,
        calendarId: String(req.query.calendarId ?? '').trim() || 'primary',
        eventId: req.params.id,
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(error.status === 403 ? 403 : 400).json({ error: error.message });
    }
  });
}
