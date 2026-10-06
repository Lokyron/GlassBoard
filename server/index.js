// Glassboard HTTP server.
import express from 'express';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, HOST, ROOT_DIR, TRUST_PROXY, DATA_DIR, IS_PRODUCTION } from './env.js';
import { attachUser, needsSetup, requireAuth } from './auth.js';
import { authRouter } from './routes/auth.js';
import { configRouter } from './routes/config.js';
import { updateRouter } from './routes/update.js';
import { adminRouter } from './routes/admin.js';
import { appearanceRouter } from './routes/appearance.js';
import { scheduleMaintenance } from './maintenance.js';
import { mountModules, startModuleJobs } from './modules/registry.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MODULES_DIR = path.join(ROOT, 'modules');
const app = express();

if (TRUST_PROXY) app.set('trust proxy', true);
app.disable('x-powered-by');

/** Minimal cookie parsing — one header, no dependency. */
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      req.cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  next();
});

/* A dashboard configuration is a few kilobytes. Only one route is ever large:
   an import carries the wallpaper inlined as base64. Giving it its own parser
   and capping every other route at a megabyte means nothing else on the
   instance can be made to buffer sixteen of them. The choice is made here
   rather than in the router, because a global parser would have rejected the
   import long before its own parser ever ran. */
const BULK_JSON_PATHS = new Set(['/api/config/import']);
const smallJson = express.json({ limit: '1mb' });
const bulkJson = express.json({ limit: '16mb' });
app.use((req, res, next) => (BULK_JSON_PATHS.has(req.path) ? bulkJson : smallJson)(req, res, next));

// JSON compresses by 80% or more, and a month of GPS tracks is the payload that
// makes it worth it. zlib is built in, so this costs no dependency.
const GZIP_THRESHOLD = 1024;
app.use((req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    const text = JSON.stringify(body);
    if (text.length < GZIP_THRESHOLD || !/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      return sendJson(body);
    }
    zlib.gzip(text, (error, buffer) => {
      if (error) return sendJson(body);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.end(buffer);
    });
    return res;
  };
  next();
});

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
  // Tiles and shortcut targets are the only external resources; everything else
  // is served from this origin. Inline styles are required because tile and
  // shortcut colours are applied through style attributes. form-action allows
  // http: as well, because a self-hosted search engine on the LAN is a normal
  // thing to point the search box at.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'self'; " +
      "base-uri 'none'; form-action 'self' https: http:"
  );
  next();
});

app.use(attachUser);

/* --------------------------------- pages --------------------------------- */

const sendPage = (res, file) => res.sendFile(path.join(PUBLIC_DIR, file));

app.get('/', (req, res) => {
  if (needsSetup()) return res.redirect('/setup');
  if (!req.user) return res.redirect('/login');
  if (!req.user.totp_enabled) return res.redirect('/setup');
  sendPage(res, 'index.html');
});

app.get('/login', (req, res) => {
  if (needsSetup()) return res.redirect('/setup');
  if (req.user && req.user.totp_enabled) return res.redirect('/');
  sendPage(res, 'login.html');
});

// Served whether or not this device is signed in: the page itself says so, and
// the secret it needs lives in the URL fragment, which never reaches us.
app.get('/approve', (req, res) => {
  if (needsSetup()) return res.redirect('/setup');
  sendPage(res, 'approve.html');
});

/* Served to anyone: the person holding an invitation has no session yet, by
   definition. The page shows nothing until the token in its fragment resolves,
   and the token never reaches this server in the URL. */
app.get('/invite', (req, res) => {
  if (needsSetup()) return res.redirect('/setup');
  sendPage(res, 'invite.html');
});

app.get('/setup', (req, res) => {
  if (!needsSetup() && req.user?.totp_enabled) return res.redirect('/');
  if (!needsSetup() && !req.user) return res.redirect('/login');
  sendPage(res, 'setup.html');
});

// index.html is only ever reachable through "/", which enforces authentication.
app.get(['/index.html'], (_req, res) => res.redirect('/'));

/* ---------------------------------- API ---------------------------------- */

app.use('/api/auth', authRouter);
app.use('/api/config', configRouter);
app.use('/api/appearance', appearanceRouter);
app.use('/api/update', updateRouter);
app.use('/api/admin', adminRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true, setupRequired: needsSetup() }));

/* Each module's own routes and its client files. Awaited before the server
   starts listening, so no request can arrive at a half-mounted instance. */
await mountModules(app, {
  express,
  requireAuth,
  modulesDir: MODULES_DIR,
  path,
  staticOptions: { maxAge: IS_PRODUCTION ? '1h' : 0, etag: true },
});

/* -------------------------------- statics -------------------------------- */

// The service worker and the manifest must never be served stale from a cache,
// or an installed app would hold on to an old version.
app.get(['/sw.js', '/manifest.webmanifest'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache');
  next();
});

app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    maxAge: IS_PRODUCTION ? '1h' : 0,
    etag: true,
  })
);

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not_found' });
  res.status(404).send('Not found');
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((error, _req, res, _next) => {
  console.error('[glassboard]', error);
  res.status(500).json({ error: 'internal_error' });
});

/* No configuration is seeded here any more. There is one per account now, and
   the server cannot seed an account that does not exist yet: getConfig does it
   the first time an account asks for its dashboard. */
scheduleMaintenance();
/* Each module's background work. This is what keeps the GeoRide rides and the
   mailbox up to date without a reader having to wait for either. */
startModuleJobs();

const server = app.listen(PORT, HOST, () => {
  // The port the socket actually got, not the one that was asked for: with
  // PORT=0 the kernel picks it, and the line is then the only way to know.
  console.log(`[glassboard] listening on http://${HOST}:${server.address().port}`);
  console.log(`[glassboard] data directory: ${DATA_DIR}`);
  if (needsSetup()) console.log('[glassboard] no account yet — open /setup to create the first one');
});
