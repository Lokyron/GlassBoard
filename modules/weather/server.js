/* Weather routes, mounted by the registry at /api/m/weather.
 *
 * These are the one exception to "a route never calls the network", and they
 * earn it: Open-Meteo answers in a few tens of milliseconds, the response is
 * cached for the account's refresh interval, and the coordinates come from the
 * browser, so there is nothing a job could have fetched in advance. Nothing is
 * parsed here that could hold the event loop. */
import { getForecast, reverseGeocode } from '../../server/integrations/weather.js';
import { getConfig } from '../../server/store.js';

const coord = (value, limit) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};

export function routes(router) {
  router.get('/forecast', async (req, res) => {
    const weather = getConfig(req.user.id).integrations.weather;

    const latitude = coord(req.query.latitude, 90) ?? weather.fallback.latitude;
    const longitude = coord(req.query.longitude, 180) ?? weather.fallback.longitude;
    try {
      const forecast = await getForecast(latitude, longitude, Math.max(300, weather.refreshMinutes * 60));
      res.json({ ok: true, latitude, longitude, forecast });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message });
    }
  });

  router.get('/place', async (req, res) => {
    const weather = getConfig(req.user.id).integrations.weather;
    if (!weather.reverseGeocoding) return res.json({ ok: true, name: '' });
    const latitude = coord(req.query.latitude, 90);
    const longitude = coord(req.query.longitude, 180);
    if (latitude === null || longitude === null) return res.status(400).json({ error: 'Invalid coordinates.' });
    const place = await reverseGeocode(latitude, longitude);
    res.json({ ok: true, ...place });
  });
}
