/* The parcels worker.
 *
 * The mailbox scan is the expensive half of this module: a hundred and fifty
 * messages fetched over IMAP, decoded, stripped of their markup and searched
 * for tracking numbers. On the main thread that is the whole instance paused.
 *
 * The mailbox is opened with EXAMINE and read with BODY.PEEK, so the server
 * itself refuses any write — read-only does not rest on this code behaving. */
import { serve } from '../../server/modules/worker-host.js';
import * as mailbox from '../../server/integrations/mailbox.js';
import { getConfig } from '../../server/store.js';

serve({
  async scan({ userId }) {
    const settings = getConfig(userId).integrations.parcels;
    if (!settings?.mail?.enabled) return { skipped: true };
    return mailbox.scan(userId, settings.mail);
  },
});
