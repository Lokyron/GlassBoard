/* Test support: every file gets its own data directory and its own secret, so
   the suite never reads or writes a real installation and the files can run in
   any order. Set before anything imports env.js, which resolves DATA_DIR once
   at import time. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function isolate(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `glassboard-${name}-`));
  process.env.DATA_DIR = dir;
  process.env.APP_SECRET = 'test-secret-'.padEnd(64, '0');
  process.env.NODE_ENV = 'test';
  // An installation that offers updates would reach for the network on boot.
  process.env.UPDATE_ENABLED = '0';
  return dir;
}

export const removeDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });
