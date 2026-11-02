/* Calendar — a month you can read at a glance and page through, the events
   coming up, and one or more subscription links behind it.
 *
 * The first module that draws no tile. Its place on the dashboard is the
 * sidebar card that used to show nothing but how far through the year we are:
 * a date on its own answers "what is today", and never "what is today for".
 * The year is still there, as the thin bar along the bottom of the card.
 *
 * `chrome: true` is what says so. A module with tiles is fetched by the
 * browser when the dashboard has one of them; this one is fetched whenever it
 * is switched on, because its card is not in the grid.
 *
 * Read-only, and that is a property of the protocol rather than an omission:
 * an iCalendar feed is a file you download. There is no route here that could
 * write to a calendar because there is nothing to write to. */
export const MAX_FEEDS = 8;

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
    /* The calendars this dashboard draws.
     *
     * Their addresses are NOT here: a subscription link is a credential — the
     * "secret address" of a Google calendar grants a read of it to anyone
     * holding it — so each one lives encrypted in the secrets table under its
     * feed id, and an exported configuration carries none of them. What is
     * here is what the dashboard needs to draw a legend: a name, a colour and
     * whether it is shown. */
    feeds: Array.isArray(raw.feeds)
      ? raw.feeds.slice(0, MAX_FEEDS).map((feed, i) => ({
        id: v.id(feed?.id, `${path}.feeds[${i}].id`, 'cal'),
        name: v.str(feed?.name, `${path}.feeds[${i}].name`, { max: 120, fallback: '' }),
        colour: v.color(feed?.colour, `${path}.feeds[${i}].colour`),
        shown: v.bool(feed?.shown, true),
      }))
      : [],

    /* Monday or Sunday. There is no third answer in any locale Glassboard
       speaks, so this is a flag and not a day number. */
    weekStartsMonday: v.bool(raw.weekStartsMonday, true),

    /* How many of the next events the card and the panel list. Past a dozen
       it is not "what is coming up", it is the calendar again. */
    upcomingCount: v.num(raw.upcomingCount, `${path}.upcomingCount`, { min: 1, max: 12, fallback: 5 }),

    /* The year bar at the foot of the card: the one thing the card it
       replaced was for, kept for whoever wants it. */
    showYearProgress: v.bool(raw.showYearProgress, true),

    /* A published calendar is not a live one — most providers regenerate the
       file every few minutes at best, so asking more often than that buys
       nothing and costs somebody else's bandwidth. */
    refreshMinutes: v.num(raw.refreshMinutes, `${path}.refreshMinutes`, { min: 5, max: 720, fallback: 30 }),
  }),
};
