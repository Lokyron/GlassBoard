/* Keeping the months on disk warm.
 *
 * The point of the job is that opening the dashboard is a read. By the time
 * anybody looks at the card, this month and its neighbours are already there
 * and the route touches nothing but SQLite — which is what the card feeling
 * instant is made of, and the reason a slow morning at Google is not a slow
 * dashboard.
 *
 * Only accounts with the module switched on and a Google grant are asked
 * about. The per-account interval is honoured through a marker the sync
 * writes, so the job's own beat is not what decides how often Google is
 * called. */
import { db, cacheGet, cacheSet } from '../../server/db.js';
import { getConfig } from '../../server/store.js';
import { isModuleEnabled } from '../../server/modules/registry.js';
import { runInWorker } from '../../server/modules/workers.js';
import { isConnected, syncKey } from '../../server/integrations/google-calendar.js';
import { warmMonths } from './months.js';

const dueKey = (userId) => `gcal:${userId}:synced`;

async function syncEveryAccount() {
  const accounts = db.prepare('SELECT id FROM users ORDER BY id').all();
  for (const account of accounts) {
    let config;
    try {
      config = getConfig(account.id);
    } catch {
      continue;
    }
    const settings = config.integrations.calendar;
    if (!isModuleEnabled(config, 'calendar') || !settings || !isConnected(account.id)) continue;
    // Still inside this account's refresh interval: nothing to do, and no
    // call to Google to decide that.
    if (cacheGet(dueKey(account.id))) continue;

    const shown = settings.calendars.filter((calendar) => calendar.shown).map((calendar) => calendar.id);
    /* The marker goes down before the work, not after. A sync that fails must
       not become a sync attempted every minute for as long as Google is
       unhappy; the cached months are still readable in the meantime. */
    cacheSet(dueKey(account.id), true, Math.max(60, settings.refreshMinutes * 60));
    try {
      await runInWorker(
        'calendar',
        {
          task: 'months',
          userId: account.id,
          months: warmMonths(),
          calendarIds: shown,
          ttlSeconds: settings.refreshMinutes * 60,
        },
        syncKey(account.id)
      );
    } catch (error) {
      // One account's calendar being unreachable stops nothing for the others.
      console.warn(`[glassboard] calendar sync failed for user ${account.id}: ${error.message}`);
    }
  }
}

export default [
  {
    name: 'warm the months',
    /* The shortest refresh the settings allow is a minute; the job runs on
       that beat and the per-account interval is honoured by the marker above,
       so an account set to an hour is asked about once an hour. */
    everyMinutes: 1,
    run: syncEveryAccount,
  },
];
