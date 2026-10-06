// Dashboard configuration: read, write, export, import, rollback.
import express from 'express';
import { requireAuth, instanceId } from '../auth.js';
import {
  getConfig, saveConfig, listRevisions, getRevision, buildExport, importExport, writeBackup,
} from '../store.js';
import { TILE_TYPES, THEME_PRESETS } from '../config-schema.js';
import { moduleSummary } from '../modules/registry.js';

export const configRouter = express.Router();
configRouter.use(requireAuth);

/* Every route below reads req.user.id and never a value from the request. That
   is the whole of the isolation between accounts: there is no way to name
   someone else's dashboard, because the only identity in play is the one the
   session cookie resolved to. */

configRouter.get('/', (req, res) => {
  res.json({
    config: getConfig(req.user.id),
    tileTypes: TILE_TYPES,
    themePresets: THEME_PRESETS,
    // What the settings dialog needs to list the modules and their tabs.
    modules: moduleSummary(),
  });
});

configRouter.put('/', (req, res) => {
  try {
    const saved = saveConfig(req.user.id, req.body?.config ?? req.body, req.body?.note ?? 'saved from the dashboard');
    res.json({ ok: true, config: saved });
  } catch (error) {
    res.status(400).json({ error: error.message, details: error.details ?? null });
  }
});

configRouter.get('/revisions', (req, res) => {
  res.json({ revisions: listRevisions(req.user.id) });
});

configRouter.post('/revisions/:id/restore', (req, res) => {
  // getRevision scopes the lookup to the account, so a revision id belonging to
  // someone else reads as unknown rather than as forbidden: the answer says
  // nothing about whether that id exists at all.
  const row = getRevision(req.user.id, req.params.id);
  if (!row) return res.status(404).json({ error: 'Unknown revision.' });
  try {
    const saved = saveConfig(req.user.id, JSON.parse(row.json), `restored revision ${req.params.id}`);
    res.json({ ok: true, config: saved });
  } catch (error) {
    res.status(400).json({ error: error.message, details: error.details ?? null });
  }
});

configRouter.get('/export', (req, res) => {
  const includeSecrets = req.query.secrets === '1' || req.query.secrets === 'true';
  const payload = buildExport(req.user.id, { includeSecrets });
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `glassboard-${instanceId()}-${req.user.username}-${stamp}${includeSecrets ? '-with-secrets' : ''}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(JSON.stringify(payload, null, 2));
});

configRouter.post('/import', (req, res) => {
  const includeSecrets = req.body?.includeSecrets === true;
  const payload = req.body?.payload ?? req.body;
  try {
    const result = importExport(req.user.id, payload, { includeSecrets });
    res.json({ ok: true, ...result, config: getConfig(req.user.id) });
  } catch (error) {
    res.status(400).json({ error: error.message, details: error.details ?? null });
  }
});

configRouter.post('/backup', (req, res) => {
  res.json({ ok: true, file: writeBackup(req.user.id, 'manual') });
});
