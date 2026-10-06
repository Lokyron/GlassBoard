// Integration endpoints. Every upstream call happens here, never in the browser.
import express from 'express';
import { requireAuth } from '../auth.js';
import { getConfig } from '../store.js';
import * as georide from '../integrations/georide.js';
import * as parcels from '../integrations/parcels.js';
import * as mailbox from '../integrations/mailbox.js';
import { getTile, isValidTile } from '../integrations/map-tiles.js';

export const integrationsRouter = express.Router();
integrationsRouter.use(requireAuth);

/* -------------------------------- GeoRide -------------------------------- */

/* Like the configuration routes, everything here takes req.user.id and never
   an id from the request: an account reaches its own GeoRide session, its own
   17TRACK quota, its own parcels and its own mailbox, and has no way to name
   anyone else's. */

integrationsRouter.get('/georide/status', (req, res) => {
  res.json({ ok: true, ...georide.credentialStatus(req.user.id) });
});

integrationsRouter.post('/georide/login', async (req, res) => {
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

integrationsRouter.post('/georide/logout', (req, res) => {
  georide.forgetCredentials(req.user.id);
  res.json({ ok: true });
});

integrationsRouter.get('/georide/trackers', async (req, res) => {
  try {
    res.json({ ok: true, trackers: await georide.listTrackers(req.user.id) });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

integrationsRouter.get('/georide/summary', async (req, res) => {
  const settings = getConfig(req.user.id).integrations.georide;
  if (!settings.enabled) return res.json({ ok: false, configured: false, error: 'The GeoRide integration is disabled.' });
  res.json(await georide.getSummary(req.user.id, settings));
});

integrationsRouter.get('/georide/trips', async (req, res) => {
  const settings = getConfig(req.user.id).integrations.georide;
  if (!settings.enabled) return res.json({ ok: false, configured: false, error: 'The GeoRide integration is disabled.' });
  const days = Number.parseInt(req.query.days, 10);
  const periodDays = Number.isFinite(days) && days >= 1 && days <= 31 ? days : settings.periodDays;
  res.json(await georide.getTrips(req.user.id, { ...settings, periodDays }));
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

integrationsRouter.get('/parcels', async (req, res) => {
  const settings = getConfig(req.user.id).integrations.parcels;
  if (!settings.enabled) return res.json({ ok: false, configured: false, error: 'The parcel integration is disabled.' });
  res.json(await parcels.getParcels(req.user.id, settings));
});

integrationsRouter.post('/parcels', async (req, res) => {
  const settings = getConfig(req.user.id).integrations.parcels;
  try {
    res.json({ ok: true, parcel: await parcels.addParcel(req.user.id, req.body ?? {}, settings) });
  } catch (error) {
    parcelError(res, error);
  }
});

integrationsRouter.delete('/parcels/:id', async (req, res) => {
  try {
    await parcels.removeParcel(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (error) {
    parcelError(res, error);
  }
});

integrationsRouter.post('/parcels/refresh', async (req, res) => {
  const settings = getConfig(req.user.id).integrations.parcels;
  try {
    await parcels.refresh(req.user.id, { force: true, refreshMinutes: settings.refreshMinutes });
    res.json(await parcels.getParcels(req.user.id, settings));
  } catch (error) {
    parcelError(res, error);
  }
});

/** Take over what the 17TRACK account already follows. Reads only, so it costs
 *  no quota and can be run as often as wanted. */
integrationsRouter.post('/parcels/import', async (req, res) => {
  const settings = getConfig(req.user.id).integrations.parcels;
  try {
    const result = await parcels.importFromProvider(req.user.id, settings);
    res.json({ ok: true, ...result, ...(await parcels.getParcels(req.user.id, settings)) });
  } catch (error) {
    parcelError(res, error);
  }
});

integrationsRouter.get('/parcels/status', async (req, res) => {
  const payload = {
    ok: true, hasKey: parcels.isConfigured(req.user.id), quota: null, error: null,
    mail: mailbox.status(req.user.id),
  };
  if (payload.hasKey) {
    try {
      payload.quota = await parcels.getQuota(req.user.id);
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
  parcels.setApiKey(req.user.id, key);
  res.json({ ok: true });
});

integrationsRouter.delete('/parcels/key', (req, res) => {
  parcels.setApiKey(req.user.id, null);
  res.json({ ok: true });
});

/* --------------------------- parcels from mail --------------------------- */

integrationsRouter.get('/parcels/suggestions', (req, res) => {
  res.json({ ok: true, suggestions: mailbox.listSuggestions(req.user.id), mail: mailbox.status(req.user.id) });
});

/** Accepting is the one moment a provider credit may be spent, and it is a click. */
integrationsRouter.post('/parcels/suggestions/:id/accept', async (req, res) => {
  try {
    const suggestion = mailbox.getSuggestion(req.user.id, req.params.id);
    const parcel = await parcels.addParcel(req.user.id, {
      label: suggestion.label,
      trackingNumber: suggestion.tracking_no,
      carrier: null,
    }, getConfig(req.user.id).integrations.parcels);
    // Only now: a suggestion whose parcel was refused must stay on offer.
    mailbox.markAccepted(req.user.id, suggestion.id);
    res.json({ ok: true, parcel });
  } catch (error) {
    parcelError(res, error);
  }
});

integrationsRouter.post('/parcels/suggestions/:id/ignore', (req, res) => {
  try {
    mailbox.ignoreSuggestion(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (error) {
    parcelError(res, error);
  }
});

integrationsRouter.post('/parcels/mail/scan', async (req, res) => {
  const settings = getConfig(req.user.id).integrations.parcels;
  try {
    const result = await mailbox.scan(req.user.id, settings.mail);
    res.json({ ok: true, ...result, suggestions: mailbox.listSuggestions(req.user.id) });
  } catch (error) {
    parcelError(res, error);
  }
});

integrationsRouter.post('/parcels/mail/test', async (req, res) => {
  const settings = getConfig(req.user.id).integrations.parcels;
  try {
    res.json(await mailbox.testConnection(req.user.id, settings.mail));
  } catch (error) {
    parcelError(res, error);
  }
});

/** Write-only, like every other credential here. */
integrationsRouter.put('/parcels/mail/password', (req, res) => {
  const password = String(req.body?.password || '').trim();
  if (!password) return res.status(400).json({ error: 'A password is required.' });
  mailbox.setPassword(req.user.id, password);
  res.json({ ok: true });
});

integrationsRouter.delete('/parcels/mail/password', (req, res) => {
  mailbox.setPassword(req.user.id, null);
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
