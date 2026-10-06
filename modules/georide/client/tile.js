/* GeoRide — the tracker tile, its small map, and the month of rides behind it.
 *
 * The heavy module. Its map library is fetched only when a map is wanted, and
 * the month it draws is read from the server's own store rather than from the
 * GeoRide API, so opening the panel is a read and not a download. */
import {
  id, safe, esc, svg, html, state, moduleState, api, openModal, closeModal,
  tileElement, tileOfType,
} from '/assets/core/kernel.js';
import { leaflet } from './leaflet.js';

const own = moduleState('georide');
Object.assign(own, {
  georide: own.georide ?? null,
  trips: own.trips ?? null,        // the detail view's payload: the last 30 days
  tripLayers: own.tripLayers ?? null,
  tripPeriod: own.tripPeriod ?? null,
  selectedTrip: own.selectedTrip ?? 'all',
  tripMap: own.tripMap ?? null,
  map: own.map ?? null,
  marker: own.marker ?? null,
});

/* Leaflet is not a global here any more. L is bound once the library has been
   fetched, and every function below runs after that point — the two places
   that can be reached without a map first await ensureLeaflet(). */
let L = null;
const ensureLeaflet = async () => { L ??= await leaflet(); return L; };

function georideTileMarkup(tile, index) {
  const delay = `animation-delay:.${String(5 * (index + 1)).padStart(2, '0')}s`;
  return `<article class="card glass rise georide" style="${delay}" data-tile="${tile.id}" data-type="georide">
        <div class="wtop"><div><div class="lbl">${esc(t('gr.title'))}</div><h3 data-role="name">…</h3></div><div class="emoji">${svg('motorcycle', 'font-size:28px')}</div></div>
        <div class="gr-stats" data-role="stats"></div>
        <div class="gr-map" data-role="map"><div class="gr-map-empty">${esc(t('gr.noPosition'))}</div></div>
        <div class="insight-foot"><div class="dot" data-role="dot"></div><span data-role="foot">…</span></div></article>`;
}

/* -------------------------------- GeoRide -------------------------------- */

const MAP_TILE_URL = '/api/integrations/map/tile/{z}/{x}/{y}.png';

function refreshMapTheme(container = own.map?.getContainer()) {
  if (container) container.classList.toggle('map-dark', html.getAttribute('data-theme') === 'dark');
}

/** Leaflet keeps global listeners alive, so a discarded map has to be told. */
function destroyMap() {
  if (own.map) {
    try { own.map.remove(); } catch { /* already detached */ }
  }
  own.map = null;
  own.marker = null;
}

