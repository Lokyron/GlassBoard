/* Parcel routes, mounted by the registry at /api/m/parcels.
 *
 * A 17TRACK credit is spent when a tracking number is registered, never when
 * a status is read — so nothing here registers anything on a timer, and the
 * statuses are read in one grouped request. The mailbox scan is the heavy
 * one and runs in this module's worker, not on the request thread. */
import * as parcels from '../../server/integrations/parcels.js';
import * as mailbox from '../../server/integrations/mailbox.js';
import { getConfig } from '../../server/store.js';

export function routes(router) {
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

  router.get('/', async (req, res) => {
    const settings = getConfig(req.user.id).integrations.parcels;
    res.json(await parcels.getParcels(req.user.id, settings));
  });

  router.post('/', async (req, res) => {
    const settings = getConfig(req.user.id).integrations.parcels;
    try {
      res.json({ ok: true, parcel: await parcels.addParcel(req.user.id, req.body ?? {}, settings) });
    } catch (error) {
      parcelError(res, error);
    }
  });


  router.post('/refresh', async (req, res) => {
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
  router.post('/import', async (req, res) => {
    const settings = getConfig(req.user.id).integrations.parcels;
    try {
      const result = await parcels.importFromProvider(req.user.id, settings);
      res.json({ ok: true, ...result, ...(await parcels.getParcels(req.user.id, settings)) });
    } catch (error) {
      parcelError(res, error);
    }
  });

  router.get('/status', async (req, res) => {
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
  router.put('/key', (req, res) => {
    const key = String(req.body?.apiKey || '').trim();
    if (!key) return res.status(400).json({ error: 'An API key is required.' });
    parcels.setApiKey(req.user.id, key);
    res.json({ ok: true });
  });

  router.delete('/key', (req, res) => {
    parcels.setApiKey(req.user.id, null);
    res.json({ ok: true });
  });

  /* --------------------------- parcels from mail --------------------------- */

  router.get('/suggestions', (req, res) => {
    res.json({ ok: true, suggestions: mailbox.listSuggestions(req.user.id), mail: mailbox.status(req.user.id) });
  });

  /** Accepting is the one moment a provider credit may be spent, and it is a click. */
  router.post('/suggestions/:id/accept', async (req, res) => {
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

  router.post('/suggestions/:id/ignore', (req, res) => {
    try {
      mailbox.ignoreSuggestion(req.user.id, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      parcelError(res, error);
    }
  });

  router.post('/mail/scan', async (req, res) => {
    const settings = getConfig(req.user.id).integrations.parcels;
    try {
      const result = await mailbox.scan(req.user.id, settings.mail);
      res.json({ ok: true, ...result, suggestions: mailbox.listSuggestions(req.user.id) });
    } catch (error) {
      parcelError(res, error);
    }
  });

  router.post('/mail/test', async (req, res) => {
    const settings = getConfig(req.user.id).integrations.parcels;
    try {
      res.json(await mailbox.testConnection(req.user.id, settings.mail));
    } catch (error) {
      parcelError(res, error);
    }
  });

  /** Write-only, like every other credential here. */
  router.put('/mail/password', (req, res) => {
    const password = String(req.body?.password || '').trim();
    if (!password) return res.status(400).json({ error: 'A password is required.' });
    mailbox.setPassword(req.user.id, password);
    res.json({ ok: true });
  });

  router.delete('/mail/password', (req, res) => {
    mailbox.setPassword(req.user.id, null);
    res.json({ ok: true });
  });

  /* Last on purpose. '/:id' matches a single segment, so it would otherwise
     shadow DELETE '/key' — which is what used to happen: removing the 17TRACK
     key from the settings answered "Unknown parcel". Every literal path above
     is matched first now. */
  router.delete('/:id', async (req, res) => {
    try {
      await parcels.removeParcel(req.user.id, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      parcelError(res, error);
    }
  });

}
