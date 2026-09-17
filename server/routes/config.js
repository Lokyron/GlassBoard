// Dashboard configuration: read, write, export, import, rollback.
import express from 'express';
import { requireAuth, instanceId } from '../auth.js';
import { getConfig, saveConfig, listRevisions, buildExport, importExport, writeBackup } from '../store.js';
import { db } from '../db.js';
import { TILE_TYPES } from '../config-schema.js';

export const configRouter = express.Router();
configRouter.use(requireAuth);

configRouter.get('/', (_req, res) => {
  res.json({ config: getConfig(), tileTypes: TILE_TYPES });
});

configRouter.put('/', (req, res) => {
  try {
    const saved = saveConfig(req.body?.config ?? req.body, req.body?.note ?? 'saved from the dashboard');
    res.json({ ok: true, config: saved });
  } catch (error) {
    res.status(400).json({ error: error.message, details: error.details ?? null });
  }
});

configRouter.get('/revisions', (_req, res) => {
  res.json({ revisions: listRevisions() });
});

configRouter.post('/revisions/:id/restore', (req, res) => {
  const row = db.prepare('SELECT json FROM config_revisions WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Unknown revision.' });
  try {
    const saved = saveConfig(JSON.parse(row.json), `restored revision ${req.params.id}`);
    res.json({ ok: true, config: saved });
  } catch (error) {
    res.status(400).json({ error: error.message, details: error.details ?? null });
  }
});

configRouter.get('/export', (req, res) => {
  const includeSecrets = req.query.secrets === '1' || req.query.secrets === 'true';
  const payload = buildExport({ includeSecrets });
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `glassboard-${instanceId()}-${stamp}${includeSecrets ? '-with-secrets' : ''}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(JSON.stringify(payload, null, 2));
});

configRouter.post('/import', (req, res) => {
  const includeSecrets = req.body?.includeSecrets === true;
  const payload = req.body?.payload ?? req.body;
  try {
    const result = importExport(payload, { includeSecrets });
    res.json({ ok: true, ...result, config: getConfig() });
  } catch (error) {
    res.status(400).json({ error: error.message, details: error.details ?? null });
  }
});

configRouter.post('/backup', (_req, res) => {
  res.json({ ok: true, file: writeBackup('manual') });
});
