/* Glassboard — dashboard renderer (read mode).
   The markup and CSS are the ones of the original static page; everything that
   used to be hard-coded now comes from the configuration served by /api/config. */

const html = document.documentElement;
const id = (s) => document.getElementById(s);
const safe = (el, value) => { if (el) el.textContent = value; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const iconName = (n) => (n || '').replace(/^ph-/, '');
const svg = (name, style) =>
  `<svg class="i"${style ? ` style="${style}"` : ''} viewBox="0 0 256 256" fill="currentColor">${PH[iconName(name)] || PH.link || ''}</svg>`;
const hydrateIcons = (root = document) =>
  root.querySelectorAll('svg[data-i]').forEach((el) => { el.innerHTML = PH[el.dataset.i] || ''; });

const state = {
  config: null,
  saved: null,
  tileTypes: {},
  editing: false,
  forecasts: {},   // tileId -> Open-Meteo payload
  places: {},      // tileId -> resolved city name
  coords: {},      // tileId -> { latitude, longitude }
  georide: null,
  trips: null,          // the detail view's payload: the last 30 days, fetched once
  tripLayers: null,     // trip key -> its polyline, kept across selections
  tripPeriod: null,     // days shown in the detail view
  selectedTrip: 'all',
  tripMap: null,
  parcels: null,        // the parcel payload, list and counts
  selectedParcel: null, // id of the parcel whose history is shown
  suggestions: null,    // tracking numbers found in the mailbox, awaiting a yes
  themePresets: {},
  wallpaperVersion: '',
  map: null,
  marker: null,
  modalTile: null,
  selectedDay: 0,
  me: null,           // the signed-in account: its name, and whether it administers
  news: null,         // the changelog sections this account has not been shown
  curve: null,        // the selected day, folded for the curve and its cursor
  curveNodes: null,   // the cursor's svg nodes, built once per render and moved
  curveIndex: null,   // the hour being read, or null when nothing is
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const weatherEmoji = (code, day = true) =>
  (code <= 1 ? (day ? '☀️' : '🌙') : code <= 3 ? (day ? '⛅' : '☁️') : code <= 67 ? '🌧️' : '⛈️');
/** Today in the browser's own timezone. toISOString() would give UTC, which is
 *  the wrong day for anyone east of Greenwich late in the evening. */
function localDayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "07:38" out of an Open-Meteo local timestamp, or '' when there is none. */
const clockOf = (stamp) => (typeof stamp === 'string' && stamp.length >= 16 ? stamp.slice(11, 16) : '');

/* --------------------------------- API ----------------------------------- */

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 401 || response.status === 409) {
    window.location.href = response.status === 409 ? '/setup' : '/login';
    throw new Error('unauthenticated');
  }
  const payload = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : null;
  if (!response.ok) {
    const error = new Error(payload?.error || `HTTP ${response.status}`);
    error.details = payload?.details;
    // Several routes answer with a machine-readable code next to the message.
    // Carrying it through is what lets a caller react to a particular failure
    // rather than only display it.
    error.code = payload?.code ?? null;
    error.status = response.status;
    throw error;
  }
  return payload;
}

/* --------------------------------- toast --------------------------------- */

