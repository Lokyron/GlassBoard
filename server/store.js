// Reading, writing, exporting and importing the dashboard configuration.
// Used by both the HTTP API and the CLI scripts, so both behave identically.
import fs from 'node:fs';
import path from 'node:path';
import { db, now, setSecret, getSecret, listSecretNames } from './db.js';
import { DATA_DIR } from './env.js';
import { encrypt, decrypt } from './crypto.js';
import { validateConfig, migrateConfig, CONFIG_VERSION } from './config-schema.js';
import { defaultConfig } from './default-config.js';

const KEEP_REVISIONS = 20;
export const EXPORT_FORMAT_VERSION = 1;
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');

/** Current configuration. Seeds the neutral default on a fresh instance. */
export function getConfig() {
  const row = db.prepare('SELECT json FROM config_revisions ORDER BY id DESC LIMIT 1').get();
  if (!row) {
    const seeded = defaultConfig();
    saveConfig(seeded, 'initial default configuration');
    return seeded;
  }
  try {
    return JSON.parse(row.json);
  } catch {
    // A corrupted revision must not take the whole dashboard down.
    console.error('[glassboard] latest configuration revision is unreadable, falling back to defaults');
    return defaultConfig();
  }
}

export function saveConfig(config, note = null) {
  const { ok, errors, value } = validateConfig(config);
  if (!ok) {
    const error = new Error('Invalid configuration');
    error.details = errors;
    throw error;
  }
  db.prepare('INSERT INTO config_revisions (json, note, created_at) VALUES (?, ?, ?)').run(
    JSON.stringify(value),
    note,
    now()
  );
  db.prepare(
    `DELETE FROM config_revisions WHERE id NOT IN (
       SELECT id FROM config_revisions ORDER BY id DESC LIMIT ?
     )`
  ).run(KEEP_REVISIONS);
  return value;
}

export function listRevisions() {
  return db
    .prepare('SELECT id, note, created_at FROM config_revisions ORDER BY id DESC')
    .all();
}

/* ---------------------------- export / import ---------------------------- */

/** Names of the secrets an export may carry, with the label shown to the user. */
const EXPORTABLE_SECRETS = {
  'georide.token': 'GeoRide API token',
  'georide.email': 'GeoRide account email',
  'georide.password': 'GeoRide account password',
};

export function buildExport({ includeSecrets = false } = {}) {
  const payload = {
    app: 'glassboard',
    formatVersion: EXPORT_FORMAT_VERSION,
    configVersion: CONFIG_VERSION,
    exportedAt: now(),
    containsSecrets: false,
    config: getConfig(),
    secrets: null,
  };

  if (includeSecrets) {
    const secrets = {};
    for (const name of listSecretNames()) {
      if (!(name in EXPORTABLE_SECRETS)) continue;
      const plain = decrypt(getSecret(name));
      if (plain !== null) secrets[name] = plain;
    }
    if (Object.keys(secrets).length > 0) {
      payload.containsSecrets = true;
      payload.secrets = secrets;
      payload.WARNING =
        'This file contains PLAINTEXT credentials (' +
        Object.keys(secrets).map((n) => EXPORTABLE_SECRETS[n]).join(', ') +
        '). Store it somewhere safe and never commit it to a repository.';
    }
  }
  return payload;
}

export function writeBackup(reason) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(BACKUP_DIR, `config-${stamp}-${reason}.json`);
  fs.writeFileSync(file, JSON.stringify(buildExport({ includeSecrets: false }), null, 2), { mode: 0o600 });
  return file;
}

/**
 * Import a previously exported file.
 * The existing configuration is snapshotted first and nothing is written until
 * the payload has fully validated, so a bad file can never corrupt an instance.
 */
export function importExport(payload, { includeSecrets = false } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('The file is not a JSON object.');
  }
  if (payload.app !== 'glassboard') {
    throw new Error('This file was not produced by Glassboard (missing "app": "glassboard").');
  }
  const formatVersion = Number(payload.formatVersion);
  if (!Number.isFinite(formatVersion) || formatVersion < 1) {
    throw new Error('Missing or invalid "formatVersion".');
  }
  if (formatVersion > EXPORT_FORMAT_VERSION) {
    throw new Error(
      `This file uses export format ${formatVersion}, but this instance only understands up to ${EXPORT_FORMAT_VERSION}. Upgrade Glassboard first.`
    );
  }

  const migrated = migrateConfig(payload.config);
  const { ok, errors, value } = validateConfig(migrated);
  if (!ok) {
    const error = new Error('The configuration in this file is invalid.');
    error.details = errors;
    throw error;
  }

  const backup = writeBackup('before-import');
  const restored = { config: false, secrets: [] };

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO config_revisions (json, note, created_at) VALUES (?, ?, ?)').run(
      JSON.stringify(value),
      `imported from ${payload.exportedAt || 'unknown date'}`,
      now()
    );
    restored.config = true;
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  if (includeSecrets && payload.secrets && typeof payload.secrets === 'object') {
    for (const [name, plain] of Object.entries(payload.secrets)) {
      if (!(name in EXPORTABLE_SECRETS) || typeof plain !== 'string') continue;
      setSecret(name, encrypt(plain));
      restored.secrets.push(name);
    }
  }

  return { backup, restored, warnings: errors };
}
