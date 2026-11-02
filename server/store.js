// Reading, writing, exporting and importing the dashboard configuration.
// Used by both the HTTP API and the CLI scripts, so both behave identically.
import fs from 'node:fs';
import path from 'node:path';
import { db, now, setSecret, getSecret, listSecretNames } from './db.js';
import { DATA_DIR } from './env.js';
import { encrypt, decrypt } from './crypto.js';
import { validateConfig, migrateConfig, CONFIG_VERSION } from './config-schema.js';
import { defaultConfig } from './default-config.js';
import { readWallpaper, saveWallpaper, wallpaperInfo, MAX_BYTES } from './wallpaper.js';

const KEEP_REVISIONS = 20;
export const EXPORT_FORMAT_VERSION = 1;
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');

/** An account's configuration. Seeds the neutral default the first time it is
 *  asked for, which is what gives a brand-new account a dashboard to land on.
 *  Seeding happens here and not at boot: before accounts, there was one
 *  configuration and the server could seed it on start-up; now there is one
 *  per account, and the server has no way to know about an account that has
 *  not been created yet. */
export function getConfig(userId) {
  const row = db
    .prepare('SELECT json FROM config_revisions WHERE user_id = ? ORDER BY id DESC LIMIT 1')
    .get(userId);
  if (!row) {
    // The validated document, not the raw default: the example configuration
    // leaves out whole blocks the validator fills in — `integrations.parcels`
    // among them — and returning it unvalidated served a first-load document
    // with holes the dashboard then read straight through. It used to happen
    // once per instance; with one configuration per account it happens to
    // everyone, on their first screen.
    return saveConfig(userId, defaultConfig(), 'initial default configuration');
  }
  try {
    // A document saved by an older version lacks the fields added since, so it
    // goes through the validator on the way out: callers always receive a
    // complete document, and the gaps are filled with the current defaults.
    const { ok, errors, value } = validateConfig(migrateConfig(JSON.parse(row.json)));
    if (!ok) console.warn(`[glassboard] stored configuration needed fixing up: ${errors.join('; ')}`);
    return value;
  } catch (error) {
    // A corrupted revision must not take the whole dashboard down.
    console.error(`[glassboard] latest configuration revision is unreadable (${error.message}), falling back to defaults`);
    return defaultConfig();
  }
}

export function saveConfig(userId, config, note = null) {
  const { ok, errors, value } = validateConfig(config);
  if (!ok) {
    const error = new Error('Invalid configuration');
    error.details = errors;
    throw error;
  }
  db.prepare('INSERT INTO config_revisions (user_id, json, note, created_at) VALUES (?, ?, ?, ?)').run(
    userId,
    JSON.stringify(value),
    note,
    now()
  );
  // The cap is per account, so a busy dashboard cannot push someone else's
  // history out of the table.
  db.prepare(
    `DELETE FROM config_revisions WHERE user_id = ? AND id NOT IN (
       SELECT id FROM config_revisions WHERE user_id = ? ORDER BY id DESC LIMIT ?
     )`
  ).run(userId, userId, KEEP_REVISIONS);
  return value;
}

export function listRevisions(userId) {
  return db
    .prepare('SELECT id, note, created_at FROM config_revisions WHERE user_id = ? ORDER BY id DESC')
    .all(userId);
}

/** A revision, but only if it belongs to the account asking for it. */
export function getRevision(userId, id) {
  return db
    .prepare('SELECT json FROM config_revisions WHERE user_id = ? AND id = ?')
    .get(userId, Number(id)) ?? null;
}

/* ---------------------------- export / import ---------------------------- */

/** Names of the secrets an export may carry, with the label shown to the user. */
const EXPORTABLE_SECRETS = {
  'georide.token': 'GeoRide API token',
  'georide.email': 'GeoRide account email',
  'georide.password': 'GeoRide account password',
  'parcels.17track_key': '17TRACK API key',
  'mail.password': 'Mailbox app password',
};

export function buildExport(userId, { includeSecrets = false, includeWallpaper = true } = {}) {
  const payload = {
    app: 'glassboard',
    formatVersion: EXPORT_FORMAT_VERSION,
    configVersion: CONFIG_VERSION,
    exportedAt: now(),
    containsSecrets: false,
    config: getConfig(userId),
    secrets: null,
    wallpaper: null,
  };

  // The background image travels with the configuration, so restoring on a
  // blank instance gives back the same dashboard rather than a close one.
  if (includeWallpaper) {
    const info = wallpaperInfo(userId);
    if (info && info.bytes <= MAX_BYTES) {
      payload.wallpaper = { mime: info.mime, updatedAt: info.updatedAt, data: readWallpaper(userId).toString('base64') };
    } else if (info) {
      payload.wallpaperOmitted = { reason: 'too large to embed', bytes: info.bytes };
    }
  }

  if (includeSecrets) {
    const secrets = {};
    for (const name of listSecretNames(userId)) {
      if (!(name in EXPORTABLE_SECRETS)) continue;
      const plain = decrypt(getSecret(userId, name));
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

export function writeBackup(userId, reason) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // The account is in the name: several of them now write into one directory,
  // and a snapshot nobody can attribute is a snapshot nobody dares restore.
  const file = path.join(BACKUP_DIR, `config-${stamp}-user${userId}-${reason}.json`);
  fs.writeFileSync(file, JSON.stringify(buildExport(userId, { includeSecrets: false }), null, 2), { mode: 0o600 });
  return file;
}

/**
 * Import a previously exported file.
 * The existing configuration is snapshotted first and nothing is written until
 * the payload has fully validated, so a bad file can never corrupt an instance.
 */
export function importExport(userId, payload, { includeSecrets = false } = {}) {
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

  const backup = writeBackup(userId, 'before-import');
  const restored = { config: false, secrets: [], wallpaper: false };

  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO config_revisions (user_id, json, note, created_at) VALUES (?, ?, ?, ?)').run(
      userId,
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

  if (payload.wallpaper?.data && typeof payload.wallpaper.data === 'string') {
    try {
      saveWallpaper(userId, Buffer.from(payload.wallpaper.data, 'base64'));
      restored.wallpaper = true;
    } catch (error) {
      // A bad image must not undo an otherwise valid import.
      errors.push(`wallpaper: ${error.message}`);
    }
  }

  if (includeSecrets && payload.secrets && typeof payload.secrets === 'object') {
    for (const [name, plain] of Object.entries(payload.secrets)) {
      if (!(name in EXPORTABLE_SECRETS) || typeof plain !== 'string') continue;
      setSecret(userId, name, encrypt(plain));
      restored.secrets.push(name);
    }
  }

  return { backup, restored, warnings: errors };
}
