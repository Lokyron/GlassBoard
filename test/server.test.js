/* End to end, against a real server in its own process with its own data
   directory: the first-run path (setup, TOTP enrolment), the two-step sign-in,
   the dashboard the session then gets, and the doors that must stay shut. */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate as totpGenerate } from 'otplib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glassboard-e2e-'));

let child;
let base;
/* One jar for the whole file: the point of the exercise is that the cookies
   the server hands out are what carries the session from step to step. */
const jar = new Map();

function remember(response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

async function call(method, path_, body) {
  const response = await fetch(`${base}${path_}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  remember(response);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* a page, not an API answer */ }
  return { status: response.status, headers: response.headers, json, text };
}

const get = (p) => call('GET', p);
const post = (p, body) => call('POST', p, body ?? {});

before(async () => {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dir,
      APP_SECRET: 'end-to-end-secret'.padEnd(64, '0'),
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '0',
      UPDATE_ENABLED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The server prints the address it actually bound, which is how a port of 0
  // becomes usable here.
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the server did not start in time')), 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const match = chunk.match(/listening on (http:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`the server exited with ${code}`)); });
  });
});

after(() => {
  child?.kill('SIGTERM');
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a fresh instance', () => {
  it('reports that it needs setting up', async () => {
    const health = await get('/api/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { ok: true, setupRequired: true });
  });

  it('sends every page to /setup', async () => {
    for (const page of ['/', '/login']) {
      const response = await get(page);
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), '/setup');
    }
  });

  it('sets the security headers on every answer', async () => {
    const response = await get('/api/health');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(response.headers.get('x-powered-by'), null);
  });

  it('refuses a weak password', async () => {
    const response = await post('/api/auth/setup', { username: 'owner', password: 'short' });
    assert.equal(response.status, 400);
  });
});

describe('first run', () => {
  let secret;

  it('creates the first account and asks it to enrol', async () => {
    const response = await post('/api/auth/setup', { username: 'owner', password: 'a good long password' });
    assert.equal(response.status, 200);
    assert.equal(response.json.totpEnrolmentRequired, true);
    assert.ok(jar.has('glassboard_session'), 'a session cookie came back');
  });

  it('refuses a second setup', async () => {
    const response = await post('/api/auth/setup', { username: 'other', password: 'a good long password' });
    assert.equal(response.status, 409);
  });

  it('hands out a secret and a QR code', async () => {
    const response = await post('/api/auth/totp/start');
    assert.equal(response.status, 200);
    assert.ok(response.json.secret);
    assert.match(response.json.qr, /^data:image\/png;base64,/);
    secret = response.json.secret;
  });

  it('refuses a wrong code and accepts the right one', async () => {
    assert.equal((await post('/api/auth/totp/confirm', { token: '000000' })).status, 400);
    const response = await post('/api/auth/totp/confirm', { token: await totpGenerate({ secret }) });
    assert.equal(response.status, 200);
    assert.equal(response.json.recoveryCodes.length, 10);
  });

  it('now serves the dashboard', async () => {
    const response = await get('/');
    assert.equal(response.status, 200);
    assert.match(response.text, /<title>Dashboard<\/title>/);
  });

  it('seeds a configuration on the first read', async () => {
    const response = await get('/api/config');
    assert.equal(response.status, 200);
    assert.ok(response.json.config.site);
    assert.ok(Array.isArray(response.json.config.tiles));
    assert.ok(response.json.tileTypes, 'the client is told which tile types exist');
  });

  describe('signing in again', () => {
    it('takes two steps, and the first opens no session', async () => {
      await post('/api/auth/logout');
      assert.equal((await get('/api/config')).status, 401);

      const first = await post('/api/auth/login', { username: 'owner', password: 'a good long password' });
      assert.equal(first.status, 200);
      assert.equal(first.json.step, 'otp');
      assert.equal(jar.has('glassboard_session'), false, 'the password alone opens nothing');
      assert.ok(jar.has('glassboard_pending'));

      assert.equal((await get('/api/config')).status, 401);

      const bad = await post('/api/auth/login/verify', { token: '000000' });
      assert.equal(bad.status, 401);

      const second = await post('/api/auth/login/verify', { token: await totpGenerate({ secret }) });
      assert.equal(second.status, 200);
      assert.ok(jar.has('glassboard_session'));
      assert.equal((await get('/api/config')).status, 200);
    });

    it('says nothing about whether an account exists', async () => {
      const unknown = await post('/api/auth/login', { username: 'nobody', password: 'a good long password' });
      const wrong = await post('/api/auth/login', { username: 'owner', password: 'the wrong password' });
      assert.equal(unknown.status, 401);
      assert.equal(wrong.status, 401);
      assert.equal(unknown.json.error, wrong.json.error);
    });
  });

  describe('saving', () => {
    it('writes a configuration back and keeps a revision', async () => {
      const before_ = (await get('/api/config')).json.config;
      before_.site.title = 'Changed by the suite';
      const saved = await call('PUT', '/api/config', { config: before_ });
      assert.equal(saved.status, 200);
      assert.equal((await get('/api/config')).json.config.site.title, 'Changed by the suite');
      const revisions = await get('/api/config/revisions');
      assert.ok(revisions.json.revisions.length >= 1);
    });

    it('refuses a configuration that is not one', async () => {
      const response = await call('PUT', '/api/config', { config: { tiles: 'not a list' } });
      assert.equal(response.status, 400);
    });
  });
});

describe('module routes', () => {
  it('needs a session like everything else', async () => {
    const saved = new Map(jar);
    jar.clear();
    assert.equal((await get('/api/m/weather/place?latitude=48&longitude=2')).status, 401);
    saved.forEach((v, k) => jar.set(k, v));
  });

  it('answers from its own prefix, and says so when switched off', async () => {
    /* With the integration off, both routes answer without reaching
       Open-Meteo — which is what makes this assertable offline. */
    const config = (await get('/api/config')).json.config;
    config.integrations.weather.enabled = false;
    assert.equal((await call('PUT', '/api/config', { config })).status, 200);

    assert.equal((await get('/api/m/weather/forecast')).status, 404);
    const place = await get('/api/m/weather/place?latitude=48&longitude=2');
    assert.equal(place.status, 200);
    assert.equal(place.json.name, '');

    config.integrations.weather.enabled = true;
    await call('PUT', '/api/config', { config });
  });

  it('serves every module\'s tile at the URL the registry imports', async () => {
    /* public/assets/core/tiles.js builds `/modules/<id>/tile.js`; the server
       mounts each module's client/ folder at `/modules/<id>`. The two have to
       agree, and nothing but this says so — a mismatch is a feature that
       silently does not load. */
    for (const moduleId of ['weather', 'georide', 'parcels', 'note']) {
      const response = await get(`/modules/${moduleId}/tile.js`);
      assert.equal(response.status, 200, `/modules/${moduleId}/tile.js`);
      assert.match(response.text, /export default/);
    }
  });

  it('serves a module\'s client folder and nothing beside it', async () => {
    // manifest.js, server.js, jobs.js and worker.js share the module folder
    // with client/. Only client/ is mounted, and this is what proves it.
    for (const leak of ['/modules/weather/manifest.js', '/modules/weather/server.js', '/modules/weather/../manifest.js']) {
      const response = await get(leak);
      assert.notEqual(response.status, 200, `${leak} must not be served`);
    }
  });

  it('no longer answers on the old integrations prefix', async () => {
    for (const route of ['/api/integrations/weather/forecast', '/api/integrations/georide/summary', '/api/integrations/parcels']) {
      assert.equal((await get(route)).status, 404, route);
    }
  });

  it('does not let "/:id" swallow a literal path beside it', async () => {
    /* DELETE /parcels/:id was declared before DELETE /parcels/key, so
       removing a 17TRACK key from the settings answered "Unknown parcel"
       and the key stayed. The literal paths come first now. */
    const response = await call('DELETE', '/api/m/parcels/key');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { ok: true });
  });

  it('keeps the map tiles with the module that draws maps', async () => {
    // Out of range, so nothing is fetched upstream: what is asserted is that
    // the route exists where the GeoRide client now looks for it.
    const response = await get('/api/m/georide/map/tile/99/0/0.png');
    assert.equal(response.status, 400);
  });
});

describe('doors that stay shut', () => {
  it('an unknown API path answers 404 as JSON', async () => {
    const response = await get('/api/nothing-here');
    assert.equal(response.status, 404);
    assert.deepEqual(response.json, { error: 'not_found' });
  });

  it('/index.html is never served directly', async () => {
    const response = await get('/index.html');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/');
  });

  it('no API route answers 409 to a signed-in dashboard', async () => {
    /* app.js reads 409 as "this instance needs setting up" and leaves the page
       for /setup. A route answering it to a working session would throw the
       reader out of their own dashboard. */
    for (const route of ['/api/config', '/api/config/revisions', '/api/update', '/api/auth/me']) {
      const response = await get(route);
      assert.notEqual(response.status, 409, `${route} must not answer 409`);
    }
  });
});
