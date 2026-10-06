/* Looking through the mailbox for parcels, on its own clock.
 *
 * One account at a time, and sequentially: several mailboxes opened at once
 * would be several IMAP connections from one address, which is exactly what
 * a provider reads as abuse. One account's failure stops nothing for the
 * others — the whole point of a loop that catches.
 *
 * The scan itself runs in this module's worker. It used to run inside the
 * hourly housekeeping on the main thread, where decoding a hundred and fifty
 * messages held up every other request on the instance. */
import { db, getMeta } from '../../server/db.js';
import { getConfig } from '../../server/store.js';
import { isModuleEnabled } from '../../server/modules/registry.js';
import { runInWorker } from '../../server/modules/workers.js';
import * as mailbox from '../../server/integrations/mailbox.js';

async function scanMailboxes() {
  const accounts = db.prepare('SELECT id FROM users ORDER BY id').all();
  for (const account of accounts) {
    let config;
    try {
      config = getConfig(account.id);
    } catch {
      continue;
    }
    const settings = config.integrations.parcels;
    if (!isModuleEnabled(config, 'parcels') || !settings?.mail?.enabled || !mailbox.isConfigured(account.id)) continue;

    const last = getMeta(`mail.${account.id}.last_scan`);
    const due = !last || Date.now() - new Date(last).getTime() >= Math.max(1, settings.mail.scanHours) * 3_600_000;
    if (!due) continue;

    try {
      await runInWorker('parcels', { task: 'scan', userId: account.id }, `parcels:scan:${account.id}`);
    } catch (error) {
      console.warn(`[glassboard] mailbox scan failed for user ${account.id}: ${error.message}`);
    }
  }
}

export default [
  { name: 'scan mailboxes', everyMinutes: 30, run: scanMailboxes },
];
