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

// A long ride holds thousands of points; that many is invisible on a map and
// slow to draw, so each track is thinned down before it leaves the server. A
// whole month of riding is fetched in one go, hence the budget for the payload
// as a whole: past it, every track is thinned further, in proportion.
const MAX_TRACK_POINTS = 400;
const MAX_PAYLOAD_POINTS = 12_000;
const MIN_TRACK_POINTS = 60;
// Five decimals is about a metre: plenty for a map, and a third of the bytes.
const round5 = (value) => Math.round(value * 1e5) / 1e5;

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

/** The tracker asked for, or the first one on the account. */
async function pickTracker(trackerId) {
  const payload = await authed('/user/trackers');
  const trackers = Array.isArray(payload) ? payload : payload?.trackers ?? [];
  if (trackers.length === 0) throw new Error('No tracker is attached to this GeoRide account.');
  return (trackerId && trackers.find((t) => Number(t.trackerId) === Number(trackerId))) || trackers[0];
}

const rangeQuery = (from, to) =>
  `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;

const asList = (payload, key) => (Array.isArray(payload) ? payload : payload?.[key] ?? []);

/** Keep the ends and spread the rest evenly: the shape of the ride survives. */
function thin(points, max) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const kept = [];
  for (let i = 0; i < max; i += 1) kept.push(points[Math.round(i * step)]);
  return kept;
}

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
 * The trips of the period, each with its own track, for the detail view.
 *
 * The positions endpoint returns the whole period in one list and says nothing
 * about which trip a point belongs to, so each trip takes the points that fall
 * inside its own start/end window. The same points give the top speed of a trip,
 * which the trips endpoint does not carry.
 */
export async function getTrips({ trackerId = null, periodDays = 7, refreshMinutes = 5 } = {}) {
  if (!isConfigured()) {
    return { ok: false, configured: false, error: 'GeoRide is not configured yet.' };
  }
  const key = `georide:trips:${trackerId ?? 'auto'}:${periodDays}`;
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  try {
    const tracker = await pickTracker(trackerId);
    const to = new Date();
    const from = new Date(to.getTime() - periodDays * 86_400_000);
    const range = rangeQuery(from, to);

    const [tripsPayload, positionsPayload] = await Promise.all([
      authed(`/tracker/${tracker.trackerId}/trips?${range}`),
      authed(`/tracker/${tracker.trackerId}/trips/positions?${range}`),
    ]);

    const positions = asList(positionsPayload, 'positions')
      .map((p) => ({
        at: new Date(p.fixtime).getTime(),
        latitude: Number(p.latitude),
        longitude: Number(p.longitude),
        speed: Number(p.speed) || 0,
      }))
      .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
      .sort((a, b) => a.at - b.at);

    const trips = asList(tripsPayload, 'trips')
      .map((trip) => {
        const startedAt = new Date(trip.startTime).getTime();
        const endedAt = new Date(trip.endTime).getTime();
        const own = Number.isFinite(startedAt) && Number.isFinite(endedAt)
          ? positions.filter((p) => p.at >= startedAt && p.at <= endedAt)
          : [];
        const topKnots = own.reduce((max, p) => Math.max(max, p.speed), 0);
        return {
          id: trip.id ?? null,
          startTime: trip.startTime ?? null,
          endTime: trip.endTime ?? null,
          distanceKm: Math.round(((Number(trip.distance) || 0) / 1000) * 10) / 10,
          durationMinutes: Math.round((Number(trip.duration) || 0) / 60_000),
          averageSpeedKmh: Math.round(knotsToKmh(trip.averageSpeed)),
          topSpeedKmh: Math.round(knotsToKmh(topKnots)),
          start: {
            latitude: Number(trip.startLat),
            longitude: Number(trip.startLon),
            address: trip.niceStartAddress || trip.startAddress || '',
          },
          end: {
            latitude: Number(trip.endLat),
            longitude: Number(trip.endLon),
            address: trip.niceEndAddress || trip.endAddress || '',
          },
          track: thin(own, MAX_TRACK_POINTS).map((p) => [round5(p.latitude), round5(p.longitude)]),
        };
      })
      .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

    // Keep the whole answer within the budget, without flattening short rides.
    const totalPoints = trips.reduce((sum, trip) => sum + trip.track.length, 0);
    if (totalPoints > MAX_PAYLOAD_POINTS) {
      const ratio = MAX_PAYLOAD_POINTS / totalPoints;
      trips.forEach((trip) => {
        trip.track = thin(trip.track, Math.max(MIN_TRACK_POINTS, Math.round(trip.track.length * ratio)));
      });
    }

    const payload = {
      ok: true,
      configured: true,
      tracker: { id: tracker.trackerId, name: tracker.trackerName || 'Tracker' },
      periodDays,
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        tripCount: trips.length,
        distanceKm: Math.round(trips.reduce((sum, trip) => sum + trip.distanceKm, 0) * 10) / 10,
        durationMinutes: trips.reduce((sum, trip) => sum + trip.durationMinutes, 0),
        topSpeedKmh: trips.reduce((max, trip) => Math.max(max, trip.topSpeedKmh), 0),
      },
      trips,
      fetchedAt: new Date().toISOString(),
    };

    cacheSet(key, payload, Math.max(60, refreshMinutes * 60));
    return payload;
  } catch (error) {
    const stale = cacheGetStale(key);
    if (stale) return { ...stale.value, cached: true, stale: true, error: error.message };
    return { ok: false, configured: true, error: error.message, code: error.code ?? null };
  }
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
    const tracker = await pickTracker(trackerId);
    const to = new Date();
    const from = new Date(to.getTime() - periodDays * 86_400_000);
    const range = rangeQuery(from, to);

    const trips = await authed(`/tracker/${tracker.trackerId}/trips?${range}`);
    const stats = summariseTrips(trips, from.toISOString());

    // The API exposes no per-trip maximum speed, only averageSpeed, so the real
    // top speed is derived from the individual positions of the period.
    let topSpeedKmh = stats.bestAverageSpeedKmh;
    try {
      const positionsPayload = await authed(`/tracker/${tracker.trackerId}/trips/positions?${range}`);
      const positions = asList(positionsPayload, 'positions');
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
