/* Weather — the two tiles, the detailed panel and the curve of the day.
 *
 * Open-Meteo is reached through this module's own route; the browser never
 * talks to it directly. Everything the module remembers lives in its own bag
 * of state, which no other module can see. */
import {
  id, safe, esc, svg, state, moduleState, api, openModal, closeModal,
  tileElement, localDayKey, clockOf,
} from '/assets/core/kernel.js';

const own = moduleState('weather');
Object.assign(own, {
  forecasts: own.forecasts ?? {},   // tileId -> Open-Meteo payload
  places: own.places ?? {},         // tileId -> resolved city name
  coords: own.coords ?? {},         // tileId -> { latitude, longitude }
  modalTile: own.modalTile ?? null,
  selectedDay: own.selectedDay ?? 0,
  curve: own.curve ?? null,         // the selected day, folded for the curve
  curveNodes: own.curveNodes ?? null,
  curveIndex: own.curveIndex ?? null,
  curveWidth: own.curveWidth ?? 0,
});

const weatherEmoji = (code, day = true) =>
  (code <= 1 ? (day ? '☀️' : '🌙') : code <= 3 ? (day ? '⛅' : '☁️') : code <= 67 ? '🌧️' : '⛈️');

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
  const data = own.forecasts[tile.id];
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
    const place = own.places[tile.id];
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
        const place = await api(`/api/m/weather/place?latitude=${latitude}&longitude=${longitude}`);
        own.places[tile.id] = place.name || t('tile.localPosition');
      } catch {
        own.places[tile.id] = t('tile.localPosition');
      }
    }
  }

  own.coords[tile.id] = { latitude, longitude };
  try {
    const payload = await api(`/api/m/weather/forecast?latitude=${latitude}&longitude=${longitude}`);
    own.forecasts[tile.id] = payload.forecast;
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
  const data = own.forecasts[own.modalTile];
  if (!data?.daily?.time) return;
  container.innerHTML = '';
  const today = localDayKey();
  data.daily.time.forEach((day, index) => {
    const [y, m, d] = day.split('-');
    const date = new Date(y, m - 1, d);
    const button = document.createElement('button');
    button.className = `day-btn${index === own.selectedDay ? ' active' : ''}`;
    const dayName = day === today
      ? t('wx.todayShort')
      : date.toLocaleDateString(state.config.site.locale, { weekday: 'short' });
    button.innerHTML = `<span class="dn">${esc(dayName)}</span><span class="dd">${date.getDate()}</span>`;
    button.addEventListener('click', () => { own.selectedDay = index; renderDays(); updateWeatherModal(); });
    container.appendChild(button);
  });
}

function updateWeatherModal() {
  const data = own.forecasts[own.modalTile];
  const daily = data?.daily;
  const i = own.selectedDay;
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

function openWeatherModal(tileId, origin = null) {
  if (!own.forecasts[tileId]) return;
  const tile = state.config.tiles.find((item) => item.id === tileId);
  own.modalTile = tileId;
  own.selectedDay = 0;
  safe(
    id('modal-city'),
    tile.type === 'weather-local'
      ? own.places[tileId] || t('tile.localPosition')
      : tile.settings.name || t('tile.followedCity')
  );
  openModal('weather-modal', origin ?? tileElement(tileId));
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
  const data = own.forecasts[own.modalTile];
  const hourly = data?.hourly;
  const daily = data?.daily;
  if (!hourly?.time || !daily?.time) return null;

  const start = own.selectedDay * 24;
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

  const isToday = daily.time[own.selectedDay] === localDayKey();
  return {
    hours,
    min,
    max,
    minIndex: temps.indexOf(Math.min(...temps)),
    maxIndex: temps.indexOf(Math.max(...temps)),
    sunrise: hourOf(daily.sunrise?.[own.selectedDay]),
    sunset: hourOf(daily.sunset?.[own.selectedDay]),
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
  own.curve = model;
  if (!model) { plot.innerHTML = `<p class="muted">${esc(t('wx.unavailable'))}</p>`; return; }
  // A hidden modal measures 0: fall back to the last good width rather than
  // drawing a curve one pixel wide.
  const measured = plot.getBoundingClientRect().width;
  wcFit(measured > 40 ? measured : (own.curveWidth || 720));
  own.curveWidth = WC.w;

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
    let seed = own.selectedDay * 7919 + 13;
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

  own.curveNodes = { svg: svgRoot, cursorLine, cursor, bubble, bubbleText, Y, points };
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
  const model = own.curve;
  const nodes = own.curveNodes;
  if (!wrap || !model || !nodes) return;

  if (index === null) {
    wrap.classList.remove('reading');
    own.curveIndex = null;
    wrap.removeAttribute('aria-valuenow');
    wrap.removeAttribute('aria-valuetext');
    nodes.svg.querySelectorAll('.wc-rain.aimed').forEach((bar) => bar.classList.remove('aimed'));
    return;
  }

  const k = Math.max(0, Math.min(model.hours.length - 1, Math.round(index)));
  own.curveIndex = k;
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
  const model = own.curve;
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
    const model = own.curve;
    if (!model) return;
    // Escape clears the reading, but only when there is one. Letting it
    // through otherwise is what keeps the second press closing the modal,
    // which is what every other panel in here does.
    if (event.key === 'Escape') {
      if (own.curveIndex === null) return;
      event.preventDefault();
      event.stopPropagation();
      readCurveAt(null);
      return;
    }
    const last = model.hours.length - 1;
    const current = own.curveIndex ?? (model.nowHour === null ? 12 : Math.round(model.nowHour));
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


/* ------------------------------ the contract ------------------------------ */

export default {
  id: 'weather',

  tiles: {
    'weather-local': {
      markup: (tile, index) => weatherTileMarkup(tile, index, { local: true }),
      open: (article) => openWeatherModal(article.dataset.tile, article),
    },
    'weather-secondary': {
      markup: (tile, index) => weatherTileMarkup(tile, index, { local: false }),
      open: (article) => openWeatherModal(article.dataset.tile, article),
    },
  },

  /* mounted() runs after every render, and these listeners sit on elements
     the render does not replace — the panel and the curve are in the page
     markup. Wiring them once is the difference between one handler and one
     per render. */
  mounted() {
    if (own.wired) return;
    own.wired = true;
    bindDayCurve();
    id('weather-modal').addEventListener('click', (event) => {
      if (event.target === id('weather-modal')) closeModal('weather-modal');
    });
  },

  refresh: loadWeather,

  /* One side-navigation entry per weather tile, which is what the original
     page did and what makes a followed city reachable without scrolling. */
  navEntries: () =>
    state.config.tiles
      .filter((tile) => tile.type === 'weather-local' || tile.type === 'weather-secondary')
      .map((tile) => {
        const local = tile.type === 'weather-local';
        const label = local ? t('nav.localWeather') : tile.settings.name || t('tile.followedCity');
        return {
          icon: local ? 'navigation-arrow' : 'buildings',
          label,
          short: local ? t('dock.weather') : label,
          run: () => openWeatherModal(tile.id),
        };
      }),

  onResize() {
    document.querySelectorAll('.spark canvas').forEach((canvas) => {
      if (canvas._spark) drawSpark(canvas.id, canvas._spark.data, canvas._spark.color);
    });
    // The curve's viewBox is cut to its column, so a resize has to redraw it.
    // A theme or preset change still does not: its colours are CSS variables.
    if (own.curve && id('weather-modal').classList.contains('open')) renderDayCurve();
  },

  closeViews: () => closeModal('weather-modal'),
};
