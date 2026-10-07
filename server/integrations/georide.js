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
//
// Rides are not fetched on demand. The last month of them is kept in SQLite and
// brought up to date incrementally, because a month of positions is far too
// much to ask for on a cache expiry — see `georide_trips` in server/db.js.
import {
  getSecret, setSecret, cacheGet, cacheGetStale, cacheSet, cacheDeletePrefix, getMeta, setMeta,
  listTripRows, tripTotals, latestTripRow, listTripKeys, saveTripRows, deleteTripRows, deleteTripsBefore,
} from '../db.js';
import { encrypt, decrypt } from '../crypto.js';
import { runInWorker } from '../modules/workers.js';

const BASE_URL = 'https://api.georide.fr';
const KNOTS_TO_KMH = 1.852;
const TOKEN_LIFETIME_DAYS = 30;
const REFRESH_AFTER_DAYS = 20; // renew well before the 30-day expiry

// A long ride holds thousands of points; that many is invisible on a map and
// slow to draw, so each track is thinned down on its way into the store. A
// whole month is served in one go, hence the budget for the payload as a
// whole: past it, every track is thinned further, in proportion.
const MAX_TRACK_POINTS = 400;
const MAX_PAYLOAD_POINTS = 12_000;
const MIN_TRACK_POINTS = 60;
// Five decimals is about a metre: plenty for a map, and a third of the bytes.
const round5 = (value) => Math.round(value * 1e5) / 1e5;

/**
 * How much history the server keeps.
 *
 * 31 days and not 30, because 31 is the most `integrations.georide.periodDays`
 * accepts: keeping less than a setting is allowed to ask for would quietly
 * answer a month-and-a-day question with a month of data.
 */
const RETENTION_DAYS = 31;

/** Which tracker is "the first one on the account" is an API call for an answer
 *  that does not change during an afternoon, so it is remembered for a day. */
const TRACKER_TTL_SECONDS = 86_400;

/** How long after its recorded end a ride is still treated as possibly
 *  unfinished. GeoRide closes a trip on a stop that has lasted, so a ride whose
 *  end is older than this will not gain another metre. */
const SETTLED_MINUTES = 15;

const SECRET_EMAIL = 'georide.email';
const SECRET_PASSWORD = 'georide.password';
const SECRET_TOKEN = 'georide.token';
/* The token's issue date and the cached answers are per account, like the
   credentials they come from: two people on one instance follow two GeoRide
   accounts, and a shared key would hand one of them the other's rides. */
const tokenIssuedKey = (userId) => `georide.${Number(userId)}.token_issued`;
const cachePrefix = (userId) => `georide:${Number(userId)}:`;

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

export function isConfigured(userId) {
  return Boolean(getSecret(userId, SECRET_TOKEN) || (getSecret(userId, SECRET_EMAIL) && getSecret(userId, SECRET_PASSWORD)));
}

export function credentialStatus(userId) {
  const issuedAt = getMeta(tokenIssuedKey(userId));
  return {
    configured: isConfigured(userId),
    hasStoredPassword: Boolean(getSecret(userId, SECRET_PASSWORD)),
    email: decrypt(getSecret(userId, SECRET_EMAIL)) || '',
    tokenIssuedAt: issuedAt,
    tokenExpiresAt: issuedAt
      ? new Date(new Date(issuedAt).getTime() + TOKEN_LIFETIME_DAYS * 86_400_000).toISOString()
      : null,
  };
}

/** Log in and store the token. `rememberPassword` allows silent re-login after expiry. */
export async function login(userId, email, password, { rememberPassword = true } = {}) {
  const data = await request('/user/login', { method: 'POST', body: { email, password } });
  if (!data?.authToken) throw new Error('GeoRide did not return a token.');
  const previousEmail = decrypt(getSecret(userId, SECRET_EMAIL)) || '';
  setSecret(userId, SECRET_TOKEN, encrypt(data.authToken));
  setSecret(userId, SECRET_EMAIL, encrypt(email));
  setSecret(userId, SECRET_PASSWORD, rememberPassword ? encrypt(password) : null);
  setMeta(tokenIssuedKey(userId), new Date().toISOString());
  cacheDeletePrefix(cachePrefix(userId));
  // A different GeoRide account means different rides, and they have to go. The
  // same account does not: this function also runs on every silent re-login
  // after a token expires, and throwing a month of history away there would
  // make the next page load the slow one all over again.
  if (previousEmail && previousEmail !== email) deleteTripRows(userId);
  return data.authToken;
}

