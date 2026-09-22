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
  themePresets: {},
  wallpaperVersion: '',
  map: null,
  marker: null,
  modalTile: null,
  selectedDay: 0,
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const weatherEmoji = (code) => (code <= 1 ? '☀️' : code <= 3 ? '⛅' : code <= 67 ? '🌧️' : '⛈️');

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
        <div class="wmain"><div data-role="temp" class="temp">--°</div><div class="wstats"><span>${esc(t('tile.wind'))} <strong data-role="wind">--</strong> km/h</span><span>${esc(t('tile.rain'))} <strong data-role="rain">--</strong>%</span></div></div>
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
      return noteTileMarkup(tile, index);
    })
    .join('');

  grid.querySelectorAll('[data-type^="weather"]').forEach((article) => {
    article.addEventListener('click', () => {
      if (state.editing) return;
      openWeatherModal(article.dataset.tile);
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

function drawChart(canvasId, labels, data, color, type) {
  const canvas = id(canvasId);
  if (!canvas || !data?.length) return;
  canvas._chart = { labels, data, color, type };
  const ctx = fitCanvas(canvas);
  if (!ctx) return;
  const w = canvas._w;
  const h = canvas._h;
  const axis = 16;
  const pX = 6;
  const pT = 6;
  const plotH = h - axis - pT;
  const plotW = w - pX * 2;
  let min = Math.min(...data);
  let max = Math.max(...data);
  if (type === 'bar') { min = 0; max = Math.max(max, 100); }
  if (min === max) { min -= 1; max += 1; }
  const X = (i) => pX + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const Y = (v) => pT + (1 - (v - min) / (max - min)) * plotH;

  if (type === 'bar') {
    const bw = Math.max(3, (plotW / data.length) * 0.55);
    ctx.fillStyle = color;
    data.forEach((v, i) => {
      const x = pX + ((i + 0.5) / data.length) * plotW - bw / 2;
      const y = Y(v);
      const bh = pT + plotH - y;
      const r = Math.min(4, bw / 2, bh);
      ctx.beginPath();
      ctx.moveTo(x, y + bh);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.lineTo(x + bw - r, y);
      ctx.quadraticCurveTo(x + bw, y, x + bw, y + r);
      ctx.lineTo(x + bw, y + bh);
      ctx.closePath();
      ctx.fill();
    });
  } else {
    const points = data.map((v, i) => ({ x: X(i), y: Y(v) }));
    ctx.beginPath();
    smooth(ctx, points);
    ctx.lineTo(points[points.length - 1].x, pT + plotH);
    ctx.lineTo(points[0].x, pT + plotH);
    ctx.closePath();
    ctx.fillStyle = `${color}2e`;
    ctx.fill();
    ctx.beginPath();
    smooth(ctx, points);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = color;
    points.forEach((p) => { ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, 6.2832); ctx.fill(); });
  }

  ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--muted');
  ctx.font = '10px -apple-system,Inter,sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  labels.forEach((label, i) =>
    ctx.fillText(
      label,
      Math.min(w - 8, Math.max(8, type === 'bar' ? pX + ((i + 0.5) / data.length) * plotW : X(i))),
      h
    )
  );
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
  const today = new Date().toISOString().slice(0, 10);
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
  const hourly = data?.hourly;
  const i = state.selectedDay;
  if (!daily?.temperature_2m_max?.length) return;

  const [y, m, d] = daily.time[i].split('-');
  const date = new Date(y, m - 1, d);
  const today = new Date().toISOString().slice(0, 10);
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

  const start = i * 24;
  const end = start + 24;
  const pick = (arr) => (arr ? arr.slice(start, Math.min(end, arr.length)).filter((_, k) => k % 3 === 0) : []);
  const labels = pick(hourly.time).map((value) => value.slice(11, 16));
  drawChart('modalChartTemp', labels, pick(hourly.temperature_2m), '#5e5ce6', 'line');
  drawChart('modalChartRain', labels, pick(hourly.precipitation_probability), '#0a84ff', 'bar');
  drawChart('modalChartWind', labels, pick(hourly.wind_gusts_10m), '#64d2ff', 'line');
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

/* -------------------------------- GeoRide -------------------------------- */

const MAP_TILE_URL = '/api/integrations/map/tile/{z}/{x}/{y}.png';

function refreshMapTheme() {
  const container = state.map?.getContainer();
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

async function loadGeoride() {
  const tile = state.config.tiles.find((item) => item.type === 'georide');
  if (!tile) return;
  try {
    const summary = await api('/api/integrations/georide/summary');
    state.georide = summary;
    renderGeorideTile(tile, summary);
  } catch (error) {
    renderGeorideTile(tile, { ok: false, error: error.message });
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
  id('dialog-close').addEventListener('click', closeDialog);
  id('dialog-modal').addEventListener('click', (event) => { if (event.target === id('dialog-modal')) closeDialog(); });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    document.querySelectorAll('.modal.open').forEach((modal) => modal.classList.remove('open'));
    toggleAccountMenu(false);
  });

  installParallax();
  pwa.onChange = syncInstallItem;
  syncInstallItem();

  document.addEventListener('visibilitychange', onVisibilityChange);

  let resizeTimer;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      document.querySelectorAll('.spark canvas').forEach((canvas) => {
        if (canvas._spark) drawSpark(canvas.id, canvas._spark.data, canvas._spark.color);
      });
      ['modalChartTemp', 'modalChartRain', 'modalChartWind'].forEach((canvasId) => {
        const canvas = id(canvasId);
        if (canvas?._chart) drawChart(canvasId, canvas._chart.labels, canvas._chart.data, canvas._chart.color, canvas._chart.type);
      });
      if (state.map) state.map.invalidateSize();
    }, 150);
  });

  const payload = await api('/api/config');
  state.config = payload.config;
  state.saved = clone(payload.config);
  state.tileTypes = payload.tileTypes;
  state.themePresets = payload.themePresets || {};
  if (payload.config.appearance?.wallpaper?.enabled) await loadWallpaperVersion();

  renderAll();
  refreshData();
  startTimers();
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
