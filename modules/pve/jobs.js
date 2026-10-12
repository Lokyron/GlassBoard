/* Keeping the hypervisor's snapshot warm without anybody asking.
 *
 * A card that is read every few minutes should not be the thing that pays for
 * the request. The job refreshes the snapshot on its own clock, so the route
 * is a read of the cache in the ordinary case.
 *
 * No worker: this is one small JSON answer, parsed in microseconds. The
 * contract's worker is for the modules that chew through a month of GPS
 * points, and using one here would cost more in thread hand-off than the work
 * it carries. */
import { db } from '../../server/db.js';
import { getConfig } from '../../server/store.js';
import { isModuleEnabled } from '../../server/modules/registry.js';
import { getSnapshot, isConfigured, isSnapshotDue } from '../../server/integrations/pve.js';

async function refreshEveryAccount() {
  const accounts = db.prepare('SELECT id FROM users ORDER BY id').all();
  for (const account of accounts) {
    let config;
    try {
      config = getConfig(account.id);
    } catch {
      continue;
    }
    const settings = config.integrations.pve;
    if (!isModuleEnabled(config, 'pve') || !settings?.host || !isConfigured(account.id)) continue;
    // The account's own refreshMinutes, honoured through the cache entry the
    // last fetch wrote: due or not is not this job's clock to decide.
    if (!isSnapshotDue(account.id)) continue;
    try {
      await getSnapshot(account.id, settings, { force: true });
    } catch (error) {
      // One account's hypervisor being down stops nothing for the others, and
      // the card will say so on its own from the stale snapshot.
      console.warn(`[glassboard] pve refresh failed for user ${account.id}: ${error.message}`);
    }
  }
}

export default [
  {
    name: 'refresh proxmox',
    // The shortest refresh the settings allow is a minute; the job runs on
    // that beat and the per-account interval is honoured by the cache entry,
    // so an account set to ten minutes is asked about once every ten.
    everyMinutes: 1,
    run: refreshEveryAccount,
  },
];
