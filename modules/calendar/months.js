/* Which months the dashboard keeps warm, and what a month is as far as a
 * fetch is concerned.
 *
 * A month and not a sliding window, because paging is how a calendar is read:
 * file the answer under the month and moving back and forth through last
 * spring costs one call per month instead of one per click.
 *
 * The bounds are a day wider on each side. The server does not know the
 * reader's timezone — the browser places each event into a day itself — and
 * without the slack an event at nine in the evening on the last of the month
 * is outside the window for anyone far enough east.
 *
 * Shared by the job, the routes and the worker, which is why it sits beside
 * them rather than inside one of them. */

const DAY_MS = 86_400_000;

/** "2026-10" for a date, in UTC: a month label, not a local day. */
export const monthOf = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

/** A month label shifted by whole months, the year carried for us by Date. */
export function shiftMonth(month, by) {
  const [year, index] = month.split('-').map(Number);
  return monthOf(new Date(Date.UTC(year, index - 1 + by, 1)));
}

/** The RFC 3339 instants a month is asked for between. */
export function boundsOf(month) {
  const [year, index] = month.split('-').map(Number);
  const first = Date.UTC(year, index - 1, 1);
  const next = Date.UTC(year, index, 1);
  return {
    timeMin: new Date(first - DAY_MS).toISOString(),
    timeMax: new Date(next + DAY_MS).toISOString(),
  };
}

/** A month label the routes will accept, or null. */
export function validMonth(value) {
  const text = String(value ?? '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) return null;
  const year = Number(text.slice(0, 4));
  // A calendar nobody will ever page to is a cache entry nobody will ever
  // read, and an open invitation to fill the table a month at a time.
  return year >= 1970 && year <= 2200 ? text : null;
}

/**
 * The months worth having on disk: the one before, this one, and the two
 * after. That is what the card, the panel on opening and the upcoming list
 * all read, so in normal use nothing is ever fetched while somebody waits.
 */
export const warmMonths = (now = new Date()) => {
  const here = monthOf(now);
  return [-1, 0, 1, 2].map((by) => shiftMonth(here, by));
};
