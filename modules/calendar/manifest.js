/* Calendar — a month you can read at a glance and page through, the events
   coming up, and a Google account behind it.
 *
 * The first module that draws no tile. Its place on the dashboard is the
 * sidebar card that used to show nothing but how far through the year we are:
 * a date on its own answers "what is today", and never "what is today for".
 * The year is still there, as the thin bar along the bottom of the card.
 *
 * `chrome: true` is what says so. A module with tiles is fetched by the
 * browser when the dashboard has one of them; this one is fetched whenever it
 * is switched on, because its card is not in the grid. */
export const MAX_CALENDARS = 12;

/* The loopback redirect, which is also what anything unusable falls back to.
   Kept here rather than imported from the integration: the manifest is the
   one file the configuration schema loads, and it must not drag the Google
   client in behind it. */
const LOOPBACK = 'http://127.0.0.1:33333/';

/**
 * A redirect URI, kept to what a redirect URI can be.
 *
 * It is an address Google sends somebody back to and nothing else: no query,
 * no fragment, because Google puts its own parameters there. The obvious
 * mistake is to paste the address you *landed on* into this field — it is a
 * URL, it is almost the right one, and it is covered in response parameters.
 * So rather than store it and fail later, the part that was the redirect URI
 * is kept and what Google added is dropped, which yields exactly the right
 * value.
 *
 * This matters because the failure it prevents happens at Google, four
 * clicks away, as "Invalid redirect_uri contains reserved response param
 * iss" — which tells a reader nothing about which of two boxes they filled
 * in. An address that is not an http(s) URL at all falls back to the
 * loopback, so a dashboard can never be left unable to start a sign-in.
 */
function redirectUri(v, raw, path) {
  const text = v.str(raw, path, { max: 400, fallback: '' }).trim();
  if (!text) return LOOPBACK;
  let url;
  try {
    url = new URL(text);
  } catch {
    return LOOPBACK;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return LOOPBACK;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export default {
  id: 'calendar',
  label: 'Calendar',
  labelKey: 'set.calendar',
  defaultEnabled: false,
  server: () => import('./server.js'),
  jobs: () => import('./jobs.js'),
  hasPane: true,
  hasWorker: true,
  /* It contributes to the page around the tiles rather than a tile of its
     own. The core knows the word, not the feature. */
  chrome: true,

  tiles: {},

  settings: (v, raw, path) => ({
    /* Where Google sends the reader back. Not derived from the request:
       Google refuses a raw IP address as a redirect URI and demands HTTPS
       outside localhost, so an instance reached at an address like
       https://192.168.1.50 cannot receive the redirect and uses the loopback
       one with a paste instead. server/integrations/google-calendar.js has
       the whole story. */
    redirectUri: redirectUri(v, raw.redirectUri, `${path}.redirectUri`),

    /* The calendars the dashboard draws, as the pane last read them from
       Google. Their names and colours are kept so the card can be drawn
       before the first sync of the session answers. */
    calendars: Array.isArray(raw.calendars)
      ? raw.calendars.slice(0, MAX_CALENDARS).map((calendar, i) => ({
        id: v.str(calendar?.id, `${path}.calendars[${i}].id`, { max: 320, fallback: '' }),
        name: v.str(calendar?.name, `${path}.calendars[${i}].name`, { max: 120, fallback: '' }),
        colour: v.color(calendar?.colour, `${path}.calendars[${i}].colour`),
        shown: v.bool(calendar?.shown, true),
      })).filter((calendar) => calendar.id)
      : [],

    /* Where a new event goes when the editor is opened from a day rather than
       from an existing event. Empty means the primary calendar. */
    defaultCalendarId: v.str(raw.defaultCalendarId, `${path}.defaultCalendarId`, { max: 320, fallback: '' }),

    /* Monday or Sunday. There is no third answer in any locale Glassboard
       speaks, so this is a flag and not a day number. */
    weekStartsMonday: v.bool(raw.weekStartsMonday, true),

    /* How many of the next events the card and the panel list. Past a dozen
       it is not "what is coming up", it is the calendar again. */
    upcomingCount: v.num(raw.upcomingCount, `${path}.upcomingCount`, { min: 1, max: 12, fallback: 5 }),

    /* The year bar at the foot of the card: the one thing the card it
       replaced was for, kept for whoever wants it. */
    showYearProgress: v.bool(raw.showYearProgress, true),

    refreshMinutes: v.num(raw.refreshMinutes, `${path}.refreshMinutes`, { min: 1, max: 720, fallback: 15 }),
  }),
};
