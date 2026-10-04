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
-- Keep the write-ahead log from growing without bound on a small container.
PRAGMA journal_size_limit = 8388608;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The dashboard configuration is a single JSON document, one per account.
-- Every save appends a revision, which makes rollback and export trivial.
-- ON DELETE CASCADE is what makes removing an account complete: its dashboard,
-- its secrets, its parcels and its suggestions all go with it, in one step.
CREATE TABLE IF NOT EXISTS config_revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  json       TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL
);

-- One row per account. The first one ever created is the administrator; the
-- role can be handed to others afterwards, and taken back, as long as one
-- administrator is always left standing.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'user',
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

-- A sign-in waiting to be approved from a device that is already trusted.
-- The browser showing the QR code only ever learns the id, which grants
-- nothing but the right to wait. The power to approve lives in the secret, and
-- the secret travels only inside the QR code, so a stolen id cannot approve
-- itself. Only the hash is stored, like a password.
CREATE TABLE IF NOT EXISTS login_requests (
  id          TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  client_ip   TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  approved_at TEXT,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket  TEXT NOT NULL,
  at      TEXT NOT NULL,
  success INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_bucket ON login_attempts(bucket, at);

-- Integration credentials, encrypted with APP_SECRET, one set per account:
-- two people on one instance follow two GeoRide accounts and two mailboxes.
CREATE TABLE IF NOT EXISTS secrets (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, name)
);

-- Parcels being followed. Kept out of the configuration document on purpose:
-- they come and go every week, and a config revision per parcel would bury the
-- real dashboard history. The info column holds the last normalised answer
-- from the provider, so the tile still renders when that API is unreachable.
CREATE TABLE IF NOT EXISTS parcels (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT '',
  tracking_no TEXT NOT NULL DEFAULT '',
  carrier     INTEGER,
  provider    TEXT NOT NULL DEFAULT '17track',
  url         TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT '',
  info        TEXT,
  registered  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  checked_at  TEXT
);

-- Tracking numbers found in the mailbox, waiting for a yes or a no. They are
-- not parcels: registering one with the provider costs a credit, so nothing is
-- followed until the user says so. An ignored row is kept, which is what stops
-- the same number being proposed at every scan.
CREATE TABLE IF NOT EXISTS parcel_suggestions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tracking_no  TEXT NOT NULL,
  carrier_name TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL DEFAULT '',
  sender       TEXT NOT NULL DEFAULT '',
  uid          INTEGER,
  state        TEXT NOT NULL DEFAULT 'new',
  created_at   TEXT NOT NULL
);

