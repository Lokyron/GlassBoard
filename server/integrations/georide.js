// GeoRide integration.
//
// Endpoints used, from the official API documentation at https://api.georide.fr :
//   POST /user/login                              -> { authToken }  (valid 30 days)
//   GET  /user/new-token                          -> { authToken }
//   GET  /user/trackers                           -> trackers with their current position
//   GET  /tracker/:id/trips?from=&to=             -> trips (distance m, duration ms, averageSpeed knots)
//   GET  /tracker/:id/trips/positions?from=&to=   -> positions (speed in knots)
//
// The token never leaves the server: the browser only ever sees the computed
// summary. Credentials are stored encrypted with APP_SECRET.
import { getSecret, setSecret, cacheGet, cacheGetStale, cacheSet, cacheDeletePrefix, getMeta, setMeta } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';

const BASE_URL = 'https://api.georide.fr';
const KNOTS_TO_KMH = 1.852;
const TOKEN_LIFETIME_DAYS = 30;
const REFRESH_AFTER_DAYS = 20; // renew well before the 30-day expiry

const SECRET_EMAIL = 'georide.email';
const SECRET_PASSWORD = 'georide.password';
const SECRET_TOKEN = 'georide.token';
const META_TOKEN_ISSUED = 'georide.token_issued_at';

export const knotsToKmh = (knots) => (Number(knots) || 0) * KNOTS_TO_KMH;

