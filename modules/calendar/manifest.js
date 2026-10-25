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
    redirectUri: v.str(raw.redirectUri, `${path}.redirectUri`, { max: 400, fallback: 'http://127.0.0.1:33333/' }),

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
