// Environment loading. Reads .env (if present) without pulling in a dependency.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const num = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const ROOT_DIR = ROOT;
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const IS_PRODUCTION = NODE_ENV === 'production';
export const PORT = num(process.env.PORT, 3000);
export const HOST = process.env.HOST || '127.0.0.1';
export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || './data');
export const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
export const COOKIE_SECURE = (process.env.COOKIE_SECURE || 'auto').toLowerCase();
export const SESSION_TTL_HOURS = num(process.env.SESSION_TTL_HOURS, 720);
export const LOGIN_MAX_ATTEMPTS = num(process.env.LOGIN_MAX_ATTEMPTS, 5);
export const LOGIN_LOCKOUT_MINUTES = num(process.env.LOGIN_LOCKOUT_MINUTES, 15);
export const OSM_CONTACT = process.env.OSM_CONTACT || '';

// In-app updates. Off unless the host wired the updater (see deploy/): the app
// only ever writes a request file, it never touches its own code.
export const UPDATE_ENABLED = process.env.UPDATE_ENABLED === '1' || process.env.UPDATE_ENABLED === 'true';
export const UPDATE_REPO = process.env.UPDATE_REPO || 'Lokyron/GlassBoard';
export const UPDATE_BRANCH = process.env.UPDATE_BRANCH || 'main';
export const UPDATE_CHECK_HOURS = num(process.env.UPDATE_CHECK_HOURS, 24);

fs.mkdirSync(DATA_DIR, { recursive: true });

// APP_SECRET is mandatory in production: it protects sessions and the stored
// integration credentials. In development we generate one once and keep it in
// the data directory so restarts do not invalidate everything.
function resolveSecret() {
  const fromEnv = process.env.APP_SECRET;
  if (fromEnv && fromEnv.length >= 16 && fromEnv !== 'replace-me-with-a-long-random-string') {
    return fromEnv;
  }
  if (IS_PRODUCTION) {
    console.error(
      '[glassboard] APP_SECRET is missing or too short. Set it in .env before starting in production.\n' +
        '            Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
    process.exit(1);
  }
  const file = path.join(DATA_DIR, '.dev-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, generated, { mode: 0o600 });
  console.warn('[glassboard] No APP_SECRET set — generated a development secret in ' + file);
  return generated;
}

export const APP_SECRET = resolveSecret();