let toastTimer = null;
function toast(message, kind = 'info') {
  const el = id('toast');
  el.textContent = message;
  el.className = `glass toast-${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

/* --------------------------------- theme --------------------------------- */

function setTheme(dark) {
  html.setAttribute('data-theme', dark ? 'dark' : 'light');
  const icon = id('theme-icon');
  if (icon) icon.innerHTML = PH[dark ? 'moon' : 'sun'] || '';
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* private mode */ }
  if (state.map) refreshMapTheme();
  syncStatusBarColour();
}

/** Paint the phone status bar and the PWA chrome with the current backdrop. */
function syncStatusBarColour() {
  const meta = id('meta-theme-color');
  if (!meta) return;
  // Sampled from the backdrop so the status bar blends into the page.
  const base = getComputedStyle(html).getPropertyValue('--wall-base-1').trim();
  if (base) meta.setAttribute('content', base);
}
function toggleTheme() { setTheme(html.getAttribute('data-theme') !== 'dark'); }

/* ------------------------------- navigation ------------------------------ */

function goTo(anchor, trigger) {
  const target = id(anchor);
  // On a phone the overview wrapper has no box of its own: go to the top instead.
  if (target?.getClientRects().length) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else window.scrollTo({ top: 0, behavior: 'smooth' });
  document.querySelectorAll('.pill, .dock-item').forEach((p) => p.classList.remove('active'));
  if (trigger) trigger.classList.add('active');
}

/** The navigation entries, shared by the sidebar and the phone dock. */
function navEntries() {
  const entries = [
    { icon: 'sparkle', label: t('nav.overview'), short: t('dock.overview'), run: (button) => goTo('overview', button) },
    { icon: 'folder', label: t('nav.apps'), short: t('dock.apps'), run: (button) => goTo('apps-section', button) },
  ];
  // One entry per weather tile, exactly like the original page.
  state.config.tiles
    .filter((tile) => tile.type === 'weather-local' || tile.type === 'weather-secondary')
    .forEach((tile) => {
      const label = tile.type === 'weather-local' ? t('nav.localWeather') : tile.settings.name || t('tile.followedCity');
      entries.push({
        icon: tile.type === 'weather-local' ? 'navigation-arrow' : 'buildings',
        label,
        short: tile.type === 'weather-local' ? t('dock.weather') : label,
        run: () => openWeatherModal(tile.id),
      });
    });
  return entries;
}

function renderNav() {
  const entries = navEntries();
  const nav = id('nav');
  const dock = id('dock');
  nav.innerHTML = '';
  dock.innerHTML = '';

  entries.forEach((entry, index) => {
    const pill = document.createElement('button');
    pill.className = `pill${index === 0 ? ' active' : ''}`;
    pill.innerHTML = `${svg(entry.icon)}${esc(entry.label)}`;
    pill.addEventListener('click', () => entry.run(pill));
    nav.appendChild(pill);

    const item = document.createElement('button');
    item.className = `dock-item${index === 0 ? ' active' : ''}`;
    item.innerHTML = `${svg(entry.icon)}<span>${esc(entry.short || entry.label)}</span>`;
    item.addEventListener('click', () => entry.run(item));
    dock.appendChild(item);
  });

  // The account menu belongs within thumb reach on a phone.
  const account = document.createElement('button');
  account.className = 'dock-item';
  account.setAttribute('aria-label', t('set.account'));
  account.innerHTML = `${svg('user-circle')}<span>${esc(t('dock.account'))}</span>`;
  account.addEventListener('click', (event) => { event.stopPropagation(); toggleAccountMenu(); });
  dock.appendChild(account);
}

/* ------------------------------- shortcuts ------------------------------- */

function linkCardInner(link, { showCaret }) {
  const sheen = `<div class="sheen" style="background:linear-gradient(180deg,transparent,${esc(link.color)})"></div>`;
  const caret = showCaret ? `<div class="caret">${svg('caret-down', 'font-size:12px')}</div>` : '';
  const subtitle = link.items ? t('apps.links', { n: link.items.length }) : t('apps.direct');
  return `${sheen}${caret}<div class="appic" style="background:${esc(link.color)};box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 10px 24px ${esc(link.color)}44">${svg(link.icon)}</div>` +
    `<div><div class="app-tt">${esc(link.title)}</div><div class="app-sub">${esc(subtitle)}</div></div>`;
}

function renderLinks() {
  const grid = id('links-grid');
  safe(id('apps-count'), t('apps.shortcuts', { n: state.config.links.length }));
  grid.innerHTML = state.config.links
    .map((link, index) => {
      const inner = linkCardInner(link, { showCaret: Boolean(link.items) });
      return link.items
        ? `<button class="app" data-link="${index}" data-folder="1">${inner}</button>`
        : `<a class="app" data-link="${index}" href="${esc(link.url)}" target="_blank" rel="noopener">${inner}</a>`;
    })
    .join('');
  grid.querySelectorAll('[data-folder]').forEach((el) => {
    // In edit mode too: that is where its links are added and rearranged.
    el.addEventListener('click', () => openFolder(Number(el.dataset.link)));
  });
  if (state.editing) decorateLinksForEditing();
}

function openFolder(index) {
  const folder = state.config.links[index];
  if (!folder?.items) return;
  safe(id('folder-modal-title'), folder.title);
  id('folder-modal-icon-bg').style.background = folder.color;
  id('folder-modal-icon').innerHTML = PH[iconName(folder.icon)] || '';
  id('folder-modal').dataset.folder = index;
  id('folder-links-grid').innerHTML = folder.items
    .map(
      (item, i) =>
        `<a class="app" data-item="${i}" href="${esc(item.url)}" target="_blank" rel="noopener">` +
        `<div class="appic" style="background:${esc(item.color)};box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 8px 18px ${esc(item.color)}44">${svg(item.icon)}</div>` +
        `<div><div class="app-tt">${esc(item.title)}</div><div class="app-sub">${esc(t('apps.direct'))}</div></div></a>`
    )
    .join('');
  if (state.editing) decorateFolderForEditing(index);
  id('folder-modal').classList.add('open');
}
const closeFolder = () => id('folder-modal').classList.remove('open');

/* --------------------------------- tiles --------------------------------- */

function weatherTileMarkup(tile, index, { local }) {
  const delay = `animation-delay:.${String(5 * (index + 1)).padStart(2, '0')}s`;
  const label = local
    ? esc(tile.settings.label || t('tile.localPosition'))
    : esc(tile.settings.name || t('tile.followedCity'));
  const heading = local
    ? `<h3 data-role="place">${esc(t('tile.searching'))}</h3>`
    : `<h3>${esc(t('tile.followedCity'))} <span data-role="clock" class="muted" style="font-weight:600"></span></h3>`;
  return `<article class="card glass wx rise" style="${delay}" data-tile="${tile.id}" data-type="${tile.type}">
        <div class="wtop"><div><div class="lbl">${label}</div>${heading}</div><div data-role="emoji" class="emoji">${local ? '🧭' : '🏙️'}</div></div>
        <div class="wmain"><div data-role="temp" class="temp">--°</div><div class="wstats"><span>${esc(t('tile.wind'))} <strong data-role="wind">--</strong> km/h</span><span>${esc(t('tile.rain'))} <strong data-role="rain">--</strong>%</span><span class="wsun" data-role="sun"></span></div></div>
        <div class="spark"><canvas id="spark-${tile.id}"></canvas></div></article>`;
}

function georideTileMarkup(tile, index) {
  const delay = `animation-delay:.${String(5 * (index + 1)).padStart(2, '0')}s`;
  return `<article class="card glass rise georide" style="${delay}" data-tile="${tile.id}" data-type="georide">
        <div class="wtop"><div><div class="lbl">${esc(t('gr.title'))}</div><h3 data-role="name">…</h3></div><div class="emoji">${svg('motorcycle', 'font-size:28px')}</div></div>
        <div class="gr-stats" data-role="stats"></div>
        <div class="gr-map" data-role="map"><div class="gr-map-empty">${esc(t('gr.noPosition'))}</div></div>
        <div class="insight-foot"><div class="dot" data-role="dot"></div><span data-role="foot">…</span></div></article>`;
}

function parcelsTileMarkup(tile, index) {
  const delay = `animation-delay:.${String(5 * (index + 1)).padStart(2, '0')}s`;
  return `<article class="card glass rise parcels" style="${delay}" data-tile="${tile.id}" data-type="parcels">
        <div class="wtop"><div><div class="lbl">${esc(t('pc.title'))}</div><h3 data-role="head">…</h3></div><div class="emoji">${svg('package', 'font-size:28px')}</div></div>
        <div class="pc-list" data-role="list"></div>
        <div class="insight-foot"><div class="dot" data-role="dot"></div><span data-role="foot">…</span></div></article>`;
}

function noteTileMarkup(tile, index) {
  const delay = `animation-delay:.${String(5 * (index + 1)).padStart(2, '0')}s`;
  return `<article class="card glass insight rise" style="${delay}" data-tile="${tile.id}" data-type="note">
        <div class="lbl">${esc(t('note.heading'))}</div><h3>${esc(tile.settings.heading || '')}</h3>
        <p>${esc(tile.settings.body || '')}</p>
        <div class="insight-foot"><div class="dot"></div><span>${esc(state.config.site.title)}</span></div></article>`;
}

function renderTiles() {
  const grid = id('tiles');
  const tiles = state.config.tiles;
  grid.style.gridTemplateColumns = tiles.length
    ? tiles.map((tile) => `${tile.span}fr`).join(' ')
    : '1fr';
  grid.innerHTML = tiles
    .map((tile, index) => {
      if (tile.type === 'weather-local') return weatherTileMarkup(tile, index, { local: true });
      if (tile.type === 'weather-secondary') return weatherTileMarkup(tile, index, { local: false });
      if (tile.type === 'georide') return georideTileMarkup(tile, index);
      if (tile.type === 'parcels') return parcelsTileMarkup(tile, index);
      return noteTileMarkup(tile, index);
    })
    .join('');

  grid.querySelectorAll('[data-type^="weather"]').forEach((article) => {
    article.addEventListener('click', () => {
      if (state.editing) return;
      openWeatherModal(article.dataset.tile);
    });
  });

  grid.querySelectorAll('[data-type="georide"]').forEach((article) => {
    article.addEventListener('click', (event) => {
      if (state.editing || event.target.closest('.gr-map')) return; // the small map pans on its own
      openGeorideModal();
    });
  });

  grid.querySelectorAll('[data-type="parcels"]').forEach((article) => {
    article.addEventListener('click', () => {
      if (state.editing) return;
      openParcelsModal();
    });
  });

  destroyMap();
  if (state.editing) decorateTilesForEditing();
}

const tileElement = (tileId) => document.querySelector(`[data-tile="${CSS.escape(tileId)}"]`);

/* --------------------------------- charts -------------------------------- */
/* Same tiny canvas renderer as the original page: no charting library. */

function fitCanvas(canvas) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  canvas._w = rect.width;
  canvas._h = rect.height;
  return ctx;
}

function smooth(ctx, points) {
  if (!points.length) return;
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 0; i < points.length - 1; i += 1) {
    const xc = (points[i].x + points[i + 1].x) / 2;
    const yc = (points[i].y + points[i + 1].y) / 2;
    ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
  }
  const last = points[points.length - 1];
  ctx.quadraticCurveTo(last.x, last.y, last.x, last.y);
}

function drawSpark(canvasId, data, color) {
  const canvas = id(canvasId);
  if (!canvas || !data?.length) return;
  canvas._spark = { data, color };
  const ctx = fitCanvas(canvas);
  if (!ctx) return;
  const w = canvas._w;
  const h = canvas._h;
  const pad = 5;
  let min = Math.min(...data);
  let max = Math.max(...data);
  if (min === max) { min -= 1; max += 1; }
  const points = data.map((v, i) => ({ x: (i / (data.length - 1)) * w, y: pad + (1 - (v - min) / (max - min)) * (h - pad * 2) }));
  ctx.beginPath();
  smooth(ctx, points);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

/* -------------------------------- weather -------------------------------- */

function updateWeatherTile(tile) {
  const article = tileElement(tile.id);
  const data = state.forecasts[tile.id];
  if (!article || !data?.current || !data?.daily) return;
  const current = data.current;
  const daily = data.daily;
  const el = (role) => article.querySelector(`[data-role="${role}"]`);
  safe(el('temp'), `${Math.round(current.temperature_2m)}°`);
  safe(el('wind'), Math.round(current.wind_speed_10m ?? daily.wind_speed_10m_max?.[0] ?? 0));
  safe(el('rain'), daily.precipitation_probability_max?.[0] ?? 0);
  safe(el('emoji'), weatherEmoji(current.weather_code || 0));
  const sun = el('sun');
  if (sun) {
    // Open-Meteo returns null for both inside a polar day or night. Showing
    // nothing is the honest answer there; "--:--" would read as a failure.
    const rise = clockOf(daily.sunrise?.[0]);
    const set = clockOf(daily.sunset?.[0]);
    sun.innerHTML = rise && set
      ? `${svg('sun', 'font-size:13px')} ${esc(rise)} <span class="wsun-sep">·</span> ${svg('moon', 'font-size:13px')} ${esc(set)}`
      : '';
  }
  if (data.hourly?.temperature_2m) {
    drawSpark(`spark-${tile.id}`, data.hourly.temperature_2m.slice(0, 24), tile.type === 'weather-local' ? '#0a84ff' : '#a78bff');
  }
  if (tile.type === 'weather-local') {
    const place = state.places[tile.id];
    if (place) safe(el('place'), place);
  }
}

async function loadWeatherTile(tile) {
  const weather = state.config.integrations.weather;
  if (!weather.enabled) return;
  let latitude;
  let longitude;

  if (tile.type === 'weather-secondary') {
    latitude = tile.settings.latitude;
    longitude = tile.settings.longitude;
  } else {
    const position = await currentPosition(weather);
    latitude = position.latitude;
    longitude = position.longitude;
    if (weather.reverseGeocoding) {
      try {
        const place = await api(`/api/integrations/weather/place?latitude=${latitude}&longitude=${longitude}`);
        state.places[tile.id] = place.name || t('tile.localPosition');
      } catch {
        state.places[tile.id] = t('tile.localPosition');
      }
    }
  }

  state.coords[tile.id] = { latitude, longitude };
  try {
    const payload = await api(`/api/integrations/weather/forecast?latitude=${latitude}&longitude=${longitude}`);
    state.forecasts[tile.id] = payload.forecast;
    updateWeatherTile(tile);
  } catch {
    const article = tileElement(tile.id);
    if (article) safe(article.querySelector('[data-role="place"]'), t('wx.unavailable'));
  }
}

/** Browser geolocation when enabled, otherwise the configured fallback. */
function currentPosition(weather) {
  const fallback = { latitude: weather.fallback.latitude, longitude: weather.fallback.longitude };
  if (!weather.useBrowserGeolocation || !navigator.geolocation) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      () => resolve(fallback),
      { timeout: 8000, maximumAge: 600000 }
    );
  });
}

function loadWeather() {
  state.config.tiles
    .filter((tile) => tile.type === 'weather-local' || tile.type === 'weather-secondary')
    .forEach((tile) => loadWeatherTile(tile));
}

/* ----------------------------- weather modal ----------------------------- */

function renderDays() {
  const container = id('modal-day-selector');
  const data = state.forecasts[state.modalTile];
  if (!data?.daily?.time) return;
  container.innerHTML = '';
  const today = localDayKey();
  data.daily.time.forEach((day, index) => {
    const [y, m, d] = day.split('-');
    const date = new Date(y, m - 1, d);
    const button = document.createElement('button');
    button.className = `day-btn${index === state.selectedDay ? ' active' : ''}`;
    const dayName = day === today
      ? t('wx.todayShort')
      : date.toLocaleDateString(state.config.site.locale, { weekday: 'short' });
    button.innerHTML = `<span class="dn">${esc(dayName)}</span><span class="dd">${date.getDate()}</span>`;
    button.addEventListener('click', () => { state.selectedDay = index; renderDays(); updateWeatherModal(); });
    container.appendChild(button);
  });
}

function updateWeatherModal() {
  const data = state.forecasts[state.modalTile];
  const daily = data?.daily;
  const i = state.selectedDay;
  if (!daily?.temperature_2m_max?.length) return;

  const [y, m, d] = daily.time[i].split('-');
  const date = new Date(y, m - 1, d);
  const today = localDayKey();
  safe(
    id('modal-date-label'),
    daily.time[i] === today
      ? t('wx.today')
      : date.toLocaleDateString(state.config.site.locale, { weekday: 'long', day: 'numeric', month: 'long' })
  );
  safe(id('modal-temp'), `${Math.round(daily.temperature_2m_max[i])}°`);
  safe(id('modal-icon'), weatherEmoji(daily.weather_code[i] || 0));
  safe(id('modal-wind'), Math.round(daily.wind_speed_10m_max[i] || 0));
  safe(id('modal-rain'), daily.precipitation_probability_max[i] || 0);
  id('modal-rain-box').classList.toggle('alert', (daily.precipitation_probability_max[i] || 0) >= 50);

  renderDayCurve();
}

function openWeatherModal(tileId) {
  if (!state.forecasts[tileId]) return;
  const tile = state.config.tiles.find((item) => item.id === tileId);
  state.modalTile = tileId;
  state.selectedDay = 0;
  safe(
    id('modal-city'),
    tile.type === 'weather-local'
      ? state.places[tileId] || t('tile.localPosition')
      : tile.settings.name || t('tile.followedCity')
  );
  id('weather-modal').classList.add('open');
  renderDays();
  updateWeatherModal();
}

/* --------------------------- weather: day curve --------------------------- */
/* One SVG for the whole day: the sun and moon course over the horizon, the
   rain as bars, the temperature as a line, and a cursor that reads any hour
   under the pointer. Every colour lives in app-extra.css, so a preset change
   or a light/dark switch costs nothing and needs no redraw — which is the
   reason this is SVG and not one more canvas. */

/* The bands are fixed heights; only the width follows the column. The svg
   keeps its aspect ratio, so a viewBox of a fixed width would render about
   95 px tall inside a phone sheet and unreadable. Measuring the column and
   sizing the viewBox to it instead keeps the drawing ~182 px tall at every
   width, and keeps one user unit worth about one real pixel, so the font
   sizes below stay the sizes they say they are. */
const WC = {
  w: 720, h: 182,
  padX: 26,
  skyBottom: 56,           // the horizon
  tempTop: 66, tempBottom: 132,
  rainBottom: 158, rainMax: 26,
  hourY: 176,
  plotW: 720 - 26 * 2,
  hourStep: 3,             // a label every N hours; 6 when the column is narrow
};
const SUN_H = 44;          // how high the sun climbs above the horizon
const MOON_H = 22;         // the night course is deliberately shallower

/** Fit the viewBox to the column the curve is actually rendered in. */
function wcFit(width) {
  WC.w = Math.round(Math.max(300, Math.min(960, width)));
  WC.padX = WC.w < 420 ? 16 : 26;
  WC.plotW = WC.w - WC.padX * 2;
  WC.hourStep = WC.w < 420 ? 6 : 3;
}

/** Hour of the day, as a fraction, from an Open-Meteo local timestamp. */
function hourOf(stamp) {
  if (typeof stamp !== 'string' || stamp.length < 16) return null;
  const h = Number(stamp.slice(11, 13));
  const m = Number(stamp.slice(14, 16));
  return Number.isFinite(h) && Number.isFinite(m) ? h + m / 60 : null;
}

const wcX = (hour) => WC.padX + (Math.max(0, Math.min(24, hour)) / 24) * WC.plotW;

function svgNode(name, attrs = {}, className) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (className) node.setAttribute('class', className);
  return node;
}

/** Quadratic-midpoint smoothing, the same shape the canvas charts used. */
function smoothPath(points) {
  if (!points.length) return '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const xc = (points[i].x + points[i + 1].x) / 2;
    const yc = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x} ${points[i].y} ${xc} ${yc}`;
  }
  const last = points[points.length - 1];
  return `${d} Q ${last.x} ${last.y} ${last.x} ${last.y}`;
}

