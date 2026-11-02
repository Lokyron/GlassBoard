/* How a ride is stored, and the two ways that used to go wrong.
 *
 * Both came from the same place: GeoRide gives a ride its numeric id only
 * once the ride is over, so a ride seen while it was being ridden came back
 * later under a different identity. It was written down twice — and the second
 * copy, arriving after the ride had settled, carried no positions at all. The
 * reader saw the ride listed twice, once with no track and a top speed of
 * zero, and the month's distance counted both.
 *
 * The fixtures below are the real shapes, taken from a live instance: the
 * in-progress answer has no `id`, the finished one has one, and both report
 * the same `startTime` to the millisecond. */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('georide-trips');
const { db, now, saveTripRows, listTripRows, tripTotals } = await import('../server/db.js');
const { buildTrip } = await import('../server/integrations/georide.js');

const USER = db
  .prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) RETURNING id')
  .get('rider', 'x', now()).id;
const TRACKER = 4242;

const START = Date.parse('2026-10-11T18:27:21.840Z');
const END = Date.parse('2026-10-11T18:46:30.000Z');
const TRACK = [[43.6108, 3.8767], [43.6212, 3.8801], [43.6318, 3.8904]];

/** The ride as the sync builds it while it is still being ridden: positions
 *  gathered so far, a top speed read off them, and no id yet. */
const inProgress = () => ({
  key: String(START),
  startedAt: START,
  endedAt: START + 6 * 60_000,
  trip: {
    id: null,
    startTime: '2026-10-11T18:27:21.840Z',
    distanceKm: 7.1,
    durationMinutes: 6,
    averageSpeedKmh: 70,
    topSpeedKmh: 94,
    track: TRACK,
  },
});

/** The same ride once it is over: GeoRide now gives it an id, its figures are
 *  final, and the positions are outside the window the sync asked for. */
const finished = () => ({
  key: String(START),
  startedAt: START,
  endedAt: END,
  trip: {
    id: 16417467,
    startTime: '2026-10-11T18:27:21.840Z',
    distanceKm: 23.4,
    durationMinutes: 19,
    averageSpeedKmh: 74,
    topSpeedKmh: 0,
    track: [],
  },
});

const stored = () =>
  db.prepare('SELECT trip_key, started_at, ended_at, distance_km, top_kmh, trip FROM georide_trips WHERE user_id = ? ORDER BY started_at')
    .all(USER);

beforeEach(() => {
  db.prepare('DELETE FROM georide_trips WHERE user_id = ?').run(USER);
});

describe('the identity of a ride', () => {
  /* The two answers the API gives for one ride, as they really come back:
     no `id` while it is being ridden, an `id` once it is over. */
  const raw = (extra) => ({
    startTime: '2026-10-11T18:27:21.840Z',
    endTime: '2026-10-11T18:46:30.000Z',
    distance: 23_400,
    duration: 1_140_000,
    averageSpeed: 40,
    startLat: 43.6108, startLon: 3.8767, endLat: 43.65, endLon: 3.91,
    ...extra,
  });

  it('does not change when GeoRide finally gives it an id', () => {
    const riding = buildTrip(raw({ id: null }), []);
    const over = buildTrip(raw({ id: 16_417_467 }), []);
    assert.equal(riding.key, over.key, 'one ride, one key, from end to end');
  });

  it('is the instant it started', () => {
    assert.equal(buildTrip(raw({ id: 16_417_467 }), []).key, String(START));
  });

  it('tells two rides apart', () => {
    const other = buildTrip(raw({ id: null, startTime: '2026-10-11T19:30:00.000Z' }), []);
    assert.notEqual(other.key, buildTrip(raw({ id: null }), []).key);
  });
});

