// Periodic housekeeping.
//
// Everything here grows quietly: cached API responses accumulate one row per
// coordinate the browser ever reported, the tile cache grows with every map
// pan, and SQLite's write-ahead log never shrinks on its own. Left alone on a
// small container, that is the difference between a stable 60 MB and a slow
// creep until the disk is full.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import { DATA_DIR } from './env.js';
import { purgeExpiredSessions, purgeExpiredChallenges } from './auth.js';

const TILE_DIR = path.join(DATA_DIR, 'tiles');
const TILE_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const CACHE_MAX_ROWS = 300;
const INTERVAL_MS = 60 * 60 * 1000;

/** Drop expired entries, then cap the table so it cannot grow without bound. */
function pruneCache() {
  const expired = db.prepare('DELETE FROM cache WHERE expires_at < ?').run(Date.now()).changes;
  const excess = db
    .prepare(
      `DELETE FROM cache WHERE key IN (
         SELECT key FROM cache ORDER BY expires_at DESC LIMIT -1 OFFSET ?
       )`
    )
    .run(CACHE_MAX_ROWS).changes;
  return expired + excess;
}

/** Keep the map tile cache under a fixed size, dropping the least recently written. */
async function pruneTiles() {
  if (!fs.existsSync(TILE_DIR)) return 0;
  const files = [];
  let total = 0;

  const walk = async (dir) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(full);
        files.push({ full, mtime: stat.mtimeMs, size: stat.size });
        total += stat.size;
      }
    }
  };
  await walk(TILE_DIR);
  if (total <= TILE_CACHE_MAX_BYTES) return 0;

  files.sort((a, b) => a.mtime - b.mtime);
  let removed = 0;
  for (const file of files) {
    if (total <= TILE_CACHE_MAX_BYTES * 0.8) break;
    await fsp.rm(file.full, { force: true });
    total -= file.size;
    removed += 1;
  }
  return removed;
}

export async function runMaintenance({ quiet = true } = {}) {
  const cacheRows = pruneCache();
  purgeExpiredSessions();
  purgeExpiredChallenges();
  const tiles = await pruneTiles().catch(() => 0);

  // Fold the write-ahead log back into the database and refresh the planner's
  // statistics. Both are cheap and keep the footprint flat over months.
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA optimize');
  } catch {
    // A checkpoint can be refused while a read is in flight; next hour will do.
  }

  if (!quiet) console.log(`[glassboard] maintenance: ${cacheRows} cache rows, ${tiles} tiles removed`);
  return { cacheRows, tiles };
}

export function scheduleMaintenance() {
  runMaintenance();
  const timer = setInterval(runMaintenance, INTERVAL_MS);
  // Housekeeping must never be the reason the process stays alive.
  timer.unref?.();
  return timer;
}
