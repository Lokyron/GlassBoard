// Version and update endpoints. Starting an update only writes a request file;
// the work happens outside the application, as root, in the updater service.
import express from 'express';
import { requireAuth } from '../auth.js';
import { checkForUpdate, installedVersion, requestUpdate, updateSettings, updateStatus } from '../update.js';

export const updateRouter = express.Router();
updateRouter.use(requireAuth);

updateRouter.get('/', async (req, res) => {
  const payload = {
    ok: true,
    ...updateSettings(),
    installed: installedVersion(),
    status: updateStatus(),
    latest: null,
    error: null,
  };
  try {
    payload.latest = await checkForUpdate({ force: req.query.check === '1' });
  } catch (error) {
    payload.error = error.message;
  }
  res.json(payload);
});

updateRouter.post('/start', (_req, res) => {
  try {
    requestUpdate();
    res.json({ ok: true, status: updateStatus() });
  } catch (error) {
    res.status(error.code === 'disabled' ? 409 : 400).json({ error: error.message, code: error.code ?? null });
  }
});