describe('a ride that ends between two syncs', () => {
  it('stays one row, whatever the API decides to call it', () => {
    saveTripRows(USER, TRACKER, [inProgress()]);
    saveTripRows(USER, TRACKER, [finished()]);
    assert.equal(stored().length, 1, 'one ride, one row');
  });

  it('takes the finished ride’s own figures', () => {
    saveTripRows(USER, TRACKER, [inProgress()]);
    saveTripRows(USER, TRACKER, [finished()]);
    const [row] = stored();
    assert.equal(row.distance_km, 23.4, 'the whole ride, not the half of it');
    assert.equal(row.ended_at, END);
    assert.equal(JSON.parse(row.trip).durationMinutes, 19);
  });

  it('keeps the track it gathered, rather than the nothing it was handed', () => {
    saveTripRows(USER, TRACKER, [inProgress()]);
    saveTripRows(USER, TRACKER, [finished()]);
    const [row] = stored();
    assert.deepEqual(JSON.parse(row.trip).track, TRACK);
  });

  it('keeps the top speed too, since it is read off those positions', () => {
    saveTripRows(USER, TRACKER, [inProgress()]);
    saveTripRows(USER, TRACKER, [finished()]);
    const [row] = stored();
    assert.equal(row.top_kmh, 94, 'a top speed of zero is an absent answer, not a reading');
    assert.equal(JSON.parse(row.trip).topSpeedKmh, 94, 'and the payload agrees with the column');
  });

  it('counts the distance once', () => {
    saveTripRows(USER, TRACKER, [inProgress()]);
    saveTripRows(USER, TRACKER, [finished()]);
    const totals = tripTotals(USER, TRACKER, START - 1);
    assert.equal(totals.tripCount, 1);
    assert.equal(totals.distanceKm, 23.4);
    assert.equal(totals.topSpeedKmh, 94);
  });

  it('is handed to the browser once, with its track', () => {
    saveTripRows(USER, TRACKER, [inProgress()]);
    saveTripRows(USER, TRACKER, [finished()]);
    const trips = listTripRows(USER, TRACKER, START - 1);
    assert.equal(trips.length, 1);
    assert.equal(trips[0].track.length, TRACK.length);
  });
});

describe('a track is never replaced by nothing', () => {
  it('but a better track replaces a shorter one', () => {
    const longer = [...TRACK, [43.64, 3.9], [43.65, 3.91]];
    saveTripRows(USER, TRACKER, [inProgress()]);
    saveTripRows(USER, TRACKER, [{ ...finished(), trip: { ...finished().trip, topSpeedKmh: 127, track: longer } }]);
    const [row] = stored();
    assert.deepEqual(JSON.parse(row.trip).track, longer);
    assert.equal(row.top_kmh, 127, 'a real reading wins over the kept one');
  });

  it('and a first sighting with no positions is still recorded', () => {
    // A ride that has only just begun has nothing to draw yet. It is stored
    // all the same: the figures are what the card shows.
    saveTripRows(USER, TRACKER, [{ ...finished(), trip: { ...finished().trip, topSpeedKmh: 0 } }]);
    const [row] = stored();
    assert.equal(row.top_kmh, 0);
    assert.deepEqual(JSON.parse(row.trip).track, []);
  });
});

describe('the rides left behind by the old key scheme', () => {
  it('are collapsed on start-up, keeping the one with a track', async () => {
    /* What a database written by the previous version looks like: the same
       ride under two keys, the id-keyed copy without its track. The migration
       runs at import, so this one writes the rows, then imports db.js again in
       a fresh process-level cache to make it run. */
    const insert = db.prepare(
      `INSERT INTO georide_trips
         (user_id, tracker_id, trip_key, started_at, ended_at, distance_km, duration_min, average_kmh, top_kmh, trip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(USER, TRACKER, '2026-10-11T18:27:21.840Z', START, END, 23.4, 19, 74, 127,
      JSON.stringify({ ...finished().trip, topSpeedKmh: 127, track: TRACK }));
    insert.run(USER, TRACKER, '16417467', START, END, 23.4, 19, 74, 0,
      JSON.stringify(finished().trip));
    assert.equal(stored().length, 2, 'the broken state this is here to repair');

    const { migrateTripKeys } = await import('../server/db.js');
    migrateTripKeys();

    const rows = stored();
    assert.equal(rows.length, 1, 'one ride, one row');
    assert.equal(rows[0].trip_key, String(START), 'rekeyed to the start instant');
    assert.equal(rows[0].top_kmh, 127, 'the copy that still had its track won');
    assert.deepEqual(JSON.parse(rows[0].trip).track, TRACK);
  });

  it('and running it again does nothing', async () => {
    const { migrateTripKeys } = await import('../server/db.js');
    saveTripRows(USER, TRACKER, [inProgress()]);
    const before = stored();
    migrateTripKeys();
    assert.deepEqual(stored(), before);
  });
});