-- An account that does not exist yet. Only the hash of the token is stored,
-- like a password: the token itself lives in the link that was sent and
-- nowhere else, so a copy of this table does not let anyone in. Single use,
-- and it expires. invited_by is kept to say who to ask about it, and survives
-- that person's account being deleted, hence ON DELETE SET NULL.
CREATE TABLE IF NOT EXISTS invitations (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  username   TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  role       TEXT NOT NULL DEFAULT 'user',
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  sent_to    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_invitations_expiry ON invitations(expires_at);

-- Upstream API responses, so integrations never hammer third-party services.
CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`);

/** Add a column to a table that already exists, once.
 *  The schema above uses CREATE TABLE IF NOT EXISTS, which does nothing at all
 *  to a table that is already there, so a column added in a later version
 *  needs this to reach instances that were installed before it. */
function addColumn(table, column, definition) {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((row) => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// 1.8.0: the session list in the settings needs to say when a session was last
// used and how it was opened.
addColumn('sessions', 'last_seen_at', 'TEXT');
addColumn('sessions', 'origin', "TEXT NOT NULL DEFAULT 'password'");

/* ------------------------- multi-account migration ------------------------
   Everything above is what a fresh database gets. An instance installed before
   accounts existed has the old single-tenant tables, which CREATE TABLE IF NOT
   EXISTS leaves completely alone, so they are rebuilt here and their rows
   handed to the first account — the one that becomes the administrator.

   Rebuilding rather than ALTERing is not a preference: SQLite cannot add a
   column to a primary key, and `secrets` and `parcel_suggestions` both need
   their key widened by the account. The whole thing runs in one transaction
   with foreign keys off, which is what the SQLite manual prescribes for a
   table rebuild, and it is driven off the shape of the tables rather than a
   version number, so running it twice does nothing the second time. */

const hasColumn = (table, column) =>
  db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().some((row) => row.name === column);

const tableExists = (table) =>
  Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));

/** Rebuild one table under a new definition, carrying its rows over. */
function rebuild(table, createSql, columns, selectSql) {
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
  db.exec(createSql);
  db.exec(`INSERT INTO ${table} (${columns}) ${selectSql}`);
  db.exec(`DROP TABLE ${table}_old`);
}

function migrateToAccounts() {
  addColumn('users', 'role', "TEXT NOT NULL DEFAULT 'user'");
  addColumn('users', 'email', "TEXT NOT NULL DEFAULT ''");

  const needsRebuild = ['config_revisions', 'parcels', 'parcel_suggestions', 'secrets']
    .filter((table) => tableExists(table) && !hasColumn(table, 'user_id'));
  if (needsRebuild.length === 0) {
    ensureAnAdminExists();
    return;
  }

  // Whoever got here first owns what the instance already holds.
  const owner = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  if (!owner) {
    // No account was ever created, so there is nothing to hand over. The only
    // rows that can exist are the default configuration seeded at boot by a
    // previous version, which has no owner and no longer has a meaning.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      for (const table of needsRebuild) db.exec(`DROP TABLE ${table}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    db.exec('PRAGMA foreign_keys = ON');
    console.log('[glassboard] empty pre-accounts database: tables recreated on next start');
    return;
  }

  console.log(`[glassboard] migrating to multiple accounts; existing data goes to user ${owner.id}`);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    if (needsRebuild.includes('config_revisions')) {
      rebuild(
        'config_revisions',
        `CREATE TABLE config_revisions (
           id         INTEGER PRIMARY KEY AUTOINCREMENT,
           user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           json       TEXT NOT NULL,
           note       TEXT,
           created_at TEXT NOT NULL
         )`,
        'id, user_id, json, note, created_at',
        `SELECT id, ${owner.id}, json, note, created_at FROM config_revisions_old`
      );
      db.exec('CREATE INDEX IF NOT EXISTS idx_config_user ON config_revisions(user_id, id)');
    }

    if (needsRebuild.includes('secrets')) {
      rebuild(
        'secrets',
        `CREATE TABLE secrets (
           user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           name       TEXT NOT NULL,
           value      TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           PRIMARY KEY (user_id, name)
         )`,
        'user_id, name, value, updated_at',
        `SELECT ${owner.id}, name, value, updated_at FROM secrets_old`
      );
    }

    if (needsRebuild.includes('parcels')) {
      rebuild(
        'parcels',
        `CREATE TABLE parcels (
           id          TEXT PRIMARY KEY,
           user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           label       TEXT NOT NULL DEFAULT '',
           tracking_no TEXT NOT NULL DEFAULT '',
           carrier     INTEGER,
           provider    TEXT NOT NULL DEFAULT '17track',
           url         TEXT NOT NULL DEFAULT '',
           status      TEXT NOT NULL DEFAULT '',
           info        TEXT,
           registered  INTEGER NOT NULL DEFAULT 0,
           created_at  TEXT NOT NULL,
           updated_at  TEXT NOT NULL,
           checked_at  TEXT
         )`,
        'id, user_id, label, tracking_no, carrier, provider, url, status, info, registered, created_at, updated_at, checked_at',
        `SELECT id, ${owner.id}, label, tracking_no, carrier, provider, url, status, info, registered,
                created_at, updated_at, checked_at FROM parcels_old`
      );
      db.exec('CREATE INDEX IF NOT EXISTS idx_parcels_created ON parcels(user_id, created_at)');
    }

    if (needsRebuild.includes('parcel_suggestions')) {
      rebuild(
        'parcel_suggestions',
        `CREATE TABLE parcel_suggestions (
           id           TEXT PRIMARY KEY,
           user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           tracking_no  TEXT NOT NULL,
           carrier_name TEXT NOT NULL DEFAULT '',
           label        TEXT NOT NULL DEFAULT '',
           sender       TEXT NOT NULL DEFAULT '',
           uid          INTEGER,
           state        TEXT NOT NULL DEFAULT 'new',
           created_at   TEXT NOT NULL
         )`,
        'id, user_id, tracking_no, carrier_name, label, sender, uid, state, created_at',
        `SELECT id, ${owner.id}, tracking_no, carrier_name, label, sender, uid, state, created_at
           FROM parcel_suggestions_old`
      );
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestions_number ON parcel_suggestions(user_id, tracking_no)');
    }

    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(owner.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.exec('PRAGMA foreign_keys = ON');
    throw error;
  }
  // Outside the transaction: a foreign key violation left behind by the copy
  // would be found here rather than at some unrelated write months later.
  const broken = db.prepare('PRAGMA foreign_key_check').all();
  db.exec('PRAGMA foreign_keys = ON');
  if (broken.length > 0) {
    throw new Error(`migration left ${broken.length} dangling reference(s); database not touched further`);
  }

  // The background image moves to its owner, both the file and its metadata.
  const legacy = path.join(DATA_DIR, 'wallpaper.bin');
  if (fs.existsSync(legacy)) {
    fs.renameSync(legacy, path.join(DATA_DIR, `wallpaper-${owner.id}.bin`));
    for (const key of ['mime', 'updated_at']) {
      const value = getMeta(`wallpaper.${key}`);
      if (value) {
        setMeta(`wallpaper.${owner.id}.${key}`, value);
        setMeta(`wallpaper.${key}`, '');
      }
    }
  }
  console.log('[glassboard] migration done');
}

