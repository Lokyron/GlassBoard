/* GeoRide routes, mounted by the registry at /api/m/georide.
 *
 * None of these waits on the GeoRide API for a month of rides. The summary
 * asks for live telemetry — where the motorcycle is now, which nothing can
 * have stored in advance — and reads its figures off the rides the worker
 * put on disk. The trips route is a pure read.
 *
 * Every handler takes req.user.id and never an id from the request: an
 * account reaches its own GeoRide session and has no way to name anyone
 * else's. */
import * as georide from '../../server/integrations/georide.js';
import { getConfig } from '../../server/store.js';
import { getTile, isValidTile } from '../../server/integrations/map-tiles.js';

export function routes(router) {
  router.get('/status', (req, res) => {
    res.json({ ok: true, ...georide.credentialStatus(req.user.id) });
  });

  router.post('/login', async (req, res) => {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    try {
      await georide.login(req.user.id, email, password, { rememberPassword: req.body?.rememberPassword !== false });
      const trackers = await georide.listTrackers(req.user.id);
      res.json({ ok: true, trackers });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.post('/logout', (req, res) => {
    georide.forgetCredentials(req.user.id);
    res.json({ ok: true });
  });

  router.get('/trackers', async (req, res) => {
    try {
      res.json({ ok: true, trackers: await georide.listTrackers(req.user.id) });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  router.get('/summary', async (req, res) => {
    const settings = getConfig(req.user.id).integrations.georide;
    res.json(await georide.getSummary(req.user.id, settings));
  });

  router.get('/trips', async (req, res) => {
    const settings = getConfig(req.user.id).integrations.georide;
    const days = Number.parseInt(req.query.days, 10);
    const periodDays = Number.isFinite(days) && days >= 1 && days <= 31 ? days : settings.periodDays;
    res.json(await georide.getTrips(req.user.id, { ...settings, periodDays }));
  });

  /* ------------------------------- map tiles ------------------------------- */

  router.get('/map/tile/:z/:x/:y.png', async (req, res) => {
    const z = Number.parseInt(req.params.z, 10);
    const x = Number.parseInt(req.params.x, 10);
    const y = Number.parseInt(req.params.y, 10);
    if (!isValidTile(z, x, y)) return res.status(400).end();
    try {
      const buffer = await getTile(z, x, y);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=604800');
      res.send(buffer);
    } catch {
      res.status(502).end();
    }
  });

}
