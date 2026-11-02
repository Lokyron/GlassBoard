/* Keeping the rides up to date without anybody asking.
 *
 * The tile used to be what triggered a sync, which meant the first page load
 * after a ride paid for it. The job does it on its own clock instead, so by
 * the time anyone opens the dashboard the month is already there and the
 * route is a pure read.
 *
 * Only accounts that have the integration switched on and a tracker chosen
 * are asked about, and the sync itself is deduplicated by the worker pool —
 * a job firing while a reader already triggered one joins it rather than
 * starting a second. */
import { db } from '../../server/db.js';
import { getConfig } from '../../server/store.js';
import { isModuleEnabled } from '../../server/modules/registry.js';
import { runInWorker } from '../../server/modules/workers.js';
import { syncKey, isSyncDue, isConfigured } from '../../server/integrations/georide.js';

async function syncEveryAccount() {
  const accounts = db.prepare('SELECT id FROM users ORDER BY id').all();
  for (const account of accounts) {
    let config;
    try {
      config = getConfig(account.id);
    } catch {
      continue;
    }
    const settings = config.integrations.georide;
    if (!isModuleEnabled(config, 'georide') || !settings?.trackerId || !isConfigured(account.id)) continue;
    // The account's own refreshMinutes, honoured through the marker the
    // worker writes: due or not is not this job's clock to decide.
    if (!isSyncDue(account.id, settings.trackerId)) continue;
    try {
      await runInWorker(
        'georide',
        { task: 'sync', userId: account.id, trackerId: settings.trackerId },
        syncKey(account.id, settings.trackerId)
      );
    } catch (error) {
      // One account's tracker being unreachable stops nothing for the others.
      console.warn(`[glassboard] georide sync failed for user ${account.id}: ${error.message}`);
    }
  }
}

export default [
  {
    name: 'sync rides',
    // The shortest refresh the settings allow is a minute; the job runs on
    // that beat and the per-account interval is honoured by the cache entry
    // the sync writes, so an account set to thirty minutes is asked about
    // once every thirty.
    everyMinutes: 1,
    run: syncEveryAccount,
  },
];