/** An instance must never be left without an administrator: if the role is
 *  missing from every account — an upgrade interrupted halfway, a role taken
 *  away by hand in the database — the oldest account gets it back. */
function ensureAnAdminExists() {
  const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  if (admins > 0) return;
  const oldest = db.prepare('SELECT id, username FROM users ORDER BY id LIMIT 1').get();
  if (!oldest) return;
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(oldest.id);
  console.log(`[glassboard] no administrator found; "${oldest.username}" has been made one`);
}

migrateToAccounts();

/* Indexes on the per-account column, created once the column is certain to be
   there — which is only true after the migration, never before it. */
db.exec(`
CREATE INDEX IF NOT EXISTS idx_config_user ON config_revisions(user_id, id);
CREATE INDEX IF NOT EXISTS idx_parcels_created ON parcels(user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestions_number ON parcel_suggestions(user_id, tracking_no);
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
/* Every one of these takes the account it belongs to. That is the whole point
   of the migration above: two people on one instance follow two GeoRide
   accounts, two 17TRACK quotas and two mailboxes, and neither can read the
   other's credentials even by accident. */

export function setSecret(userId, name, encryptedValue) {
  if (encryptedValue === null) {
    db.prepare('DELETE FROM secrets WHERE user_id = ? AND name = ?').run(userId, name);
    return;
  }
  db.prepare(
    `INSERT INTO secrets (user_id, name, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(userId, name, encryptedValue, now());
}

export function getSecret(userId, name) {
  const row = db.prepare('SELECT value FROM secrets WHERE user_id = ? AND name = ?').get(userId, name);
  return row ? row.value : null;
}

export function listSecretNames(userId) {
  return db.prepare('SELECT name FROM secrets WHERE user_id = ? ORDER BY name').all(userId).map((r) => r.name);
}

/* ----------------------------- parcels ---------------------------------- */

export function listParcelRows(userId) {
  return db.prepare('SELECT * FROM parcels WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

export function getParcelRow(userId, id) {
  return db.prepare('SELECT * FROM parcels WHERE user_id = ? AND id = ?').get(userId, id) ?? null;
}

export function findParcelByNumber(userId, trackingNumber) {
  if (!trackingNumber) return null;
  return db
    .prepare('SELECT * FROM parcels WHERE user_id = ? AND tracking_no = ? COLLATE NOCASE')
    .get(userId, trackingNumber) ?? null;
}

export function insertParcelRow(row) {
  db.prepare(
    `INSERT INTO parcels (id, user_id, label, tracking_no, carrier, provider, url, status, info, registered, created_at, updated_at, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id, row.user_id, row.label, row.tracking_no, row.carrier ?? null, row.provider, row.url,
    row.status, row.info ?? null, row.registered ? 1 : 0, row.created_at, row.updated_at, row.checked_at ?? null
  );
}

/** Store the latest normalised answer for a parcel. */
export function updateParcelInfo(userId, id, { status, info, carrier = null, checkedAt }) {
  db.prepare(
    `UPDATE parcels SET status = ?, info = ?, carrier = COALESCE(?, carrier), checked_at = ?, updated_at = ?
     WHERE user_id = ? AND id = ?`
  ).run(status, info === null ? null : JSON.stringify(info), carrier, checkedAt, now(), userId, id);
}

export function deleteParcelRow(userId, id) {
  db.prepare('DELETE FROM parcels WHERE user_id = ? AND id = ?').run(userId, id);
}

/* -------------------------- parcel suggestions --------------------------- */

export function listSuggestionRows(userId) {
  return db.prepare('SELECT * FROM parcel_suggestions WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

export function getSuggestionRow(userId, id) {
  return db.prepare('SELECT * FROM parcel_suggestions WHERE user_id = ? AND id = ?').get(userId, id) ?? null;
}

export function insertSuggestionRow(row) {
  db.prepare(
    `INSERT INTO parcel_suggestions (id, user_id, tracking_no, carrier_name, label, sender, uid, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, tracking_no) DO NOTHING`
  ).run(row.id, row.user_id, row.tracking_no, row.carrier_name, row.label, row.sender, row.uid ?? null, row.state, row.created_at);
}

export function setSuggestionState(userId, id, state) {
  db.prepare('UPDATE parcel_suggestions SET state = ? WHERE user_id = ? AND id = ?').run(state, userId, id);
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