async function request(path, { method = 'GET', token = null, body = null, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Glassboard/1.0',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = new Error(payload?.message || `GeoRide API returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ credentials ------------------------------ */

export function isConfigured() {
  return Boolean(getSecret(SECRET_TOKEN) || (getSecret(SECRET_EMAIL) && getSecret(SECRET_PASSWORD)));
}

export function credentialStatus() {
  const issuedAt = getMeta(META_TOKEN_ISSUED);
  return {
    configured: isConfigured(),
    hasStoredPassword: Boolean(getSecret(SECRET_PASSWORD)),
    email: decrypt(getSecret(SECRET_EMAIL)) || '',
    tokenIssuedAt: issuedAt,
    tokenExpiresAt: issuedAt
      ? new Date(new Date(issuedAt).getTime() + TOKEN_LIFETIME_DAYS * 86_400_000).toISOString()
      : null,
  };
}

/** Log in and store the token. `rememberPassword` allows silent re-login after expiry. */
export async function login(email, password, { rememberPassword = true } = {}) {
  const data = await request('/user/login', { method: 'POST', body: { email, password } });
  if (!data?.authToken) throw new Error('GeoRide did not return a token.');
  setSecret(SECRET_TOKEN, encrypt(data.authToken));
  setSecret(SECRET_EMAIL, encrypt(email));
  setSecret(SECRET_PASSWORD, rememberPassword ? encrypt(password) : null);
  setMeta(META_TOKEN_ISSUED, new Date().toISOString());
  cacheDeletePrefix('georide:');
  return data.authToken;
}

export function forgetCredentials() {
  setSecret(SECRET_TOKEN, null);
  setSecret(SECRET_EMAIL, null);
  setSecret(SECRET_PASSWORD, null);
  setMeta(META_TOKEN_ISSUED, '');
  cacheDeletePrefix('georide:');
}

function storedToken() {
  return decrypt(getSecret(SECRET_TOKEN));
}

async function renewToken(token) {
  const data = await request('/user/new-token', { token });
  if (!data?.authToken) throw new Error('GeoRide did not return a renewed token.');
  setSecret(SECRET_TOKEN, encrypt(data.authToken));
  setMeta(META_TOKEN_ISSUED, new Date().toISOString());
  return data.authToken;
}

async function reLogin() {
  const email = decrypt(getSecret(SECRET_EMAIL));
  const password = decrypt(getSecret(SECRET_PASSWORD));
  if (!email || !password) {
    const error = new Error('GeoRide session expired. Sign in again from the settings panel.');
    error.code = 'reauth_required';
    throw error;
  }
  return login(email, password);
}

/** Get a usable token, renewing or re-logging in as needed. */
async function getToken() {
  let token = storedToken();
  if (!token) return reLogin();

  const issuedAt = getMeta(META_TOKEN_ISSUED);
  if (issuedAt) {
    const ageDays = (Date.now() - new Date(issuedAt).getTime()) / 86_400_000;
    if (ageDays > REFRESH_AFTER_DAYS) {
      try {
        token = await renewToken(token);
      } catch {
        token = await reLogin();
      }
    }
  }
  return token;
}

/** Call the API, transparently recovering from an expired token. */
async function authed(path) {
  let token = await getToken();
  try {
    return await request(path, { token });
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) throw error;
    token = await reLogin();
    return request(path, { token });
  }
}

/* -------------------------------- queries -------------------------------- */

export async function listTrackers() {
  const data = await authed('/user/trackers');
  const trackers = Array.isArray(data) ? data : data?.trackers ?? [];
  return trackers.map((t) => ({
    trackerId: t.trackerId,
    trackerName: t.trackerName,
    model: t.model,
    status: t.status,
  }));
}

function summariseTrips(trips, periodStart) {
  const list = Array.isArray(trips) ? trips : trips?.trips ?? [];
  let distanceMeters = 0;
  let durationMs = 0;
  let bestAverageKnots = 0;
  for (const trip of list) {
    distanceMeters += Number(trip.distance) || 0;
    durationMs += Number(trip.duration) || 0;
    bestAverageKnots = Math.max(bestAverageKnots, Number(trip.averageSpeed) || 0);
  }
  return {
    periodStart,
    tripCount: list.length,
    distanceKm: Math.round((distanceMeters / 1000) * 10) / 10,
    durationMinutes: Math.round(durationMs / 60_000),
    bestAverageSpeedKmh: Math.round(knotsToKmh(bestAverageKnots)),
    lastTripAt: list.length ? list[list.length - 1].endTime ?? null : null,
  };
}

/**
 * Everything the GeoRide tile needs, in one cached payload.
 * Returns `{ ok: false, error }` rather than throwing, so a failing API degrades
 * the tile instead of breaking the dashboard.
 */
export async function getSummary({ trackerId = null, periodDays = 7, refreshMinutes = 5 } = {}) {
  if (!isConfigured()) {
    return { ok: false, configured: false, error: 'GeoRide is not configured yet.' };
  }
  const key = `georide:summary:${trackerId ?? 'auto'}:${periodDays}`;
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  try {
    const trackersPayload = await authed('/user/trackers');
    const trackers = Array.isArray(trackersPayload) ? trackersPayload : trackersPayload?.trackers ?? [];
    if (trackers.length === 0) throw new Error('No tracker is attached to this GeoRide account.');

    const tracker =
      (trackerId && trackers.find((t) => Number(t.trackerId) === Number(trackerId))) || trackers[0];

    const to = new Date();
    const from = new Date(to.getTime() - periodDays * 86_400_000);
    const range = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;

    const trips = await authed(`/tracker/${tracker.trackerId}/trips?${range}`);
    const stats = summariseTrips(trips, from.toISOString());

    // The API exposes no per-trip maximum speed, only averageSpeed, so the real
    // top speed is derived from the individual positions of the period.
    let topSpeedKmh = stats.bestAverageSpeedKmh;
    try {
      const positionsPayload = await authed(`/tracker/${tracker.trackerId}/trips/positions?${range}`);
      const positions = Array.isArray(positionsPayload)
        ? positionsPayload
        : positionsPayload?.positions ?? [];
      const maxKnots = positions.reduce((max, p) => Math.max(max, Number(p.speed) || 0), 0);
      if (maxKnots > 0) topSpeedKmh = Math.round(knotsToKmh(maxKnots));
    } catch {
      // Optional refinement — keep the average-based figure if it fails.
    }

    const payload = {
      ok: true,
      configured: true,
      tracker: {
        id: tracker.trackerId,
        name: tracker.trackerName || 'Tracker',
        status: tracker.status || null,
        moving: Boolean(tracker.moving),
        isLocked: Boolean(tracker.isLocked),
        odometerKm: Math.round((Number(tracker.odometer) || 0) / 1000),
        speedKmh: Math.round(knotsToKmh(tracker.speed)),
        internalBatteryVoltage: tracker.internalBatteryVoltage ?? null,
        externalBatteryVoltage: tracker.externalBatteryVoltage ?? null,
      },
      position:
        Number.isFinite(Number(tracker.latitude)) && Number.isFinite(Number(tracker.longitude))
          ? {
              latitude: Number(tracker.latitude),
              longitude: Number(tracker.longitude),
              fixtime: tracker.fixtime ?? null,
            }
          : null,
      stats: { ...stats, topSpeedKmh, periodDays },
      fetchedAt: new Date().toISOString(),
    };

    cacheSet(key, payload, Math.max(60, refreshMinutes * 60));
    return payload;
  } catch (error) {
    const stale = cacheGetStale(key);
    if (stale) {
      return { ...stale.value, cached: true, stale: true, error: error.message };
    }
    return { ok: false, configured: true, error: error.message, code: error.code ?? null };
  }
}