export function forgetCredentials(userId) {
  setSecret(userId, SECRET_TOKEN, null);
  setSecret(userId, SECRET_EMAIL, null);
  setSecret(userId, SECRET_PASSWORD, null);
  setMeta(tokenIssuedKey(userId), '');
  cacheDeletePrefix(cachePrefix(userId));
  deleteTripRows(userId);
}

const storedToken = (userId) => decrypt(getSecret(userId, SECRET_TOKEN));

async function renewToken(userId, token) {
  const data = await request('/user/new-token', { token });
  if (!data?.authToken) throw new Error('GeoRide did not return a renewed token.');
  setSecret(userId, SECRET_TOKEN, encrypt(data.authToken));
  setMeta(tokenIssuedKey(userId), new Date().toISOString());
  return data.authToken;
}

async function reLogin(userId) {
  const email = decrypt(getSecret(userId, SECRET_EMAIL));
  const password = decrypt(getSecret(userId, SECRET_PASSWORD));
  if (!email || !password) {
    const error = new Error('GeoRide session expired. Sign in again from the settings panel.');
    error.code = 'reauth_required';
    throw error;
  }
  return login(userId, email, password);
}

/** Get a usable token, renewing or re-logging in as needed. */
async function getToken(userId) {
  let token = storedToken(userId);
  if (!token) return reLogin(userId);

  const issuedAt = getMeta(tokenIssuedKey(userId));
  if (issuedAt) {
    const ageDays = (Date.now() - new Date(issuedAt).getTime()) / 86_400_000;
    if (ageDays > REFRESH_AFTER_DAYS) {
      try {
        token = await renewToken(userId, token);
      } catch {
        token = await reLogin(userId);
      }
    }
  }
  return token;
}

/** Call the API, transparently recovering from an expired token. */
async function authed(userId, path) {
  let token = await getToken(userId);
  try {
    return await request(path, { token });
  } catch (error) {
    if (error.status !== 401 && error.status !== 403) throw error;
    token = await reLogin(userId);
    return request(path, { token });
  }
}

/* ------------------------------ the API calls ----------------------------- */

