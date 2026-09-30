// Version and update endpoints. Starting an update only writes a request file;
// the work happens outside the application, as root, in the updater service.
import express from 'express';
import { requireAuth } from '../auth.js';
import {
  checkForUpdate, currentChannel, installedVersion, requestUpdate, setChannel, updateSettings, updateStatus,
} from '../update.js';

export const updateRouter = express.Router();
updateRouter.use(requireAuth);

/** The whole picture: what is installed, what the channel has, where an update stands. */
async function report({ force = false } = {}) {
  const payload = {
    ok: true,
    ...updateSettings(),
    installed: installedVersion(),
    status: updateStatus(),
    latest: null,
    error: null,
  };
  try {
    payload.latest = await checkForUpdate({ force, channel: currentChannel() });
  } catch (error) {
    payload.error = error.message;
  }
  return payload;
}

updateRouter.get('/', async (req, res) => {
  res.json(await report({ force: req.query.check === '1' }));
});

// Switching channel looks at once at what that branch has, because the point of
// the switch is to see whether there is something to try.
updateRouter.post('/channel', async (req, res) => {
  try {
    setChannel(String(req.body?.channel || ''));
    res.json(await report({ force: true }));
  } catch (error) {
    res.status(400).json({ error: error.message, code: error.code ?? null });
  }
});

updateRouter.post('/start', (_req, res) => {
  try {
    const channel = requestUpdate();
    res.json({ ok: true, channel, status: updateStatus() });
  } catch (error) {
    // Not 409: the browser takes that as "needs setup" and leaves the page.
    res.status(error.code === 'disabled' ? 503 : 400).json({ error: error.message, code: error.code ?? null });
  }
});
