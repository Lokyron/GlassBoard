/* Proxmox routes, mounted by the registry at /api/m/pve.
 *
 * Every handler takes req.user.id and never an id from the request: an account
 * reaches its own hypervisor and has no way to name anyone else's.
 *
 * Nothing here writes to Proxmox. The only methods are GET, plus the two that
 * store and forget this account's own token — which touch Glassboard's
 * database, not the hypervisor. */
import * as pve from '../../server/integrations/pve.js';
import { getConfig } from '../../server/store.js';

export function routes(router) {
  router.get('/status', (req, res) => {
    const settings = getConfig(req.user.id).integrations.pve;
    res.json({
      ok: true,
      ...pve.credentialStatus(req.user.id),
      host: settings.host,
      port: settings.port,
    });
  });

  /* The secret is written and never read back: the pane only ever learns
     whether one is stored, which is the same promise the 17TRACK key and the
     mailbox password make. */
  router.put('/token', (req, res) => {
    try {
      pve.saveToken(req.user.id, req.body?.tokenId, req.body?.tokenSecret);
      res.json({ ok: true, ...pve.credentialStatus(req.user.id) });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.delete('/token', (req, res) => {
    pve.forgetToken(req.user.id);
    res.json({ ok: true });
  });

  /* Saving the whole settings dialog is not needed to find out whether the
     host answers: the test calls it once and says what failed, which is the
     only way a reader learns they have to accept a self-signed certificate. */
  router.post('/test', async (req, res) => {
    const settings = getConfig(req.user.id).integrations.pve;
    try {
      res.json({ ok: true, ...(await pve.testConnection(req.user.id, settings)) });
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message, code: error.code ?? null });
    }
  });

  /* The refresh button in the open panel. A POST and not a query parameter on
     the read: this one deliberately goes upstream, and a route that reaches
     the network should not be reachable by a reload or a prefetch. */
  router.post('/refresh', async (req, res) => {
    const settings = getConfig(req.user.id).integrations.pve;
    if (!pve.isConfigured(req.user.id) || !settings.host) {
      return res.json({ ok: true, configured: false });
    }
    try {
      const snapshot = await pve.getSnapshot(req.user.id, settings, { force: true });
      res.json({ ok: true, configured: true, snapshot });
    } catch (error) {
      res.status(502).json({ ok: false, configured: true, error: error.message });
    }
  });

  router.get('/snapshot', async (req, res) => {
    const settings = getConfig(req.user.id).integrations.pve;
    if (!pve.isConfigured(req.user.id) || !settings.host) {
      return res.json({ ok: true, configured: false });
    }
    try {
      const snapshot = await pve.getSnapshot(req.user.id, settings);
      res.json({ ok: true, configured: true, snapshot });
    } catch (error) {
      res.status(502).json({ ok: false, configured: true, error: error.message });
    }
  });
}