/** The tracker asked for, or the first one on the account. */
async function pickTracker(userId, trackerId) {
  const payload = await authed(userId, '/user/trackers');
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

export async function listTrackers(userId) {
  const data = await authed(userId, '/user/trackers');
  const trackers = Array.isArray(data) ? data : data?.trackers ?? [];
  return trackers.map((t) => ({
    trackerId: t.trackerId,
    trackerName: t.trackerName,
    model: t.model,
    status: t.status,
  }));
}

/* ------------------------------- the store ------------------------------- */

/* When the store was last brought up to date, and for how long that counts as
   up to date. The cache table already does exactly this — a value with a TTL,
   wiped by `cacheDeletePrefix` when credentials change — so a cache miss here
   simply means "time to sync". The stale read gives the timestamp back after
   the TTL has passed, which is what the payload reports as `fetchedAt`. */
const syncedKey = (userId, trackerId) => `${cachePrefix(userId)}synced:${Number(trackerId)}`;
const lastSyncAt = (userId, trackerId) => cacheGetStale(syncedKey(userId, trackerId))?.value ?? null;

const periodStart = (days) =>
  new Date(Date.now() - Math.min(Math.max(1, days), RETENTION_DAYS) * 86_400_000);

/**
 * Which tracker, as `{ id, name }`.
 *
 * `trackerId: null` means "the first one on the account", and finding that out
 * costs a call. Remembered for a day, and on a failure the remembered answer
 * is used anyway: a full month of rides on disk should not become unreachable
 * because the network is.
 */
async function resolveTracker(userId, trackerId) {
  const key = `${cachePrefix(userId)}tracker:${trackerId ?? 'auto'}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const picked = await pickTracker(userId, trackerId);
    return rememberTracker(userId, trackerId, picked);
  } catch (error) {
    const stale = cacheGetStale(key);
    if (stale) return stale.value;
    throw error;
  }
}

/** Keep what a live tracker payload already told us, so the next read of the
 *  store needs no call at all. */
function rememberTracker(userId, trackerId, picked) {
  const value = { id: Number(picked.trackerId), name: picked.trackerName || 'Tracker' };
  cacheSet(`${cachePrefix(userId)}tracker:${trackerId ?? 'auto'}`, value, TRACKER_TTL_SECONDS);
  return value;
}

/** One ride, as it is stored and as the browser receives it. */
function buildTrip(raw, positions) {
  const startedAt = new Date(raw.startTime).getTime();
  const endedAt = new Date(raw.endTime).getTime();
  if (!Number.isFinite(startedAt)) return null;
  const own = Number.isFinite(endedAt)
    ? positions.filter((p) => p.at >= startedAt && p.at <= endedAt)
    : [];
  const topKnots = own.reduce((max, p) => Math.max(max, p.speed), 0);
  return {
    // The API's own id when there is one. Failing that, the instant it started,
    // which one tracker cannot have two of.
    key: String(raw.id ?? raw.startTime ?? startedAt),
    startedAt,
    endedAt: Number.isFinite(endedAt) ? endedAt : startedAt,
    trip: {
      id: raw.id ?? null,
      startTime: raw.startTime ?? null,
      endTime: raw.endTime ?? null,
      distanceKm: Math.round(((Number(raw.distance) || 0) / 1000) * 10) / 10,
      durationMinutes: Math.round((Number(raw.duration) || 0) / 60_000),
      averageSpeedKmh: Math.round(knotsToKmh(raw.averageSpeed)),
      topSpeedKmh: Math.round(knotsToKmh(topKnots)),
      start: {
        latitude: Number(raw.startLat),
        longitude: Number(raw.startLon),
        address: raw.niceStartAddress || raw.startAddress || '',
      },
      end: {
        latitude: Number(raw.endLat),
        longitude: Number(raw.endLon),
        address: raw.niceEndAddress || raw.endAddress || '',
      },
      track: thin(own, MAX_TRACK_POINTS).map((p) => [round5(p.latitude), round5(p.longitude)]),
    },
  };
}

/**
 * Ask the API for what it has that the store does not, and write it down.
 *
 * The window starts at the **start** of the newest ride on record rather than
 * its end. A ride that was still in progress the last time we looked is stored
 * as it was then, half a ride; asking from its end would leave it truncated
 * for good and file the rest of its positions under nothing at all. Fetched
 * again whole, it replaces itself.
 *
 * With nothing stored, the window is the whole retention period — the one slow
 * call, made once per tracker and then never again.
 */
async function syncTrips(userId, trackerId) {
  const latest = latestTripRow(userId, trackerId);
  const from = latest ? new Date(latest.started_at) : periodStart(RETENTION_DAYS);
  const to = new Date();

  /* Positions are the expensive half by two orders of magnitude — one ride is a
     few hundred kilobytes of them — and a ride that settled a quarter of an
     hour ago will not gain any. So once it has settled, only what happened
     after it is asked for, and it keeps the track it already has. Without this,
     a parked motorcycle still costs a full ride's worth of GPS every time the
     refresh interval comes round. */
  const settled = latest && Date.now() - latest.ended_at > SETTLED_MINUTES * 60_000;
  const positionsFrom = settled ? new Date(latest.ended_at) : from;

  const [tripsPayload, positionsPayload] = await Promise.all([
    authed(userId, `/tracker/${trackerId}/trips?${rangeQuery(from, to)}`),
    authed(userId, `/tracker/${trackerId}/trips/positions?${rangeQuery(positionsFrom, to)}`),
  ]);

  // The positions endpoint returns the whole window in one list and says
  // nothing about which ride a point belongs to, so each ride takes the points
  // that fall inside its own start/end window. Those points are also the only
  // source for a ride's top speed, which the trips endpoint does not carry.
  const positions = asList(positionsPayload, 'positions')
    .map((p) => ({
      at: new Date(p.fixtime).getTime(),
      latitude: Number(p.latitude),
      longitude: Number(p.longitude),
      speed: Number(p.speed) || 0,
    }))
    .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.latitude) && Number.isFinite(p.longitude))
    .sort((a, b) => a.at - b.at);

  /* A ride that is already on record and comes back with no positions is not a
     ride with no track: its positions were simply outside what was asked for.
     Left alone rather than overwritten, which is also what keeps this honest
     if the API ever answers with rides that merely overlap the window instead
     of starting inside it. */
  const known = listTripKeys(userId, trackerId);
  const rows = asList(tripsPayload, 'trips')
    .map((raw) => buildTrip(raw, positions))
    .filter((row) => row && !(row.trip.track.length === 0 && known.has(row.key)));

  saveTripRows(userId, trackerId, rows, {
    pruneBefore: periodStart(RETENTION_DAYS).getTime(),
  });
  return rows.length;
}

/* The sync itself runs in this module's worker thread, never here.
 *
 * It is the one piece of Glassboard that can hold the event loop: a month of
 * positions is a multi-megabyte JSON.parse followed by a filter per ride over
 * the whole array. On the main thread that is every other account's dashboard
 * waiting. The worker has its own SQLite connection and writes the rides
 * itself; this side only reads them back.
 *
 * The dedupe key is per tracker, so the tile and the month — asked for at the
 * same instant on every page load — share one run. */
export const syncKey = (userId, trackerId) => `georide:sync:${userId}:${trackerId}`;

/* Whether the API is due to be asked again. The marker is written by the
   worker after a successful sync and expires after the account's own
   refreshMinutes, so this is the one place the interval is honoured —
   by the job and by a reader alike. */
export const isSyncDue = (userId, trackerId) => !cacheGet(syncedKey(userId, trackerId));

const sync = (userId, trackerId) =>
  runInWorker('georide', { task: 'sync', userId, trackerId }, syncKey(userId, trackerId));

/* How long a failed sync waits before being tried again. The job runs every
   minute, and the marker below is the only thing standing between a tracker
   that cannot be reached and sixty calls an hour to somebody's GeoRide
   account. Short enough that a passing failure costs little, long enough that
   a lasting one is not a hammer. */
const RETRY_AFTER_SECONDS = 5 * 60;

/** The worker's half of a sync, exported for it to call. Nothing else should. */
export async function syncTripsInWorker(userId, trackerId, refreshMinutes) {
  try {
    const count = await syncTrips(userId, trackerId);
    cacheSet(syncedKey(userId, trackerId), new Date().toISOString(), Math.max(60, refreshMinutes * 60));
    return count;
  } catch (error) {
    /* Mark the attempt even though it failed, so the next one waits. Without
       this the marker is never written, isSyncDue stays true, and the job
       retries every single minute for as long as the failure lasts.
       The marker is shorter than a success's, so a tracker that comes back
       is picked up quickly. */
    cacheSet(
      syncedKey(userId, trackerId),
      new Date().toISOString(),
      Math.min(RETRY_AFTER_SECONDS, Math.max(60, refreshMinutes * 60))
    );
    throw error;
  }
}

/**
 * Bring the store up to date, if it is old enough to be worth a call.
 *
 * `refreshMinutes` has stopped meaning "how long an answer may be cached" and
 * now means "how often the API is asked" — the answer itself is always on disk.
 *
 * The wait is the part that changed. With rides already stored, the sync is
 * started and **not awaited**: the reader is served the month that is on disk
 * now, and whatever arrived in the last few minutes lands for the next read.
 * A tile that used to sit empty for the length of a GeoRide round trip —
 * fifteen seconds at the timeout — now draws immediately.
 *
 * With nothing stored there is nothing to serve, so that first sync alone is
 * awaited. It happens once per tracker, and the comment on syncTrips explains
 * why it is the slow one.
 *
 * A sync that fails with rides already stored is not an error the reader needs
 * to be stopped by: a month of history is still there. It is said out loud all
 * the same, through `stale`, which is how the card already labels old data.
 */
async function freshen(userId, trackerId, refreshMinutes) {
  const stored = latestTripRow(userId, trackerId) !== null;
  if (stored && cacheGet(syncedKey(userId, trackerId))) return {};

  if (stored) {
    // Started, not waited for. A failure is reported by the next read finding
    // the store still behind, not by this one failing.
    sync(userId, trackerId).catch((error) => {
      console.warn(`[glassboard] georide sync failed for user ${userId}: ${error.message}`);
    });
    return { syncing: true };
  }

  try {
    await sync(userId, trackerId);
    return {};
  } catch (error) {
    // Nothing stored and nothing fetched: there is genuinely nothing to show,
    // and the caller turns this into the tile's "unavailable".
    throw error;
  }
}

export function pruneStoredTrips() {
  return deleteTripsBefore(periodStart(RETENTION_DAYS).getTime());
}

/* ----------------------------- what the card asks ------------------------- */

/**
 * The rides of the period, each with its own track, for the detail view.
 *
 * Read out of the store, so this answers in the time it takes to read a few
 * rows off disk whether or not the API is reachable, slow, or asleep.
 */
export async function getTrips(userId, { trackerId = null, periodDays = 7, refreshMinutes = 5 } = {}) {
  if (!isConfigured(userId)) {
    return { ok: false, configured: false, error: 'GeoRide is not configured yet.' };
  }
  try {
    const tracker = await resolveTracker(userId, trackerId);
    const freshness = await freshen(userId, tracker.id, refreshMinutes);
    const from = periodStart(periodDays);
    const trips = listTripRows(userId, tracker.id, from.getTime());
    const totals = tripTotals(userId, tracker.id, from.getTime());

    // The per-ride thinning happened once, on the way in. This is the budget
    // for the answer as a whole, and that depends on how many days were asked
    // for — the one thing that cannot be decided in advance.
    const totalPoints = trips.reduce((sum, trip) => sum + trip.track.length, 0);
    if (totalPoints > MAX_PAYLOAD_POINTS) {
      const ratio = MAX_PAYLOAD_POINTS / totalPoints;
      trips.forEach((trip) => {
        trip.track = thin(trip.track, Math.max(MIN_TRACK_POINTS, Math.round(trip.track.length * ratio)));
      });
    }

    return {
      ok: true,
      configured: true,
      tracker,
      periodDays: Math.min(Math.max(1, periodDays), RETENTION_DAYS),
      from: from.toISOString(),
      to: new Date().toISOString(),
      totals: {
        tripCount: totals.tripCount,
        distanceKm: totals.distanceKm,
        durationMinutes: totals.durationMinutes,
        topSpeedKmh: totals.topSpeedKmh,
      },
      trips,
      fetchedAt: lastSyncAt(userId, tracker.id) ?? new Date().toISOString(),
      ...freshness,
    };
  } catch (error) {
    return { ok: false, configured: true, error: error.message, code: error.code ?? null };
  }
}

/**
 * Everything the GeoRide tile needs, in one cached payload.
 * Returns `{ ok: false, error }` rather than throwing, so a failing API degrades
 * the tile instead of breaking the dashboard.
 */
export async function getSummary(userId, { trackerId = null, periodDays = 7, refreshMinutes = 5 } = {}) {
  if (!isConfigured(userId)) {
    return { ok: false, configured: false, error: 'GeoRide is not configured yet.' };
  }
  const key = `${cachePrefix(userId)}summary:${trackerId ?? 'auto'}:${periodDays}`;
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  try {
    // Live telemetry — where it is, the odometer, the battery, whether it is
    // moving — has to come off the wire; there is nothing to store about now.
    const tracker = await pickTracker(userId, trackerId);
    rememberTracker(userId, trackerId, tracker);

    // The statistics come off the stored rides. The tile used to pull a week of
    // GPS positions on every cache miss, purely to work out a top speed.
    const freshness = await freshen(userId, Number(tracker.trackerId), refreshMinutes);
    const from = periodStart(periodDays);
    const stats = tripTotals(userId, Number(tracker.trackerId), from.getTime());

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
      stats: {
        ...stats,
        periodStart: from.toISOString(),
        periodDays: Math.min(Math.max(1, periodDays), RETENTION_DAYS),
      },
      fetchedAt: new Date().toISOString(),
      ...freshness,
    };

    // Not cached when the rides behind it are known to be behind: the next read
    // should try again rather than settle into repeating stale figures.
    if (!freshness.stale) cacheSet(key, payload, Math.max(60, refreshMinutes * 60));
    return payload;
  } catch (error) {
    const stale = cacheGetStale(key);
    if (stale) {
      return { ...stale.value, cached: true, stale: true, error: error.message };
    }
    return { ok: false, configured: true, error: error.message, code: error.code ?? null };
  }
}
