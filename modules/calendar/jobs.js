/* Keeping the months on disk warm.
 *
 * The point of the job is that opening the dashboard is a read. By the time
 * anybody looks at the card, this month and its neighbours are already there
 * and the route touches nothing but SQLite — which is what the card feeling
 * instant is made of, and the reason a calendar server having a slow morning
 * is not a slow dashboard.
 *
 * Only accounts with the module switched on and at least one feed shown are
 * asked about. The per-account interval is honoured through a marker the sync
 * writes, so the job's own beat is not what decides how often somebody else's
 * server is called. */
import { db, cacheGet, cacheSet } from '../../server/db.js';
import { getConfig } from '../../server/store.js';
import { isModuleEnabled } from '../../server/modules/registry.js';
import { runInWorker } from '../../server/modules/workers.js';
import { syncKey } from '../../server/integrations/ical.js';
import { warmMonths } from './months.js';

const dueKey = (userId) => `cal:${userId}:synced`;

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
    if (!isModuleEnabled(config, 'calendar') || !settings) continue;
    const feeds = settings.feeds.filter((feed) => feed.shown);
    if (!feeds.length) continue;
    // Still inside this account's refresh interval: nothing to do, and
    // nobody's server called to decide that.
    if (cacheGet(dueKey(account.id))) continue;

    /* The marker goes down before the work, not after. A sync that fails must
       not become a sync attempted every minute for as long as a calendar is
       unhappy; the cached months stay readable in the meantime. */
    cacheSet(dueKey(account.id), true, Math.max(60, settings.refreshMinutes * 60));
    try {
      await runInWorker(
        'calendar',
        { task: 'months', userId: account.id, months: warmMonths(), feeds, ttlSeconds: settings.refreshMinutes * 60 },
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
    everyMinutes: 1,
    run: syncEveryAccount,
  },
];
