// OpenStreetMap raster tile proxy with an on-disk cache.
// Going through the server keeps the viewer's IP away from the tile provider
// and keeps the dashboard usable on a network that only allows the app itself.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from '../env.js';
import { userAgent } from './weather.js';

const TILE_DIR = path.join(DATA_DIR, 'tiles');
const UPSTREAM = 'https://tile.openstreetmap.org';
const MAX_ZOOM = 19;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/* How many tiles this instance will fetch from OpenStreetMap at once.
 *
 * Opening a map asks for a hundred-odd tiles in the same instant, and they all
 * used to leave together. OpenStreetMap's tile policy asks for restraint and
 * answers a burst with throttling, which is a map that fills in slowly and in
 * no particular order — exactly what "struggling to draw" looks like. Six is
 * enough to keep a cold map filling quickly and few enough to stay a polite
 * client. Cached tiles never queue: the limit is on going upstream. */
const MAX_UPSTREAM = 6;

let active = 0;
const waiting = [];

function acquire() {
  if (active < MAX_UPSTREAM) { active += 1; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();          // hands the slot straight over
  else active -= 1;
}

/* One fetch per tile, however many ask for it. Panning back over an area the
   browser has forgotten asks for the same tiles again, and without this each
   request would be its own download. */
const inFlight = new Map();

fs.mkdirSync(TILE_DIR, { recursive: true });

export function isValidTile(z, x, y) {
  if (![z, x, y].every((n) => Number.isInteger(n) && n >= 0)) return false;
  if (z > MAX_ZOOM) return false;
  const max = 2 ** z;
  return x < max && y < max;
}

/** @returns {Promise<Buffer>} the PNG bytes for a tile, from cache when possible. */
export async function getTile(z, x, y) {
  const file = path.join(TILE_DIR, String(z), String(x), `${y}.png`);
  try {
    const stat = await fsp.stat(file);
    if (Date.now() - stat.mtimeMs < MAX_AGE_MS) return await fsp.readFile(file);
  } catch {
    // Not cached yet.
  }

  const key = `${z}/${x}/${y}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = fetchTile(file, z, x, y).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/** The part that goes upstream, behind the concurrency limit. */
async function fetchTile(file, z, x, y) {
  await acquire();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${UPSTREAM}/${z}/${x}/${y}.png`, {
      signal: controller.signal,
      headers: { 'User-Agent': userAgent(), Accept: 'image/png' },
    });
    if (!response.ok) throw new Error(`tile server responded ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, buffer);
    return buffer;
  } catch (error) {
    // Serve an expired tile rather than a hole in the map.
    try {
      return await fsp.readFile(file);
    } catch {
      throw error;
    }
  } finally {
    clearTimeout(timer);
    release();
  }
}
