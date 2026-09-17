// Glassboard HTTP server.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, HOST, ROOT_DIR, TRUST_PROXY, DATA_DIR, IS_PRODUCTION } from './env.js';
import { attachUser, needsSetup } from './auth.js';
import { authRouter } from './routes/auth.js';
import { configRouter } from './routes/config.js';
import { integrationsRouter } from './routes/integrations.js';
import { getConfig } from './store.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
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

app.use(express.json({ limit: '4mb' }));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
  // Tiles and shortcut targets are the only external resources; everything else
  // is served from this origin. Inline styles are required because tile and
  // shortcut colours are applied through style attributes.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'self'; " +
      "base-uri 'none'; form-action 'self' https:"
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
app.use('/api/integrations', integrationsRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true, setupRequired: needsSetup() }));

/* -------------------------------- statics -------------------------------- */

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

// Seed the default configuration on a fresh instance before accepting traffic.
getConfig();

app.listen(PORT, HOST, () => {
  console.log(`[glassboard] listening on http://${HOST}:${PORT}`);
  console.log(`[glassboard] data directory: ${DATA_DIR}`);
  if (needsSetup()) console.log('[glassboard] no account yet — open /setup to create the first one');
});