function renderGeorideMap(tile, position) {
  const article = tileElement(tile.id);
  const holder = article?.querySelector('[data-role="map"]');
  if (!holder || !position) return;
  destroyMap();
  holder.innerHTML = '';
  const mapElement = document.createElement('div');
  mapElement.className = 'gr-map-canvas';
  holder.appendChild(mapElement);

  const map = L.map(mapElement, {
    zoomControl: false,
    attributionControl: true,
    scrollWheelZoom: false,
    dragging: true,
  }).setView([position.latitude, position.longitude], 14);
  L.tileLayer(MAP_TILE_URL, { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const icon = L.divIcon({ className: 'gr-pin', html: svg('motorcycle'), iconSize: [30, 30], iconAnchor: [15, 15] });
  own.marker = L.marker([position.latitude, position.longitude], { icon }).addTo(map);
  own.map = map;
  refreshMapTheme();
  setTimeout(() => map.invalidateSize(), 60);
}

function renderGeorideTile(tile, summary) {
  const article = tileElement(tile.id);
  if (!article) return;
  const el = (role) => article.querySelector(`[data-role="${role}"]`);

  article.classList.toggle('gr-clickable', Boolean(summary?.ok));

  if (!summary?.ok) {
    safe(el('name'), state.config.integrations.georide?.trackerName || '');
    el('stats').innerHTML = `<p class="gr-message">${esc(summary?.configured === false ? t('gr.notConfigured') : summary?.error || t('gr.unavailable'))}</p>`;
    // No empty map frame while the integration is not set up: the tile would
    // stretch the whole row for nothing.
    el('map').style.display = 'none';
    el('dot').style.background = '#ff9f0a';
    el('dot').style.boxShadow = '0 0 0 5px rgba(255,159,10,.16)';
    // Point at the fix rather than repeating the problem.
    safe(el('foot'), summary?.configured === false ? `${t('set.title')} → ${t('set.georide')}` : t('gr.unavailable'));
    return;
  }
  el('map').style.display = '';

  const stats = summary.stats;
  const hours = Math.floor(stats.durationMinutes / 60);
  const minutes = stats.durationMinutes % 60;
  safe(el('name'), state.config.integrations.georide.trackerName || summary.tracker.name);
  el('stats').innerHTML = [
    [t('gr.distance'), `${stats.distanceKm} <small>km</small>`],
    [t('gr.time'), hours > 0 ? `${hours} <small>h</small> ${String(minutes).padStart(2, '0')}` : `${minutes} <small>min</small>`],
    [t('gr.trips'), String(stats.tripCount)],
    [t('gr.topSpeed'), `${stats.topSpeedKmh} <small>km/h</small>`],
  ]
    .map(([label, value]) => `<div class="gr-stat"><div class="k">${esc(label)}</div><div class="v">${value}</div></div>`)
    .join('');

  const moving = summary.tracker.moving;
  el('dot').style.background = moving ? '#0a84ff' : '#34c759';
  el('dot').style.boxShadow = moving ? '0 0 0 5px rgba(10,132,255,.16)' : '0 0 0 5px rgba(52,199,89,.16)';
  const fixTime = summary.position?.fixtime
    ? new Date(summary.position.fixtime).toLocaleString(state.config.site.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';
  safe(el('foot'), `${moving ? t('gr.moving') : t('gr.parked')} · ${t('gr.lastFix')} ${fixTime}${summary.stale ? ` · ${t('gr.stale')}` : ''}`);

  if (state.config.integrations.georide.showMap && summary.position) {
    renderGeorideMap(tile, summary.position);
  } else {
    el('map').innerHTML = `<div class="gr-map-empty">${esc(t('gr.noPosition'))}</div>`;
  }
}

/* ---------------------- GeoRide detail view (trips) ---------------------- */

const TRIP_PERIODS = [1, 7, 30];
// The month is asked for in one request and the shorter periods are slices of
// it, so switching period or trip never waits on the network. The server keeps
// that month on disk, so the request itself is a read rather than a download.
const TRIP_WINDOW_DAYS = 30;

const tripKey = (trip) => `${trip.id ?? ''}|${trip.startTime}`;

function destroyTripMap() {
  if (own.tripMap) {
    try { own.tripMap.remove(); } catch { /* already detached */ }
  }
  own.tripMap = null;
  own.tripLayers = null;
  own.tripGroup = null;
  own.tripMarkers = null;
  // Leaflet detaches its listeners; the container is ours to drop.
  const holder = id('gr-track');
  if (holder) holder.innerHTML = '';
}

function closeGeorideModal() {
  // The map goes only once the panel has finished leaving: tearing Leaflet
  // down mid-animation empties the panel while it is still on screen.
  closeModal('georide-modal').then(destroyTripMap);
}

async function openGeorideModal(origin = null) {
  if (!own.georide?.ok) return;
  safe(id('gr-modal-title'), state.config.integrations.georide.trackerName || own.georide.tracker.name);
  own.tripPeriod = own.tripPeriod ?? state.config.integrations.georide.periodDays ?? 7;
  own.selectedTrip = 'all';
  openModal('georide-modal', origin ?? tileOfType('georide'));
  // The panel always draws a map, even where the tile was told not to.
  await ensureLeaflet();
  renderTripPeriods();
  if (own.trips) renderTrips();   // prefetched while the dashboard loaded
  else await loadTrips();           // or still in the air: joined, not repeated
}

function renderTripPeriods() {
  const holder = id('gr-period');
  holder.innerHTML = '';
  TRIP_PERIODS.forEach((days) => {
    const button = document.createElement('button');
    button.className = `day-btn${days === own.tripPeriod ? ' active' : ''}`;
    button.innerHTML = `<span class="dn">${esc(t(`gr.p${days}`))}</span>`;
    button.addEventListener('click', () => {
      if (days === own.tripPeriod) return;
      own.tripPeriod = days;
      own.selectedTrip = 'all';
      renderTripPeriods();
      renderTrips();               // already downloaded: no round trip
    });
    holder.appendChild(button);
  });
}

/* The month, requested at most once at a time.
   The dashboard prefetches it as the page settles, and the card can be clicked
   while that is still in the air — which used to fire a second, identical
   request for the same thirty days. Everyone who asks in the meantime waits on
   the one already running. */
let tripsRequest = null;

/** Fetch the month. Called in the background as the dashboard settles, and
 *  again on opening the card if that has not landed yet. */
function loadTrips({ quiet = false } = {}) {
  // Said before the early return, so joining a prefetch still shows the reader
  // that something is on its way.
  if (!quiet) id('gr-trip-list').innerHTML = `<p class="gr-empty">${esc(t('gr.loading'))}</p>`;
  if (tripsRequest) return tripsRequest;
  tripsRequest = fetchTrips().finally(() => { tripsRequest = null; });
  return tripsRequest;
}

/* Has anything happened since the month we are holding?
   The answer is a couple of hundred kilobytes, and a motorcycle is ridden a few
   times a week, so asking on every tick would be a download an hour for nothing
   — which on a phone away from home is not nothing. The tile has just been
   refreshed and carries the end of the most recent ride, so it already knows.
   `null` means no ride at all within the tile's own period, which says nothing
   about the month and is not a reason to re-fetch it. */
function newRideSince(summary) {
  const latest = summary.stats?.lastTripAt ?? null;
  return latest !== null && latest !== (own.trips?.trips?.[0]?.endTime ?? null);
}

async function fetchTrips() {
  try {
    own.trips = await api(`/api/integrations/georide/trips?days=${TRIP_WINDOW_DAYS}`);
  } catch (error) {
    own.trips = { ok: false, error: error.message };
  }
  if (id('georide-modal').classList.contains('open')) renderTrips();
}

/** The trips of the selected period, taken from the month already in hand. */
function visibleTrips() {
  if (!own.trips?.ok) return [];
  const since = Date.now() - own.tripPeriod * 86_400_000;
  return own.trips.trips.filter((trip) => new Date(trip.startTime).getTime() >= since);
}

const periodTotals = (trips) => ({
  tripCount: trips.length,
  distanceKm: Math.round(trips.reduce((sum, trip) => sum + trip.distanceKm, 0) * 10) / 10,
  durationMinutes: trips.reduce((sum, trip) => sum + trip.durationMinutes, 0),
  topSpeedKmh: trips.reduce((max, trip) => Math.max(max, trip.topSpeedKmh), 0),
});

/** Distance and duration, written the way the tile writes them. */
function tripFigures(trip) {
  const hours = Math.floor(trip.durationMinutes / 60);
  const minutes = trip.durationMinutes % 60;
  return {
    distance: `${trip.distanceKm} km`,
    duration: hours > 0 ? `${hours} h ${String(minutes).padStart(2, '0')}` : `${minutes} min`,
  };
}

/** The four figures: the whole period, or the ride being looked at. */
function renderTripTotals(trips) {
  const trip = typeof own.selectedTrip === 'number' ? trips[own.selectedTrip] : null;
  const shown = trip
    ? { distanceKm: trip.distanceKm, durationMinutes: trip.durationMinutes, topSpeedKmh: trip.topSpeedKmh }
    : periodTotals(trips);
  const hours = Math.floor(shown.durationMinutes / 60);
  const minutes = shown.durationMinutes % 60;
  id('gr-totals').innerHTML = [
    [t('gr.distance'), `${shown.distanceKm} <small>km</small>`],
    [t('gr.time'), hours > 0 ? `${hours} <small>h</small> ${String(minutes).padStart(2, '0')}` : `${minutes} <small>min</small>`],
    trip ? [t('gr.average'), `${trip.averageSpeedKmh} <small>km/h</small>`] : [t('gr.trips'), String(trips.length)],
    [t('gr.topSpeed'), `${shown.topSpeedKmh} <small>km/h</small>`],
  ]
    .map(([label, value]) => `<div class="box"><div class="k">${esc(label)}</div><div class="v">${value}</div></div>`)
    .join('');
}

/** Full redraw: the period changed, or the data just arrived. */
function renderTrips() {
  const list = id('gr-trip-list');
  if (!own.trips?.ok) {
    id('gr-totals').innerHTML = '';
    list.innerHTML = `<p class="gr-empty">${esc(own.trips?.error || t('gr.unavailable'))}</p>`;
    destroyTripMap();
    return;
  }

  const trips = visibleTrips();
  renderTripTotals(trips);

  if (trips.length === 0) {
    list.innerHTML = `<p class="gr-empty">${esc(t('gr.noTrips'))}</p>`;
    destroyTripMap();
    return;
  }

  const rows = [
    `<button class="gr-trip${own.selectedTrip === 'all' ? ' active' : ''}" data-trip="all">
       <span class="gr-trip-when">${esc(t('gr.allTrips'))}</span>
       <span class="gr-trip-where">${esc(t('gr.tripsOver', { n: trips.length, days: own.tripPeriod }))}</span>
     </button>`,
  ];
  trips.forEach((trip, index) => {
    const figures = tripFigures(trip);
    const when = trip.startTime
      ? new Date(trip.startTime).toLocaleString(state.config.site.locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '—';
    rows.push(`<button class="gr-trip${own.selectedTrip === index ? ' active' : ''}" data-trip="${index}">
        <span class="gr-trip-when">${esc(when)}</span>
        <span class="gr-trip-where">${esc(trip.start.address || '—')} → ${esc(trip.end.address || '—')}</span>
        <span class="gr-trip-figures">${esc(figures.distance)} · ${esc(figures.duration)} · ${trip.topSpeedKmh} km/h</span>
      </button>`);
  });
  list.innerHTML = rows.join('');
  list.querySelectorAll('[data-trip]').forEach((button) => {
    button.addEventListener('click', () => selectTrip(button.dataset.trip === 'all' ? 'all' : Number(button.dataset.trip)));
  });

  syncTracks(trips);
  styleTracks(trips);
}

/** Picking another ride only restyles what is already on the map. */
function selectTrip(selection) {
  if (own.selectedTrip === selection) return;
  own.selectedTrip = selection;
  const trips = visibleTrips();
  id('gr-trip-list').querySelectorAll('[data-trip]').forEach((button) => {
    const value = button.dataset.trip === 'all' ? 'all' : Number(button.dataset.trip);
    button.classList.toggle('active', value === selection);
  });
  renderTripTotals(trips);
  styleTracks(trips);
}

function ensureTripMap() {
  if (own.tripMap) return own.tripMap;
  const holder = id('gr-track');
  holder.innerHTML = '';
  const canvas = document.createElement('div');
  canvas.className = 'gr-track-canvas';
  holder.appendChild(canvas);

  const map = L.map(canvas, { zoomControl: true, scrollWheelZoom: true, attributionControl: true }).setView([46.6, 2.5], 5);
  L.tileLayer(MAP_TILE_URL, { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  own.tripMap = map;
  own.tripLayers = new Map();
  own.tripGroup = L.layerGroup().addTo(map);
  own.tripMarkers = L.layerGroup().addTo(map);
  refreshMapTheme(canvas);
  setTimeout(() => map.invalidateSize(), 80);
  return map;
}

/** Each track is drawn once and kept; only the ones that left the period go. */
function syncTracks(trips) {
  ensureTripMap();
  const accent = getComputedStyle(html).getPropertyValue('--primary').trim() || '#0a84ff';
  const wanted = new Set(trips.map(tripKey));
  for (const [key, layer] of own.tripLayers) {
    if (!wanted.has(key)) {
      own.tripGroup.removeLayer(layer);
      own.tripLayers.delete(key);
    }
  }
  trips.forEach((trip) => {
    const key = tripKey(trip);
    if (trip.track.length < 2 || own.tripLayers.has(key)) return;
    const line = L.polyline(trip.track, { color: accent, weight: 3, opacity: 0.9, smoothFactor: 1.6 });
    own.tripGroup.addLayer(line);
    own.tripLayers.set(key, line);
  });
}

function styleTracks(trips) {
  if (!own.tripMap) return;
  const selected = typeof own.selectedTrip === 'number' ? trips[own.selectedTrip] : null;
  trips.forEach((trip) => {
    const line = own.tripLayers.get(tripKey(trip));
    if (!line) return;
    const lit = !selected || trip === selected;
    line.setStyle({ weight: lit ? 4 : 2, opacity: lit ? 0.95 : 0.22 });
    if (lit && selected) line.bringToFront();
  });

  own.tripMarkers.clearLayers();
  if (selected && selected.track.length >= 2) {
    const pin = (name) => L.divIcon({ className: 'gr-pin', html: svg(name), iconSize: [26, 26], iconAnchor: [13, 13] });
    L.marker(selected.track[0], { icon: pin('navigation-arrow') }).addTo(own.tripMarkers);
    L.marker(selected.track[selected.track.length - 1], { icon: pin('map-pin') }).addTo(own.tripMarkers);
  }

  const frame = selected ? selected.track : trips.flatMap((trip) => trip.track);
  if (frame.length) own.tripMap.flyToBounds(frame, { padding: [26, 26], duration: 0.45 });
}

async function loadGeoride() {
  const tile = state.config.tiles.find((item) => item.type === 'georide');
  if (!tile) return;
  try {
    /* The library, only if a map is actually going to be drawn — and asked
       for alongside the summary rather than after it, so the two round trips
       overlap instead of queueing. Every map-making function below is
       synchronous and runs after this point. */
    const wantsMap = state.config.integrations.georide?.showMap !== false;
    const [summary] = await Promise.all([
      api('/api/integrations/georide/summary'),
      wantsMap ? ensureLeaflet().catch(() => null) : null,
    ]);
    own.georide = summary;
    renderGeorideTile(tile, summary);
    if (!summary.ok) return;
    // Pull the month in the background, once, so the detail view opens on data
    // that is already there.
    if (!own.trips) {
      const prefetch = () => loadTrips({ quiet: true });
      if (typeof requestIdleCallback === 'function') requestIdleCallback(prefetch, { timeout: 4000 });
      else setTimeout(prefetch, 1200);
      return;
    }
    // After that it is only worth asking again once a ride has actually
    // arrived, which the tile has just said. Not while the panel is open,
    // either: a ride appearing under the cursor renumbers the list and moves
    // the selection onto a different ride.
    if (newRideSince(summary) && !id('georide-modal').classList.contains('open')) {
      loadTrips({ quiet: true });
    }
  } catch (error) {
    renderGeorideTile(tile, { ok: false, error: error.message });
  }
}


/* ------------------------------ the contract ------------------------------ */

export default {
  id: 'georide',

  tiles: {
    georide: {
      markup: georideTileMarkup,
      open: (article, _tile, event) => {
        // The small map pans on its own; a drag on it is not a click on the card.
        if (event?.target.closest('.gr-map')) return;
        openGeorideModal(article);
      },
    },
  },

  mounted() {
    if (own.wired) return;
    own.wired = true;
    id('georide-modal').addEventListener('click', (event) => {
      if (event.target === id('georide-modal')) closeGeorideModal();
    });
  },

  refresh: loadGeoride,

  onThemeChange() {
    if (own.map) refreshMapTheme();
    if (own.tripMap) refreshMapTheme(own.tripMap.getContainer());
  },

  onResize() {
    own.map?.invalidateSize();
    own.tripMap?.invalidateSize();
  },

  closeViews: closeGeorideModal,

  /* A re-render throws the tile's element away, and Leaflet keeps global
     listeners for a map whose container is gone. */
  unmount: destroyMap,
};