/** The selected day, folded into one object the renderer and the cursor share. */
function dayCurveModel() {
  const data = state.forecasts[state.modalTile];
  const hourly = data?.hourly;
  const daily = data?.daily;
  if (!hourly?.time || !daily?.time) return null;

  const start = state.selectedDay * 24;
  const at = (series, k) => (Array.isArray(series) ? series[start + k] : undefined);
  const hours = [];
  for (let k = 0; k < 24; k += 1) {
    const stamp = at(hourly.time, k);
    if (stamp === undefined) break;
    hours.push({
      hour: hourOf(stamp) ?? k,
      temp: Number(at(hourly.temperature_2m, k)),
      feels: Number(at(hourly.apparent_temperature, k)),
      rain: Number(at(hourly.precipitation_probability, k)) || 0,
      wind: Number(at(hourly.wind_speed_10m, k)),
      code: Number(at(hourly.weather_code, k)) || 0,
      day: at(hourly.is_day, k) !== 0,
    });
  }
  if (hours.length < 2 || hours.some((h) => !Number.isFinite(h.temp))) return null;

  const temps = hours.map((h) => h.temp);
  let min = Math.min(...temps);
  let max = Math.max(...temps);
  if (max - min < 2) { const mid = (min + max) / 2; min = mid - 1; max = mid + 1; }

  const isToday = daily.time[state.selectedDay] === localDayKey();
  return {
    hours,
    min,
    max,
    minIndex: temps.indexOf(Math.min(...temps)),
    maxIndex: temps.indexOf(Math.max(...temps)),
    sunrise: hourOf(daily.sunrise?.[state.selectedDay]),
    sunset: hourOf(daily.sunset?.[state.selectedDay]),
    isToday,
    nowHour: isToday ? new Date().getHours() + new Date().getMinutes() / 60 : null,
  };
}


/** A point on an astre's course, as a half-sine between its rise and its set.
 *  The course is allowed to start before midnight or end after it — the night
 *  one always does — and only the visible stretch is ever drawn. */
const arcPoint = (rise, set, height, hour) => ({
  x: wcX(hour),
  y: WC.skyBottom - Math.sin(Math.PI * ((hour - rise) / (set - rise))) * height,
});

/** The course from `rise` to `set`, drawn only between `from` and `to`.
 *  Separating the two is what keeps the night arcs honest: their course runs
 *  from one evening to the next morning, so clamping it into the box instead
 *  of clipping it would flatten half of it against the left edge. */
