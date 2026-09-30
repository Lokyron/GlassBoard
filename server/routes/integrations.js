// Integration endpoints. Every upstream call happens here, never in the browser.
import express from 'express';
import { requireAuth } from '../auth.js';
import { getConfig } from '../store.js';
import { getForecast, reverseGeocode } from '../integrations/weather.js';
import * as georide from '../integrations/georide.js';
import * as parcels from '../integrations/parcels.js';
import * as mailbox from '../integrations/mailbox.js';
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

integrationsRouter.get('/georide/trips', async (req, res) => {
  const settings = getConfig().integrations.georide;
  if (!settings.enabled) return res.json({ ok: false, configured: false, error: 'The GeoRide integration is disabled.' });
  const days = Number.parseInt(req.query.days, 10);
  const periodDays = Number.isFinite(days) && days >= 1 && days <= 31 ? days : settings.periodDays;
  res.json(await georide.getTrips({ ...settings, periodDays }));
});

/* -------------------------------- parcels -------------------------------- */

/** Every failure mode of the parcel module, mapped to a status code once.
 *  Never 409: the browser reads that one as "this instance needs setting up"
 *  and leaves the dashboard for the setup page. */
const parcelError = (res, error) => {
  const status = error.code === 'not_found' ? 404
    : error.code === 'not_configured' || error.code === 'disabled' ? 503
      : error.code === 'rate_limited' ? 429
        : error.code === 'bad_key' || error.code === 'network' || error.code === 'timeout' ? 502 : 400;
  res.status(status).json({ error: error.message, code: error.code ?? null });
};

integrationsRouter.get('/parcels', async (_req, res) => {
  const settings = getConfig().integrations.parcels;
  if (!settings.enabled) return res.json({ ok: false, configured: false, error: 'The parcel integration is disabled.' });
  res.json(await parcels.getParcels(settings));
});

integrationsRouter.post('/parcels', async (req, res) => {
  try {
    res.json({ ok: true, parcel: await parcels.addParcel(req.body ?? {}) });
  } catch (error) {
    parcelError(res, error);
  }
});

integrationsRouter.delete('/parcels/:id', async (req, res) => {
  try {
    await parcels.removeParcel(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    parcelError(res, error);
  }
});

integrationsRouter.post('/parcels/refresh', async (_req, res) => {
  const settings = getConfig().integrations.parcels;
  try {
    await parcels.refresh({ force: true, refreshMinutes: settings.refreshMinutes });
    res.json(await parcels.getParcels(settings));
  } catch (error) {
    parcelError(res, error);
  }
});

integrationsRouter.get('/parcels/status', async (_req, res) => {
  const payload = { ok: true, hasKey: parcels.isConfigured(), quota: null, error: null, mail: mailbox.status() };
  if (payload.hasKey) {
    try {
      payload.quota = await parcels.getQuota();
    } catch (error) {
      payload.error = error.message;
    }
  }
  res.json(payload);
});

/** The key is write-only: it goes in, it never comes back out. */
integrationsRouter.put('/parcels/key', (req, res) => {
  const key = String(req.body?.apiKey || '').trim();
  if (!key) return res.status(400).json({ error: 'An API key is required.' });
  parcels.setApiKey(key);
  res.json({ ok: true });
});

integrationsRouter.delete('/parcels/key', (_req, res) => {
  parcels.setApiKey(null);
  res.json({ ok: true });
});

/* --------------------------- parcels from mail --------------------------- */

integrationsRouter.get('/parcels/suggestions', (_req, res) => {
  res.json({ ok: true, suggestions: mailbox.listSuggestions(), mail: mailbox.status() });
});

/** Accepting is the one moment a provider credit may be spent, and it is a click. */
integrationsRouter.post('/parcels/suggestions/:id/accept', async (req, res) => {
  try {
    const suggestion = mailbox.getSuggestion(req.params.id);
    const parcel = await parcels.addParcel({
      label: suggestion.label,
      trackingNumber: suggestion.tracking_no,
      carrier: null,
    });
    // Only now: a suggestion whose parcel was refused must stay on offer.
    mailbox.markAccepted(suggestion.id);
    res.json({ ok: true, parcel });
  } catch (error) {
    parcelError(res, error);
  }
});

integrationsRouter.post('/parcels/suggestions/:id/ignore', (req, res) => {
  try {
    mailbox.ignoreSuggestion(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    parcelError(res, error);
  }
});

integrationsRouter.post('/parcels/mail/scan', async (_req, res) => {
  const settings = getConfig().integrations.parcels;
  try {
    const result = await mailbox.scan(settings.mail);
    res.json({ ok: true, ...result, suggestions: mailbox.listSuggestions() });
  } catch (error) {
    parcelError(res, error);
  }
});

integrationsRouter.post('/parcels/mail/test', async (_req, res) => {
  const settings = getConfig().integrations.parcels;
  try {
    res.json(await mailbox.testConnection(settings.mail));
  } catch (error) {
    parcelError(res, error);
  }
});

/** Write-only, like every other credential here. */
integrationsRouter.put('/parcels/mail/password', (req, res) => {
  const password = String(req.body?.password || '').trim();
  if (!password) return res.status(400).json({ error: 'A password is required.' });
  mailbox.setPassword(password);
  res.json({ ok: true });
});

integrationsRouter.delete('/parcels/mail/password', (_req, res) => {
  mailbox.setPassword(null);
  res.json({ ok: true });
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
