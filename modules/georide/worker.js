/* The GeoRide worker.
 *
 * Everything expensive about this module happens here, on its own thread: the
 * call to the GeoRide API, the parse of a window of positions, the filter that
 * gives each ride its own points, the thinning, and the write. The main thread
 * only ever reads the rides back out of SQLite.
 *
 * It opens its own database connection. That is safe because the file is in
 * WAL mode, where a writer does not block readers. */
import { serve } from '../../server/modules/worker-host.js';
import { syncTripsInWorker } from '../../server/integrations/georide.js';
import { getConfig } from '../../server/store.js';

serve({
  async sync({ userId, trackerId }) {
    const refreshMinutes = getConfig(userId).integrations.georide?.refreshMinutes ?? 5;
    return { rides: await syncTripsInWorker(userId, trackerId, refreshMinutes) };
  },
});