function arcPath(rise, set, height, from = rise, to = set) {
  if (![rise, set, from, to].every(Number.isFinite) || set <= rise || to <= from) return '';
  const steps = 48;
  const points = [];
  for (let s = 0; s <= steps; s += 1) {
    const p = arcPoint(rise, set, height, from + (to - from) * (s / steps));
    points.push(`${s ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
  }
  return points.join(' ');
}

function renderDayCurve() {
  const plot = id('wc-plot');
  const wrap = id('wx-curve');
  if (!plot || !wrap) return;
  const model = dayCurveModel();
  state.curve = model;
  if (!model) { plot.innerHTML = `<p class="muted">${esc(t('wx.unavailable'))}</p>`; return; }
  // A hidden modal measures 0: fall back to the last good width rather than
  // drawing a curve one pixel wide.
  const measured = plot.getBoundingClientRect().width;
  wcFit(measured > 40 ? measured : (state.curveWidth || 720));
  state.curveWidth = WC.w;

  const { hours, min, max } = model;
  const tempH = WC.tempBottom - WC.tempTop;
  const Y = (value) => WC.tempTop + (1 - (value - min) / (max - min)) * tempH;
  const points = hours.map((h) => ({ x: wcX(h.hour), y: Y(h.temp) }));
  const line = smoothPath(points);

  const svgRoot = svgNode('svg', {
    viewBox: `0 0 ${WC.w} ${WC.h}`,
    preserveAspectRatio: 'xMidYMid meet',
    'aria-hidden': 'true',
  }, 'wc-svg');

  /* The past is dimmed by clipping the same paths twice rather than by veiling
     the region: a veil would also dim whatever wallpaper shows through. */
  const nowX = model.nowHour === null ? null : wcX(model.nowHour);
  const defs = svgNode('defs');
  if (nowX !== null) {
    const clip = svgNode('clipPath', { id: 'wc-clip-past' });
    clip.appendChild(svgNode('rect', { x: 0, y: 0, width: nowX, height: WC.h }));
    defs.appendChild(clip);
  }
  svgRoot.appendChild(defs);

  /* ---- sky: stars, the two courses, the sun or the moon ---- */
  const sky = svgNode('g', {}, 'wc-sky');
  const { sunrise, sunset } = model;
  const hasSun = Number.isFinite(sunrise) && Number.isFinite(sunset) && sunset > sunrise;

  if (hasSun) {
    const stars = svgNode('g', {}, 'wc-stars');
    // Deterministic placement: the same day always gets the same sky, so the
    // stars do not jump around when the curve is redrawn.
    let seed = state.selectedDay * 7919 + 13;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let s = 0; s < 26; s += 1) {
      const hour = random() * 24;
      if (hour > sunrise - 0.6 && hour < sunset + 0.6) continue;
      const star = svgNode('circle', {
        cx: wcX(hour).toFixed(1),
        cy: (6 + random() * (WC.skyBottom - 14)).toFixed(1),
        r: (0.7 + random() * 0.9).toFixed(2),
      });
      star.style.animationDelay = `${(random() * 3).toFixed(2)}s`;
      stars.appendChild(star);
    }
    sky.appendChild(stars);

    sky.appendChild(svgNode('path', { d: arcPath(sunrise, sunset, SUN_H) }, 'wc-arc wc-arc-sun'));
    // The night shows as two stretches of one course that straddles midnight:
    // the end of last night up to sunrise, and from sunset into the next one.
    sky.appendChild(svgNode('path', {
      d: arcPath(sunset - 24, sunrise, MOON_H, 0, sunrise),
    }, 'wc-arc wc-arc-moon'));
    sky.appendChild(svgNode('path', {
      d: arcPath(sunset, sunrise + 24, MOON_H, sunset, 24),
    }, 'wc-arc wc-arc-moon'));
    sky.appendChild(svgNode('line', {
      x1: WC.padX, y1: WC.skyBottom, x2: WC.w - WC.padX, y2: WC.skyBottom,
    }, 'wc-horizon'));

    if (model.nowHour !== null) {
      const now = model.nowHour;
      if (now > sunrise && now < sunset) {
        // The part of the course already run, as a solid overlay.
        sky.appendChild(svgNode('path', {
          d: arcPath(sunrise, sunset, SUN_H, sunrise, now),
        }, 'wc-arc-done wc-arc-sun'));
        const p = arcPoint(sunrise, sunset, SUN_H, now);
        sky.appendChild(svgNode('circle', { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 11 }, 'wc-sun-halo'));
        const rays = svgNode('g', {}, 'wc-sun-rays');
        for (let r = 0; r < 8; r += 1) {
          const angle = (r / 8) * Math.PI * 2;
          rays.appendChild(svgNode('line', {
            x1: (p.x + Math.cos(angle) * 7.5).toFixed(1), y1: (p.y + Math.sin(angle) * 7.5).toFixed(1),
            x2: (p.x + Math.cos(angle) * 10.5).toFixed(1), y2: (p.y + Math.sin(angle) * 10.5).toFixed(1),
          }));
        }
        sky.appendChild(rays);
        sky.appendChild(svgNode('circle', { cx: p.x.toFixed(1), cy: p.y.toFixed(1), r: 5.4 }, 'wc-sun-disc'));
      } else {
        // A crescent: the lit disc, with a second disc offset over it.
        const night = now > sunset
          ? arcPoint(sunset, sunrise + 24, MOON_H, now)
          : arcPoint(sunset - 24, sunrise, MOON_H, now);
        const moon = svgNode('g', {}, 'wc-moon');
        moon.appendChild(svgNode('circle', { cx: night.x.toFixed(1), cy: night.y.toFixed(1), r: 5 }, 'wc-moon-disc'));
        moon.appendChild(svgNode('circle', { cx: (night.x + 2.6).toFixed(1), cy: (night.y - 1.4).toFixed(1), r: 4.4 }, 'wc-moon-shadow'));
        sky.appendChild(moon);
      }
    }
  }
  svgRoot.appendChild(sky);

  /* ---- rain ---- */
  const rains = svgNode('g', {}, 'wc-rains');
  const barW = Math.max(3, (WC.plotW / 24) * 0.5);
  hours.forEach((h, k) => {
    if (!h.rain) return;
    const height = Math.max(1.5, (h.rain / 100) * WC.rainMax);
    const bar = svgNode('rect', {
      x: (wcX(h.hour) - barW / 2).toFixed(1),
      y: (WC.rainBottom - height).toFixed(1),
      width: barW.toFixed(1),
      height: height.toFixed(1),
      rx: Math.min(2, barW / 2),
      'data-k': k,
    }, 'wc-rain');
    rains.appendChild(bar);
  });
  svgRoot.appendChild(rains);

  /* ---- temperature ---- */
  const area = `${line} L ${points[points.length - 1].x} ${WC.tempBottom} L ${points[0].x} ${WC.tempBottom} Z`;
  svgRoot.appendChild(svgNode('path', { d: area }, 'wc-area'));
  svgRoot.appendChild(svgNode('path', { d: line }, 'wc-glow'));
  svgRoot.appendChild(svgNode('path', { d: line }, 'wc-line'));
  if (nowX !== null) {
    svgRoot.appendChild(svgNode('path', { d: line, 'clip-path': 'url(#wc-clip-past)' }, 'wc-glow wc-past'));
    svgRoot.appendChild(svgNode('path', { d: line, 'clip-path': 'url(#wc-clip-past)' }, 'wc-line wc-past'));
  }

  /* ---- the two extremes, labelled where they happen ---- */
  [model.maxIndex, model.minIndex].forEach((k, which) => {
    const p = points[k];
    if (!p) return;
    const label = svgNode('text', {
      x: Math.max(WC.padX, Math.min(WC.w - WC.padX, p.x)).toFixed(1),
      y: (which === 0 ? p.y - 9 : p.y + 16).toFixed(1),
      'text-anchor': 'middle',
    }, 'wc-extreme');
    label.textContent = `${Math.round(hours[k].temp)}°`;
    svgRoot.appendChild(label);
  });

  /* ---- hour labels, every three hours ---- */
  hours.forEach((h, k) => {
    if (k % WC.hourStep) return;
    const label = svgNode('text', {
      x: wcX(h.hour).toFixed(1), y: WC.hourY, 'text-anchor': 'middle',
    }, 'wc-hour');
    label.textContent = String(Math.floor(h.hour)).padStart(2, '0');
    svgRoot.appendChild(label);
  });

  /* ---- the present hour ---- */
  if (nowX !== null) {
    const nowTemp = curveValueAt(model, model.nowHour);
    const now = svgNode('g', {}, 'wc-now');
    now.appendChild(svgNode('line', { x1: nowX.toFixed(1), y1: WC.tempTop - 6, x2: nowX.toFixed(1), y2: WC.rainBottom }));
    if (nowTemp !== null) {
      now.appendChild(svgNode('circle', { cx: nowX.toFixed(1), cy: Y(nowTemp).toFixed(1), r: 3.2 }, 'wc-now-pulse'));
      now.appendChild(svgNode('circle', { cx: nowX.toFixed(1), cy: Y(nowTemp).toFixed(1), r: 3.2 }, 'wc-now-dot'));
    }
    svgRoot.appendChild(now);
  }

  /* ---- cursor, built once and only moved afterwards ---- */
  const cursorLine = svgNode('line', {
    x1: 0, y1: WC.skyBottom - 2, x2: 0, y2: WC.rainBottom,
  }, 'wc-cursor-line');
  const cursor = svgNode('g', {}, 'wc-cursor');
  cursor.appendChild(svgNode('circle', { cx: 0, cy: 0, r: 7 }, 'wc-cursor-halo'));
  cursor.appendChild(svgNode('circle', { cx: 0, cy: 0, r: 3.6 }, 'wc-cursor-dot'));
  const bubble = svgNode('g', {}, 'wc-bubble');
  bubble.appendChild(svgNode('rect', { x: -18, y: -12, width: 36, height: 17, rx: 6 }));
  const bubbleText = svgNode('text', { x: 0, y: 0, 'text-anchor': 'middle' });
  bubble.appendChild(bubbleText);
  svgRoot.append(cursorLine, cursor, bubble);

  plot.innerHTML = '';
  plot.appendChild(svgRoot);

  state.curveNodes = { svg: svgRoot, cursorLine, cursor, bubble, bubbleText, Y, points };
  wrap.classList.remove('wc-intro');
  // Restart the intro animation on every render: the class has to leave the
  // element and come back, with a reflow in between, or nothing replays.
  void wrap.offsetWidth;
  wrap.classList.add('wc-intro');
  wrap.classList.remove('reading');
  wrap.setAttribute('aria-valuemin', '0');
  wrap.setAttribute('aria-valuemax', String(model.hours.length - 1));
  wrap.removeAttribute('aria-valuenow');
  wrap.removeAttribute('aria-valuetext');
  renderCurveHeader(model);
}


/** Temperature at a fractional hour, interpolated between the two readings. */
function curveValueAt(model, hour) {
  const hours = model.hours;
  const k = Math.floor(hour);
  const a = hours[Math.max(0, Math.min(hours.length - 1, k))];
  const b = hours[Math.max(0, Math.min(hours.length - 1, k + 1))];
  if (!a) return null;
  if (!b || a === b) return a.temp;
  return a.temp + (b.temp - a.temp) * (hour - k);
}

function renderCurveHeader(model) {
  const range = id('wc-range');
  const sun = id('wc-sun');
  if (range) {
    range.innerHTML = `${Math.round(model.min)}°<i>→</i>${Math.round(model.max)}°`;
  }
  if (!sun) return;
  const clock = (hour) => {
    if (!Number.isFinite(hour)) return '—';
    const h = Math.floor(hour);
    return `${String(h).padStart(2, '0')}:${String(Math.round((hour - h) * 60)).padStart(2, '0')}`;
  };
  sun.innerHTML =
    `<span class="wc-astre sunrise" title="${esc(t('wx.sunrise'))}">${svg('sun')}${clock(model.sunrise)}</span>` +
    `<span class="wc-astre sunset" title="${esc(t('wx.sunset'))}">${svg('moon')}${clock(model.sunset)}</span>`;
}

/** Move the cursor to an hour index, or clear the reading when given null. */
function readCurveAt(index) {
  const wrap = id('wx-curve');
  const model = state.curve;
  const nodes = state.curveNodes;
  if (!wrap || !model || !nodes) return;

  if (index === null) {
    wrap.classList.remove('reading');
    state.curveIndex = null;
    wrap.removeAttribute('aria-valuenow');
    wrap.removeAttribute('aria-valuetext');
    nodes.svg.querySelectorAll('.wc-rain.aimed').forEach((bar) => bar.classList.remove('aimed'));
    return;
  }

  const k = Math.max(0, Math.min(model.hours.length - 1, Math.round(index)));
  state.curveIndex = k;
  const h = model.hours[k];
  const point = nodes.points[k];

  nodes.cursorLine.setAttribute('x1', point.x.toFixed(1));
  nodes.cursorLine.setAttribute('x2', point.x.toFixed(1));
  nodes.cursor.setAttribute('transform', `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`);
  // The bubble is held inside the box at both ends, or it would hang off the
  // edge on the first and the last hour.
  const bubbleX = Math.max(WC.padX - 4, Math.min(WC.w - WC.padX + 4, point.x));
  nodes.bubble.setAttribute('transform', `translate(${bubbleX.toFixed(1)} ${(point.y - 12).toFixed(1)})`);
  nodes.bubbleText.textContent = `${Math.round(h.temp)}°`;

  nodes.svg.querySelectorAll('.wc-rain').forEach((bar) => {
    bar.classList.toggle('aimed', Number(bar.dataset.k) === k);
  });

  const read = id('wc-read');
  if (read) {
    const hourLabel = `${String(Math.floor(h.hour)).padStart(2, '0')}:00`;
    const feels = t('wx.feelsLike', { value: Math.round(h.feels) });
    const rain = t('wx.rainShort', { value: h.rain });
    const wind = t('wx.windShort', { value: Math.round(h.wind) });
    const showFeels = Number.isFinite(h.feels) && Math.round(h.feels) !== Math.round(h.temp);
    const parts = [
      `<span class="wc-r-hour">${esc(hourLabel)}</span>`,
      `<span class="wc-r-sky">${weatherEmoji(h.code, h.day)}</span>`,
      `<span class="wc-r-temp">${Math.round(h.temp)}°</span>`,
    ];
    const spoken = [hourLabel, `${Math.round(h.temp)}°`];
    if (showFeels) {
      parts.push(`<span class="wc-r-feels">${esc(feels)}</span>`);
      spoken.push(feels);
    }
    parts.push(`<span class="wc-r-rain">${esc(rain)}</span>`);
    spoken.push(rain);
    if (Number.isFinite(h.wind)) {
      parts.push(`<span class="wc-r-wind">${esc(wind)}</span>`);
      spoken.push(wind);
    }
    read.innerHTML = parts.join('');
    wrap.setAttribute('aria-valuenow', k);
    // Built from the parts rather than read back off the element: on screen
    // they are spaced by a flex gap, so the text content of the row runs the
    // values together and a screen reader would say "14 degrees8 km/h".
    wrap.setAttribute('aria-valuetext', spoken.join(', '));
  }
  wrap.classList.add('reading');
}

/** Pointer position to an hour index. The svg scales, so the ratio has to be
 *  taken from the rendered box and not from the viewBox. */
function curveIndexFromEvent(event) {
  const plot = id('wc-plot');
  const model = state.curve;
  if (!plot || !model) return null;
  const rect = plot.getBoundingClientRect();
  if (rect.width < 2) return null;
  const ratio = (event.clientX - rect.left) / rect.width;
  const hour = (((ratio * WC.w) - WC.padX) / WC.plotW) * 24;
  return Math.max(0, Math.min(model.hours.length - 1, Math.round(hour)));
}

function bindDayCurve() {
  const wrap = id('wx-curve');
  const plot = id('wc-plot');
  if (!wrap || !plot) return;

  // Pointer events cover mouse, pen and touch in one path. The plot keeps
  // touch-action: pan-y, so a vertical swipe still scrolls the sheet while a
  // horizontal drag reads the curve.
  plot.addEventListener('pointermove', (event) => readCurveAt(curveIndexFromEvent(event)));
  plot.addEventListener('pointerdown', (event) => readCurveAt(curveIndexFromEvent(event)));
  plot.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') readCurveAt(null);
  });
  plot.addEventListener('pointercancel', () => readCurveAt(null));

  wrap.addEventListener('keydown', (event) => {
    const model = state.curve;
    if (!model) return;
    // Escape clears the reading, but only when there is one. Letting it
    // through otherwise is what keeps the second press closing the modal,
    // which is what every other panel in here does.
    if (event.key === 'Escape') {
      if (state.curveIndex === null) return;
      event.preventDefault();
      event.stopPropagation();
      readCurveAt(null);
      return;
    }
    const last = model.hours.length - 1;
    const current = state.curveIndex ?? (model.nowHour === null ? 12 : Math.round(model.nowHour));
    const keys = {
      ArrowLeft: () => readCurveAt(current - 1),
      ArrowRight: () => readCurveAt(current + 1),
      Home: () => readCurveAt(0),
      End: () => readCurveAt(last),
    };
    if (!keys[event.key]) return;
    event.preventDefault();
    keys[event.key]();
  });
  wrap.addEventListener('blur', () => readCurveAt(null));
}

/* -------------------------------- GeoRide -------------------------------- */

const MAP_TILE_URL = '/api/integrations/map/tile/{z}/{x}/{y}.png';

function refreshMapTheme(container = state.map?.getContainer()) {
  if (container) container.classList.toggle('map-dark', html.getAttribute('data-theme') === 'dark');
}

/** Leaflet keeps global listeners alive, so a discarded map has to be told. */
function destroyMap() {
  if (state.map) {
    try { state.map.remove(); } catch { /* already detached */ }
  }
  state.map = null;
  state.marker = null;
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
  state.marker = L.marker([position.latitude, position.longitude], { icon }).addTo(map);
  state.map = map;
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
// The whole month is fetched once and the shorter periods are slices of it, so
// switching period or trip never waits on the network.
const TRIP_WINDOW_DAYS = 30;

const tripKey = (trip) => `${trip.id ?? ''}|${trip.startTime}`;

function destroyTripMap() {
  if (state.tripMap) {
    try { state.tripMap.remove(); } catch { /* already detached */ }
  }
  state.tripMap = null;
  state.tripLayers = null;
  state.tripGroup = null;
  state.tripMarkers = null;
  // Leaflet detaches its listeners; the container is ours to drop.
  const holder = id('gr-track');
  if (holder) holder.innerHTML = '';
}

function closeGeorideModal() {
  id('georide-modal').classList.remove('open');
  destroyTripMap();
}

async function openGeorideModal() {
  if (!state.georide?.ok) return;
  safe(id('gr-modal-title'), state.config.integrations.georide.trackerName || state.georide.tracker.name);
  state.tripPeriod = state.tripPeriod ?? state.config.integrations.georide.periodDays ?? 7;
  state.selectedTrip = 'all';
  id('georide-modal').classList.add('open');
  renderTripPeriods();
  if (state.trips) renderTrips();   // prefetched while the dashboard loaded
  else await loadTrips();
}

function renderTripPeriods() {
  const holder = id('gr-period');
  holder.innerHTML = '';
  TRIP_PERIODS.forEach((days) => {
    const button = document.createElement('button');
    button.className = `day-btn${days === state.tripPeriod ? ' active' : ''}`;
    button.innerHTML = `<span class="dn">${esc(t(`gr.p${days}`))}</span>`;
    button.addEventListener('click', () => {
      if (days === state.tripPeriod) return;
      state.tripPeriod = days;
      state.selectedTrip = 'all';
      renderTripPeriods();
      renderTrips();               // already downloaded: no round trip
    });
    holder.appendChild(button);
  });
}

/** Fetch the month once. Called in the background as the dashboard settles. */
async function loadTrips({ quiet = false } = {}) {
  if (!quiet) id('gr-trip-list').innerHTML = `<p class="gr-empty">${esc(t('gr.loading'))}</p>`;
  try {
    state.trips = await api(`/api/integrations/georide/trips?days=${TRIP_WINDOW_DAYS}`);
  } catch (error) {
    state.trips = { ok: false, error: error.message };
  }
  if (id('georide-modal').classList.contains('open')) renderTrips();
}

/** The trips of the selected period, taken from the month already in hand. */
function visibleTrips() {
  if (!state.trips?.ok) return [];
  const since = Date.now() - state.tripPeriod * 86_400_000;
  return state.trips.trips.filter((trip) => new Date(trip.startTime).getTime() >= since);
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
  const trip = typeof state.selectedTrip === 'number' ? trips[state.selectedTrip] : null;
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
  if (!state.trips?.ok) {
    id('gr-totals').innerHTML = '';
    list.innerHTML = `<p class="gr-empty">${esc(state.trips?.error || t('gr.unavailable'))}</p>`;
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
    `<button class="gr-trip${state.selectedTrip === 'all' ? ' active' : ''}" data-trip="all">
       <span class="gr-trip-when">${esc(t('gr.allTrips'))}</span>
       <span class="gr-trip-where">${esc(t('gr.tripsOver', { n: trips.length, days: state.tripPeriod }))}</span>
     </button>`,
  ];
  trips.forEach((trip, index) => {
    const figures = tripFigures(trip);
    const when = trip.startTime
      ? new Date(trip.startTime).toLocaleString(state.config.site.locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '—';
    rows.push(`<button class="gr-trip${state.selectedTrip === index ? ' active' : ''}" data-trip="${index}">
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
  if (state.selectedTrip === selection) return;
  state.selectedTrip = selection;
  const trips = visibleTrips();
  id('gr-trip-list').querySelectorAll('[data-trip]').forEach((button) => {
    const value = button.dataset.trip === 'all' ? 'all' : Number(button.dataset.trip);
    button.classList.toggle('active', value === selection);
  });
  renderTripTotals(trips);
  styleTracks(trips);
}

function ensureTripMap() {
  if (state.tripMap) return state.tripMap;
  const holder = id('gr-track');
  holder.innerHTML = '';
  const canvas = document.createElement('div');
  canvas.className = 'gr-track-canvas';
  holder.appendChild(canvas);

  const map = L.map(canvas, { zoomControl: true, scrollWheelZoom: true, attributionControl: true }).setView([46.6, 2.5], 5);
  L.tileLayer(MAP_TILE_URL, { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  state.tripMap = map;
  state.tripLayers = new Map();
  state.tripGroup = L.layerGroup().addTo(map);
  state.tripMarkers = L.layerGroup().addTo(map);
  refreshMapTheme(canvas);
  setTimeout(() => map.invalidateSize(), 80);
  return map;
}

/** Each track is drawn once and kept; only the ones that left the period go. */
function syncTracks(trips) {
  ensureTripMap();
  const accent = getComputedStyle(html).getPropertyValue('--primary').trim() || '#0a84ff';
  const wanted = new Set(trips.map(tripKey));
  for (const [key, layer] of state.tripLayers) {
    if (!wanted.has(key)) {
      state.tripGroup.removeLayer(layer);
      state.tripLayers.delete(key);
    }
  }
  trips.forEach((trip) => {
    const key = tripKey(trip);
    if (trip.track.length < 2 || state.tripLayers.has(key)) return;
    const line = L.polyline(trip.track, { color: accent, weight: 3, opacity: 0.9, smoothFactor: 1.6 });
    state.tripGroup.addLayer(line);
    state.tripLayers.set(key, line);
  });
}

function styleTracks(trips) {
  if (!state.tripMap) return;
  const selected = typeof state.selectedTrip === 'number' ? trips[state.selectedTrip] : null;
  trips.forEach((trip) => {
    const line = state.tripLayers.get(tripKey(trip));
    if (!line) return;
    const lit = !selected || trip === selected;
    line.setStyle({ weight: lit ? 4 : 2, opacity: lit ? 0.95 : 0.22 });
    if (lit && selected) line.bringToFront();
  });

  state.tripMarkers.clearLayers();
  if (selected && selected.track.length >= 2) {
    const pin = (name) => L.divIcon({ className: 'gr-pin', html: svg(name), iconSize: [26, 26], iconAnchor: [13, 13] });
    L.marker(selected.track[0], { icon: pin('navigation-arrow') }).addTo(state.tripMarkers);
    L.marker(selected.track[selected.track.length - 1], { icon: pin('map-pin') }).addTo(state.tripMarkers);
  }

  const frame = selected ? selected.track : trips.flatMap((trip) => trip.track);
  if (frame.length) state.tripMap.flyToBounds(frame, { padding: [26, 26], duration: 0.45 });
}

async function loadGeoride() {
  const tile = state.config.tiles.find((item) => item.type === 'georide');
  if (!tile) return;
  try {
    const summary = await api('/api/integrations/georide/summary');
    state.georide = summary;
    renderGeorideTile(tile, summary);
    // Pull the month in the background so the detail view opens on ready data.
    if (summary.ok && !state.trips) {
      const prefetch = () => loadTrips({ quiet: true });
      if (typeof requestIdleCallback === 'function') requestIdleCallback(prefetch, { timeout: 4000 });
      else setTimeout(prefetch, 1200);
    }
  } catch (error) {
    renderGeorideTile(tile, { ok: false, error: error.message });
  }
}

/* --------------------------------- parcels -------------------------------- */
/* The six states the server folds every carrier status into, each with the one
   colour it is worth on a dashboard. `manual` is a parcel followed by hand,
   typically an Amazon Logistics shipment no third party can query. */

const PARCEL_STATES = {
  pending: '#8e8e93',
  transit: '#0a84ff',
  delivery: '#5e5ce6',
  pickup: '#ff9f0a',
  delivered: '#34c759',
  problem: '#ff453a',
  manual: '#8e8e93',
};

const parcelColour = (parcel) => PARCEL_STATES[parcel?.state] ?? PARCEL_STATES.pending;
const parcelStateLabel = (parcel) => t(`pc.state.${parcel?.state ?? 'pending'}`);
const parcelName = (parcel) => parcel.label || parcel.trackingNumber || t('pc.untitled');

/** Newest first, but anything delivered sinks below what is still moving. */
const parcelOrder = (a, b) => {
  const done = (parcel) => (parcel.state === 'delivered' ? 1 : 0);
  if (done(a) !== done(b)) return done(a) - done(b);
  return (b.lastEvent?.at ?? 0) - (a.lastEvent?.at ?? 0);
};

const parcelWhen = (at) => (at
  ? new Date(at).toLocaleString(state.config.site.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');

function renderParcelsTile(tile, payload) {
  const article = tileElement(tile.id);
  if (!article) return;
  const el = (role) => article.querySelector(`[data-role="${role}"]`);
  const usable = Boolean(payload?.ok);
  article.classList.toggle('pc-clickable', usable);

  if (!usable) {
    safe(el('head'), '');
    el('list').innerHTML = `<p class="gr-message">${esc(payload?.configured === false ? t('pc.notConfigured') : payload?.error || t('pc.unavailable'))}</p>`;
    el('dot').style.background = '#ff9f0a';
    el('dot').style.boxShadow = '0 0 0 5px rgba(255,159,10,.16)';
    safe(el('foot'), payload?.configured === false ? `${t('set.title')} → ${t('set.parcels')}` : t('pc.unavailable'));
    return;
  }

  const { counts } = payload;
  safe(el('head'), counts.active > 0 ? t('pc.onTheWay', { n: counts.active }) : t('pc.nothingMoving'));

  const shown = [...payload.parcels].sort(parcelOrder).slice(0, state.config.integrations.parcels.maxOnTile ?? 4);
  el('list').innerHTML = shown.length === 0
    ? `<p class="gr-message">${esc(t('pc.empty'))}</p>`
    : shown.map((parcel) => `<div class="pc-row">
        <span class="pc-dot" style="background:${parcelColour(parcel)}"></span>
        <span class="pc-name">${esc(parcelName(parcel))}</span>
        <span class="pc-state">${esc(parcelStateLabel(parcel))}</span>
      </div>`).join('');

  const worst = counts.problem > 0 ? '#ff453a' : counts.active > 0 ? '#0a84ff' : '#34c759';
  el('dot').style.background = worst;
  el('dot').style.boxShadow = `0 0 0 5px ${worst}29`;
  const parts = [];
  const waiting = state.suggestions?.length ?? 0;
  if (waiting > 0) parts.push(t('pc.foundInMail', { n: waiting }));
  if (counts.delivered > 0) parts.push(t('pc.deliveredCount', { n: counts.delivered }));
  if (counts.problem > 0) parts.push(t('pc.problemCount', { n: counts.problem }));
  if (payload.error) parts.push(t('pc.stale'));
  safe(el('foot'), parts.length ? parts.join(' · ') : t('pc.upToDate'));
}

async function loadParcels() {
  const tile = state.config.tiles.find((item) => item.type === 'parcels');
  if (!tile) return;
  try {
    state.parcels = await api('/api/integrations/parcels');
  } catch (error) {
    state.parcels = { ok: false, error: error.message };
  }
  renderParcelsTile(tile, state.parcels);
  loadSuggestions();
  if (id('parcels-modal')?.classList.contains('open')) renderParcels();
}

/* ---------------------- parcels found in the mailbox ---------------------- */
/* The scan proposes and the user decides, because accepting one of these is
   what spends a tracking credit. */

async function loadSuggestions() {
  if (!state.config.integrations.parcels?.mail?.enabled) {
    state.suggestions = [];
    renderSuggestions();
    return;
  }
  try {
    state.suggestions = (await api('/api/integrations/parcels/suggestions')).suggestions;
  } catch {
    state.suggestions = [];   // an instance without the scan: nothing to show
  }
  renderSuggestions();
}

function renderSuggestions() {
  const holder = id('pc-suggestions');
  if (!holder) return;
  const suggestions = state.suggestions ?? [];
  holder.hidden = suggestions.length === 0;
  if (suggestions.length === 0) {
    holder.innerHTML = '';
    return;
  }

  holder.innerHTML = `<div class="pc-suggest-head">${svg('envelope', 'font-size:16px')}<span>${esc(t('pc.foundInMail', { n: suggestions.length }))}</span></div>`
    + suggestions.map((suggestion) => `<div class="pc-suggest-row" data-suggestion="${esc(suggestion.id)}">
        <span class="pc-suggest-what">
          <span class="pc-suggest-label">${esc(suggestion.label || suggestion.trackingNumber)}</span>
          <span class="pc-suggest-meta">${esc(suggestion.trackingNumber)}${suggestion.carrier ? ` · ${esc(suggestion.carrier)}` : ''}${suggestion.trackable ? '' : ` · ${esc(t('pc.byHandOnly'))}`}</span>
        </span>
        <span class="row">
          <button class="btn primary" type="button" data-accept>${esc(t('pc.follow'))}</button>
          <button class="btn ghost" type="button" data-ignore>${esc(t('pc.ignore'))}</button>
        </span>
      </div>`).join('');

  holder.querySelectorAll('[data-suggestion]').forEach((row) => {
    const answer = async (action) => {
      row.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      try {
        await api(`/api/integrations/parcels/suggestions/${encodeURIComponent(row.dataset.suggestion)}/${action}`, { method: 'POST' });
        await loadParcels();
        if (action === 'accept') toast(t('pc.added'));
      } catch (error) {
        toast(error.message, 'error');
        row.querySelectorAll('button').forEach((button) => { button.disabled = false; });
      }
    };
    row.querySelector('[data-accept]').addEventListener('click', () => answer('accept'));
    row.querySelector('[data-ignore]').addEventListener('click', () => answer('ignore'));
  });
}

/** Take over the numbers already registered on the 17TRACK account — the ones
 *  added by hand on their site. Costs no quota: those numbers are declared
 *  already, so this only reads. */
async function importParcels(button) {
  button.disabled = true;
  try {
    const result = await api('/api/integrations/parcels/import', { method: 'POST' });
    state.parcels = result;
    renderParcelsTile(state.config.tiles.find((item) => item.type === 'parcels'), result);
    renderParcels();
    toast(result.imported > 0 ? t('pc.imported', { n: result.imported }) : t('pc.importNothing'));
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function scanMailbox(button) {
  button.disabled = true;
  try {
    const result = await api('/api/integrations/parcels/mail/scan', { method: 'POST' });
    state.suggestions = result.suggestions;
    renderSuggestions();
    await loadParcels();
    toast(result.proposed > 0 ? t('pc.scanFound', { n: result.proposed }) : t('pc.scanNothing'));
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

/* ----------------------- parcel detail view (history) --------------------- */

const closeParcelsModal = () => id('parcels-modal')?.classList.remove('open');

function openParcelsModal() {
  if (!state.parcels?.ok || !id('parcels-modal')) return;
  const scan = id('pc-scan');
  if (scan) scan.hidden = !state.config.integrations.parcels?.mail?.enabled;
  const importButton = id('pc-import');
  if (importButton) importButton.hidden = !state.parcels?.hasKey;
  id('parcels-modal').classList.add('open');
  renderParcels();
}

/** The list on the left; the selection drives the panel on the right. */
function renderParcels() {
  const list = id('pc-list');
  const payload = state.parcels;
  if (!payload?.ok) {
    list.innerHTML = `<p class="gr-empty">${esc(payload?.error || t('pc.unavailable'))}</p>`;
    id('pc-detail').innerHTML = '';
    return;
  }

  renderSuggestions();
  const parcels = [...payload.parcels].sort(parcelOrder);
  if (parcels.length === 0) {
    list.innerHTML = `<p class="gr-empty">${esc(t('pc.empty'))}</p>`;
  } else {
    if (!parcels.some((parcel) => parcel.id === state.selectedParcel)) state.selectedParcel = parcels[0].id;
    list.innerHTML = parcels.map((parcel) => `<button class="gr-trip pc-item${parcel.id === state.selectedParcel ? ' active' : ''}" data-parcel="${esc(parcel.id)}">
        <span class="gr-trip-when"><span class="pc-dot" style="background:${parcelColour(parcel)}"></span>${esc(parcelName(parcel))}</span>
        <span class="gr-trip-where">${esc(parcelStateLabel(parcel))}${parcel.carrier?.name ? ` · ${esc(parcel.carrier.name)}` : ''}</span>
        <span class="gr-trip-figures">${esc(parcel.lastEvent?.at ? parcelWhen(parcel.lastEvent.at) : t('pc.noEvent'))}</span>
      </button>`).join('');
    list.querySelectorAll('[data-parcel]').forEach((button) => {
      button.addEventListener('click', () => {
        state.selectedParcel = button.dataset.parcel;
        renderParcels();
      });
    });
  }

  safe(id('pc-count'), payload.hidden > 0
    ? `${t('pc.following', { n: parcels.length })} · ${t('pc.hidden', { n: payload.hidden })}`
    : t('pc.following', { n: parcels.length }));
  renderParcelDetail(parcels.find((parcel) => parcel.id === state.selectedParcel) ?? null);
}

/** The chosen parcel: what it is, and every step the carrier reported. */
function renderParcelDetail(parcel) {
  const panel = id('pc-detail');
  if (!parcel) {
    panel.innerHTML = `<p class="gr-empty">${esc(t('pc.pick'))}</p>`;
    return;
  }

  const facts = [];
  if (parcel.trackingNumber) facts.push([t('pc.number'), parcel.trackingNumber]);
  if (parcel.carrier?.name) facts.push([t('pc.carrier'), parcel.carrier.name]);
  if (parcel.destination) facts.push([t('pc.destination'), parcel.destination]);
  if (parcel.daysInTransit !== null && parcel.daysInTransit !== undefined) {
    facts.push([t('pc.transit'), t(parcel.daysInTransit === 1 ? 'pc.day' : 'pc.days', { n: parcel.daysInTransit })]);
  }

  // A manually followed parcel has no history to show: it has a link instead.
  const events = parcel.events ?? [];
  const history = events.length > 0
    ? `<ol class="pc-steps">${events.map((event, index) => `<li class="pc-step${index === 0 ? ' now' : ''}">
          <span class="pc-step-dot"></span>
          <span class="pc-step-when">${esc(parcelWhen(event.at))}</span>
          <span class="pc-step-what">${esc(event.description || '—')}</span>
          ${event.location ? `<span class="pc-step-where">${esc(event.location)}</span>` : ''}
        </li>`).join('')}</ol>`
    : `<p class="gr-empty">${esc(parcel.provider === 'manual' ? t('pc.manualHint') : t('pc.noEvent'))}</p>`;

  panel.innerHTML = `
    <div class="pc-head">
      <div>
        <div class="pc-badge" style="background:${parcelColour(parcel)}1f;color:${parcelColour(parcel)}">${esc(parcelStateLabel(parcel))}</div>
        <h4>${esc(parcelName(parcel))}</h4>
      </div>
      <div class="row">
        ${parcel.url ? `<a class="btn ghost" href="${esc(parcel.url)}" target="_blank" rel="noopener noreferrer">${esc(t('pc.open'))}</a>` : ''}
        <button class="btn ghost danger" type="button" data-remove="${esc(parcel.id)}">${esc(t('pc.remove'))}</button>
      </div>
    </div>
    ${facts.length ? `<dl class="pc-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
    ${history}`;

  panel.querySelector('[data-remove]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!confirm(t('pc.confirmRemove', { name: parcelName(parcel) }))) return;
    button.disabled = true;
    try {
      await api(`/api/integrations/parcels/${encodeURIComponent(parcel.id)}`, { method: 'DELETE' });
      state.selectedParcel = null;
      await loadParcels();
      toast(t('pc.removed'));
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  });
}

/** Follow a new parcel. Without a number it is followed by hand, with a link. */
async function submitParcel(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const parcel = await api('/api/integrations/parcels', {
      method: 'POST',
      body: {
        label: id('pc-label').value,
        trackingNumber: id('pc-number').value,
        url: id('pc-url').value,
      },
    });
    form.reset();
    state.selectedParcel = parcel.parcel.id;
    await loadParcels();
    toast(t('pc.added'));
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function refreshParcels(button) {
  button.disabled = true;
  try {
    state.parcels = await api('/api/integrations/parcels/refresh', { method: 'POST' });
    const tile = state.config.tiles.find((item) => item.type === 'parcels');
    if (tile) renderParcelsTile(tile, state.parcels);
    renderParcels();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------ clock & date ----------------------------- */

function updateTime() {
  const config = state.config;
  const now = new Date();
  const locale = config.site.locale || 'en';
  const time = now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = now.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });

  safe(id('digital-clock'), time);
  safe(id('digital-clock-top'), time);
  safe(id('header-date'), date);
  safe(id('header-date-top'), date);

  const altLabel = config.site.clockLabel;
  const altRow = id('alt-clock-row');
  altRow.hidden = !altLabel;
  if (altLabel) {
    safe(id('alt-clock-label'), altLabel);
    const alt = now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', timeZone: config.site.clockTimezone });
    safe(id('alt-clock'), alt);
    document.querySelectorAll('[data-role="clock"]').forEach((el) => { el.textContent = alt; });
  }

  const greetingName = config.site.greeting;
  const greeting = now.getHours() >= 18 ? t('greeting.evening') : t('greeting.morning');
  safe(id('greeting'), greetingName ? `${greeting} ${greetingName}` : greeting);

  const year = now.getFullYear();
  const yearStart = new Date(year, 0, 0);
  const diff = now - yearStart + (yearStart.getTimezoneOffset() - now.getTimezoneOffset()) * 60000;
  const total = year % 4 === 0 ? 366 : 365;
  const day = Math.floor(diff / 86400000);
  const percent = ((day / total) * 100).toFixed(1);
  safe(id('day-count'), day);
  safe(id('total-days'), total);
  safe(id('year-percent'), `${percent}%`);
  const bar = id('year-progress-bar');
  if (bar) bar.style.width = `${percent}%`;
}

/* ------------------------------ appearance ------------------------------- */

/** Apply a colour preset, the orbs and the wallpaper. Pass a draft to preview it. */
function applyAppearance(appearance = state.config?.appearance, version = state.wallpaperVersion) {
  const settings = appearance || {};
  html.setAttribute('data-preset', settings.preset || 'default');
  html.setAttribute('data-orbs', settings.orbs === false ? 'off' : 'on');
  // The sign-in screens run before any configuration can be read, so the chosen
  // style is left here for them to find, next to the theme they already read.
  try {
    localStorage.setItem('preset', settings.preset || 'default');
    localStorage.setItem('orbs', settings.orbs === false ? 'off' : 'on');
  } catch { /* private mode */ }

  const wallpaper = settings.wallpaper || {};
  if (wallpaper.enabled) {
    html.setAttribute('data-wallpaper', 'on');
    html.style.setProperty('--wall-image', `url("/api/appearance/wallpaper?v=${encodeURIComponent(version || '')}")`);
    html.style.setProperty('--wall-dim', String(wallpaper.dim ?? 0.4));
    html.style.setProperty('--wall-blur', `${wallpaper.blur ?? 0}px`);
  } else {
    html.removeAttribute('data-wallpaper');
  }
}

/**
 * Change the colour preset with a cross-fade of the whole page.
 * The View Transitions API snapshots the old rendering and fades it into the
 * new one, which no CSS transition can do for gradients. Where it is missing,
 * the change simply applies at once.
 */
function setPreset(preset) {
  // The state changes now, synchronously: a view transition defers its
  // callback, and anything saving right after would send the previous value.
  state.config.appearance.preset = preset;
  withTransition(() => {
    applyAppearance();
    syncStatusBarColour();
  });
}

/** Run a repaint inside a cross-fade where the browser supports one. */
function withTransition(repaint) {
  if (typeof document.startViewTransition === 'function' && !prefersReducedMotion()) {
    document.startViewTransition(repaint);
  } else {
    repaint();
  }
}

/** Pick a preset at random, never the one already showing. */
async function shuffleTheme() {
  const available = Object.keys(state.themePresets).filter((key) => key !== state.config.appearance?.preset);
  if (available.length === 0) return;
  const preset = available[Math.floor(Math.random() * available.length)];
  setPreset(preset);
  toast(t('msg.themeChanged', { name: state.themePresets[preset]?.label || preset }));
  try {
    const payload = await api('/api/config', { method: 'PUT', body: { config: state.config, note: 'theme shuffled' } });
    state.saved = clone(payload.config);
  } catch (error) {
    toast(error.message, 'error');
  }
}

const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The image is cached hard, so its timestamp is what busts that cache. */
async function loadWallpaperVersion() {
  try {
    const info = await api('/api/appearance/wallpaper/info');
    state.wallpaperVersion = info.wallpaper?.updatedAt || '';
  } catch {
    state.wallpaperVersion = '';
  }
}

/* ------------------------------- rendering ------------------------------- */

function renderChrome() {
  const config = state.config;
  applyAppearance();
  setLocale(config.site.locale);
  applyTranslations();
  document.title = config.site.title;
  safe(id('brand-title'), config.site.title);
  safe(id('brand-subtitle'), config.site.subtitle);
  safe(id('apps-title'), config.site.sectionTitle || t('apps.title'));

  const searchCard = id('search-card');
  searchCard.hidden = !config.search.enabled;
  const form = id('search-form');
  form.setAttribute('action', config.search.action || 'https://duckduckgo.com/');
  // Undefined means "not set yet" on a configuration saved before this option
  // existed, and a dashboard is meant to stay open: default to a new tab.
  form.target = config.search.newTab === false ? '_self' : '_blank';
  form.rel = 'noopener';
  const input = id('search-input');
  input.name = config.search.param || 'q';
  input.placeholder = config.search.placeholder || t('search.placeholder');
}

function renderAll() {
  renderChrome();
  renderNav();
  renderTiles();
  renderLinks();
  updateTime();
}

function refreshData() {
  lastRefresh = Date.now();
  loadWeather();
  loadGeoride();
  loadParcels();
}

/* --------------------------------- updates -------------------------------- */

/** A quiet daily check: a dot on the account button when a version is waiting. */
async function checkForUpdateBadge() {
  try {
    const payload = await api('/api/update');
    const behind = Boolean(payload.latest?.commit && payload.installed?.commit && payload.latest.commit !== payload.installed.commit);
    id('account-toggle').classList.toggle('has-badge', behind);
    document.querySelector('#dock [aria-label]')?.classList.remove('has-badge');
    document.querySelectorAll('#dock .dock-item').forEach((item) => {
      if (item.getAttribute('aria-label') === t('set.account')) item.classList.toggle('has-badge', behind);
    });
    id('account-menu').querySelector('[data-action="settings"]')?.classList.toggle('has-badge', behind);
  } catch { /* an instance without the update route: nothing to show */ }
}

/* ------------------------------- install app ------------------------------ */

/** The menu offers installing only where the browser can, and not from inside the app. */
function syncInstallItem() {
  id('account-menu').querySelector('[data-action="install"]').hidden = !pwa.available;
}

async function installApp() {
  if (pwa.prompt) {
    const prompt = pwa.prompt;
    pwa.prompt = null; // a prompt can be shown only once
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    syncInstallItem();
    if (outcome === 'accepted') toast(t('pwa.installed'));
    return;
  }
  if (pwa.ios) {
    openDialog({ title: t('menu.install'), body: el('div', { class: 'dlg' }, [el('p', { class: 'fld-h', text: t('pwa.ios') })]) });
  }
}

/* --------------------------------- dialogs -------------------------------- */

function openDialog({ title, subtitle = '', body }) {
  safe(id('dialog-title'), title);
  safe(id('dialog-subtitle'), subtitle);
  const container = id('dialog-body');
  container.innerHTML = '';
  container.appendChild(body);
  hydrateIcons(container);
  id('dialog-modal').classList.add('open');
}
const closeDialog = () => id('dialog-modal').classList.remove('open');


/* ------------------------------- what's new ------------------------------- */
/* After an update, the page comes back on a new build and this says what
   changed. Once per account per build: the acknowledgement is stored server
   side, so it is not something a cleared browser brings back. */

const NEWS_KINDS = { added: 'news.added', changed: 'news.changed', fixed: 'news.fixed', removed: 'news.removed' };

/** One changelog section, as a block of the dialog. */
function newsSection(section) {
  const groups = section.groups.map((group) =>
    el('div', { class: 'news-group' }, [
      el('div', { class: 'news-kind', text: NEWS_KINDS[group.kind] ? t(NEWS_KINDS[group.kind]) : group.kind }),
      el('ul', { class: 'news-items' }, group.items.map((item) =>
        el('li', {}, [
          // Entries without a headline — the Changed and Fixed lists mostly —
          // are a single paragraph, and look right that way.
          item.lead ? el('strong', { class: 'news-lead', text: item.lead }) : null,
          item.text ? el('span', { text: item.text }) : null,
        ]))),
    ])
  );
  return el('section', { class: 'news-section' }, [
    el('div', { class: 'news-head' }, [
      el('h4', { text: section.released ? section.version : t('news.unreleased') }),
      section.date ? el('span', { class: 'news-date', text: section.date }) : null,
    ]),
    section.summary ? el('p', { class: 'news-summary', text: section.summary }) : null,
    ...groups,
  ]);
}

function newsBody(sections, { acknowledge = true } = {}) {
  const body = el('div', { class: 'dlg news' });
  // The notes are English while the interface is not, so the dialog says so
  // rather than leaving the reader to wonder whether something is broken.
  body.appendChild(el('p', { class: 'fld-h', text: t('news.inEnglish') }));
  sections.forEach((section) => body.appendChild(newsSection(section)));
  body.appendChild(el('div', { class: 'dlg-foot' }, [
    el('button', {
      class: 'btn primary', type: 'button', text: t('news.gotIt'),
      onclick: async () => {
        if (acknowledge) await api('/api/update/news/seen', { method: 'POST', body: {} }).catch(() => {});
        closeDialog();
      },
    }),
  ]));
  return body;
}

/** Ask once at start-up, and open the dialog only when there is something
 *  unread. A failure here is silent: a dashboard that cannot reach its own
 *  changelog is still a working dashboard. */
async function checkForNews() {
  try {
    const news = await api('/api/update/news');
    state.news = news;
    if (!news.unread || news.sections.length === 0) return;
    openDialog({
      title: t('news.title'),
      subtitle: news.installed?.version ? t('news.subtitle', { version: news.installed.version }) : '',
      body: newsBody(news.sections),
    });
  } catch {
    /* no changelog, or no network to our own server: nothing to show */
  }
}

/** The same thing, asked for deliberately from the settings. Shows the recent
 *  history rather than only the unread part, and acknowledges nothing: reading
 *  it on purpose is not the same as being told. */
async function openNewsHistory() {
  try {
    const news = state.news ?? await api('/api/update/news');
    const sections = news.all?.length ? news.all : news.sections;
    if (!sections?.length) return toast(t('news.none'));
    openDialog({ title: t('news.title'), subtitle: '', body: newsBody(sections, { acknowledge: false }) });
  } catch (error) {
    toast(error.message, 'error');
  }
  return undefined;
}

/* ------------------------------ account menu ------------------------------ */

function toggleAccountMenu(force) {
  const menu = id('account-menu');
  const open = force ?? menu.hidden;
  menu.hidden = !open;
  id('account-toggle').setAttribute('aria-expanded', String(open));
}

async function doLogout() {
  await api('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
}

function downloadExport(includeSecrets) {
  const url = `/api/config/export${includeSecrets ? '?secrets=1' : ''}`;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/* ---------------------------------- boot ---------------------------------- */

async function boot() {
  hydrateIcons();
  const stored = (() => { try { return localStorage.getItem('theme'); } catch { return null; } })();
  setTheme(stored ? stored === 'dark' : matchMedia('(prefers-color-scheme:dark)').matches);
  id('theme-toggle-top').addEventListener('click', toggleTheme);

  id('account-toggle').addEventListener('click', (event) => { event.stopPropagation(); toggleAccountMenu(); });
  document.addEventListener('click', (event) => {
    if (!id('account-menu').hidden && !event.target.closest('#account-menu')) toggleAccountMenu(false);
  });
  id('account-menu').addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    toggleAccountMenu(false);
    if (action === 'logout') doLogout();
    if (action === 'edit') setEditing(true);
    if (action === 'shuffle') shuffleTheme();
    if (action === 'settings') openSettings();
    if (action === 'export') openExportDialog();
    if (action === 'install') installApp();
    if (action === 'import') openImportDialog();
  });

  id('folder-modal-close').addEventListener('click', closeFolder);
  id('folder-modal').addEventListener('click', (event) => { if (event.target === id('folder-modal')) closeFolder(); });
  id('weather-modal').addEventListener('click', (event) => {
    if (event.target === id('weather-modal')) id('weather-modal').classList.remove('open');
  });
  id('georide-modal').addEventListener('click', (event) => {
    if (event.target === id('georide-modal')) closeGeorideModal();
  });
  id('parcels-modal')?.addEventListener('click', (event) => {
    if (event.target === id('parcels-modal')) closeParcelsModal();
  });
  // Optional: a browser holding an older page in its cache has no parcel view,
  // and a missing element here would stop the whole dashboard from starting.
  id('pc-form')?.addEventListener('submit', submitParcel);
  id('pc-refresh')?.addEventListener('click', (event) => refreshParcels(event.currentTarget));
  id('pc-scan')?.addEventListener('click', (event) => scanMailbox(event.currentTarget));
  id('pc-import')?.addEventListener('click', (event) => importParcels(event.currentTarget));
  id('dialog-close').addEventListener('click', closeDialog);
  id('dialog-modal').addEventListener('click', (event) => { if (event.target === id('dialog-modal')) closeDialog(); });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('.modal.open').forEach((modal) => modal.classList.remove('open'));
    destroyTripMap();
    toggleAccountMenu(false);
  });

  installParallax();
  bindDayCurve();
  pwa.onChange = syncInstallItem;
  syncInstallItem();
  checkForUpdateBadge();

  document.addEventListener('visibilitychange', onVisibilityChange);

  let resizeTimer;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      document.querySelectorAll('.spark canvas').forEach((canvas) => {
        if (canvas._spark) drawSpark(canvas.id, canvas._spark.data, canvas._spark.color);
      });
      // The curve's viewBox is cut to its column, so a resize has to redraw
      // it. A theme or preset change still does not: its colours are CSS
      // variables.
      if (state.curve && id('weather-modal').classList.contains('open')) renderDayCurve();
      if (state.map) state.map.invalidateSize();
    }, 150);
  });

  // Who is signed in, which decides whether the administration tabs exist at
  // all. A failure here is not fatal: the dashboard is still usable, it simply
  // offers no administration — and the API would refuse it anyway.
  state.me = await api('/api/auth/me').catch(() => null);

  const payload = await api('/api/config');
  state.config = payload.config;
  state.saved = clone(payload.config);
  state.tileTypes = payload.tileTypes;
  state.themePresets = payload.themePresets || {};
  if (payload.config.appearance?.wallpaper?.enabled) await loadWallpaperVersion();

  renderAll();
  refreshData();
  startTimers();
  // Last, and deliberately not awaited: the dialog is the least urgent thing
  // on the page and must never hold the dashboard up.
  checkForNews();
}

/* --------------------------------- timers -------------------------------- */
/* Nothing ticks while the tab is hidden: on a phone that is battery, and on a
   dashboard left open all day it is a poll every few minutes for nobody. */

let clockTimer = null;
let dataTimer = null;
let lastRefresh = 0;

function startTimers() {
  stopTimers();
  clockTimer = setInterval(updateTime, 1000);
  const minutes = Math.max(5, state.config?.integrations?.weather?.refreshMinutes ?? 30);
  dataTimer = setInterval(refreshData, minutes * 60000);
}

function stopTimers() {
  clearInterval(clockTimer);
  clearInterval(dataTimer);
  clockTimer = null;
  dataTimer = null;
}

function onVisibilityChange() {
  if (document.hidden) {
    stopTimers();
    return;
  }
  updateTime();
  // Coming back after a minute is worth a refresh; flicking between tabs is not.
  if (Date.now() - lastRefresh > 60000) refreshData();
  startTimers();
}

/**
 * Background parallax, on a pointer that can actually hover and at one update
 * per frame. Touch screens and reduced-motion users get a still backdrop.
 */
function installParallax() {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches || prefersReducedMotion()) return;
  const wall = id('wall');
  let queued = false;
  let x = 0;
  let y = 0;
  addEventListener(
    'mousemove',
    (event) => {
      x = (innerWidth - event.pageX * 2) / 110;
      y = (innerHeight - event.pageY * 2) / 110;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        wall.style.transform = `translate(${x}px,${y}px) scale(1.08)`;
      });
    },
    { passive: true }
  );
}

boot().catch((error) => {
  console.error(error);
  if (error.message !== 'unauthenticated') toast(error.message, 'error');
});
