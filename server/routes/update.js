// Version and update endpoints. Starting an update only writes a request file;
// the work happens outside the application, as root, in the updater service.
import express from 'express';
import { requireAuth } from '../auth.js';
import {
  checkForUpdate, currentChannel, installedVersion, requestUpdate, setChannel, updateSettings, updateStatus,
} from '../update.js';
import { newsSince, releaseNotes } from '../release-notes.js';
import { getMeta, setMeta } from '../db.js';

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

/* ------------------------------- what's new ------------------------------- */
/* Per account, and keyed on the build rather than on the version: on the beta
   channel the package version does not move between builds, so a version alone
   would never say "this is new". The commit the updater recorded does. */

const seenKeys = (userId) => ({
  build: `news.${Number(userId)}.build`,
  version: `news.${Number(userId)}.version`,
});

const buildId = () => {
  const installed = installedVersion();
  // The commit when the updater wrote one; the version otherwise, which is all
  // a manual install has.
  return installed.commit || installed.version || '';
};

updateRouter.get('/news', (req, res) => {
  const keys = seenKeys(req.user.id);
  const current = buildId();
  const seenBuild = getMeta(keys.build, '');
  const sections = newsSince(getMeta(keys.version, ''));
  res.json({
    ok: true,
    // Shown only when this account has not acknowledged this build, and there
    // is in fact something to say. Asking again on the same build is free.
    unread: Boolean(current) && current !== seenBuild && sections.length > 0,
    build: current,
    installed: installedVersion(),
    sections,
    // Everything, for the "what's new" entry in the settings: that one is asked
    // for deliberately, so it is never empty.
    all: releaseNotes().slice(0, 10),
  });
});

/** Acknowledge. Takes nothing from the body: what was read is what is
 *  installed, and the client has no say in it. */
updateRouter.post('/news/seen', (req, res) => {
  const keys = seenKeys(req.user.id);
  setMeta(keys.build, buildId());
  const latest = releaseNotes().find((entry) => entry.released);
  if (latest) setMeta(keys.version, latest.version);
  res.json({ ok: true });
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
