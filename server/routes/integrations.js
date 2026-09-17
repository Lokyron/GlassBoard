// Integration endpoints. Every upstream call happens here, never in the browser.
import express from 'express';
import { requireAuth } from '../auth.js';
import { getConfig } from '../store.js';
import { getForecast, reverseGeocode } from '../integrations/weather.js';
import * as georide from '../integrations/georide.js';
import { getTile, isValidTile } from '../integrations/map-tiles.js';

export const integrationsRouter = express.Router();
integrationsRouter.use(requireAuth);

const coord = (value, limit) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};

/* -------------------------------- weather -------------------------------- */

integrationsRouter.get('/weather/forecast', async (req, res) => {
  const weather = getConfig().integrations.weather;
  if (!weather.enabled) return res.status(404).json({ error: 'The weather integration is disabled.' });

  const latitude = coord(req.query.latitude, 90) ?? weather.fallback.latitude;
  const longitude = coord(req.query.longitude, 180) ?? weather.fallback.longitude;
  try {
    const forecast = await getForecast(latitude, longitude, Math.max(300, weather.refreshMinutes * 60));
    res.json({ ok: true, latitude, longitude, forecast });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

integrationsRouter.get('/weather/place', async (req, res) => {
  const weather = getConfig().integrations.weather;
  if (!weather.enabled || !weather.reverseGeocoding) return res.json({ ok: true, name: '' });
  const latitude = coord(req.query.latitude, 90);
  const longitude = coord(req.query.longitude, 180);
  if (latitude === null || longitude === null) return res.status(400).json({ error: 'Invalid coordinates.' });
  const place = await reverseGeocode(latitude, longitude);
  res.json({ ok: true, ...place });
});

/* -------------------------------- GeoRide -------------------------------- */

integrationsRouter.get('/georide/status', (_req, res) => {
  res.json({ ok: true, ...georide.credentialStatus() });
});

integrationsRouter.post('/georide/login', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
  try {
    await georide.login(email, password, { rememberPassword: req.body?.rememberPassword !== false });
    const trackers = await georide.listTrackers();
    res.json({ ok: true, trackers });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

integrationsRouter.post('/georide/logout', (_req, res) => {
  georide.forgetCredentials();
  res.json({ ok: true });
});

integrationsRouter.get('/georide/trackers', async (_req, res) => {
  try {
    res.json({ ok: true, trackers: await georide.listTrackers() });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

integrationsRouter.get('/georide/summary', async (_req, res) => {
  const settings = getConfig().integrations.georide;
  if (!settings.enabled) return res.json({ ok: false, configured: false, error: 'The GeoRide integration is disabled.' });
  res.json(await georide.getSummary(settings));
});

/* ------------------------------- map tiles ------------------------------- */

integrationsRouter.get('/map/tile/:z/:x/:y.png', async (req, res) => {
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
