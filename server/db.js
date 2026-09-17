// SQLite storage. Uses node:sqlite from the standard library, so there is no
// native module to compile at install time.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { DATA_DIR } from './env.js';

const DB_FILE = path.join(DATA_DIR, 'glassboard.db');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_FILE);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The dashboard configuration is a single JSON document. Every save appends a
-- revision, which makes rollback and export trivial.
CREATE TABLE IF NOT EXISTS config_revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  json       TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret   TEXT,
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

-- Short-lived proof that the password step succeeded. It is NOT a session:
-- it only allows presenting a second factor, once, within a few minutes.
CREATE TABLE IF NOT EXISTS login_challenges (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket  TEXT NOT NULL,
  at      TEXT NOT NULL,
  success INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_bucket ON login_attempts(bucket, at);

-- Integration credentials, encrypted with APP_SECRET.
CREATE TABLE IF NOT EXISTS secrets (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Upstream API responses, so integrations never hammer third-party services.
CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`);

export const now = () => new Date().toISOString();

export function getMeta(key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

/* ----------------------------- secrets ---------------------------------- */

export function setSecret(name, encryptedValue) {
  if (encryptedValue === null) {
    db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
    return;
  }
  db.prepare(
    `INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(name, encryptedValue, now());
}

export function getSecret(name) {
  const row = db.prepare('SELECT value FROM secrets WHERE name = ?').get(name);
  return row ? row.value : null;
}

export function listSecretNames() {
  return db.prepare('SELECT name FROM secrets ORDER BY name').all().map((r) => r.name);
}

/* ------------------------------ cache ----------------------------------- */

export function cacheGet(key) {
  const row = db.prepare('SELECT value, expires_at FROM cache WHERE key = ?').get(key);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM cache WHERE key = ?').run(key);
    return null;
  }
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

/** Returns a cached entry even when expired — used to degrade gracefully when an API is down. */
export function cacheGetStale(key) {
  const row = db.prepare('SELECT value, expires_at FROM cache WHERE key = ?').get(key);
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value), stale: row.expires_at < Date.now() };
  } catch {
    return null;
  }
}

export function cacheSet(key, value, ttlSeconds) {
  db.prepare(
    `INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
  ).run(key, JSON.stringify(value), Date.now() + ttlSeconds * 1000);
}

export function cacheDeletePrefix(prefix) {
  db.prepare("DELETE FROM cache WHERE key LIKE ? || '%'").run(prefix);
}
