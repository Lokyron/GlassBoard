// Weather integration: Open-Meteo forecasts and Nominatim reverse geocoding,
// both proxied through the server so the browser never talks to a third party
// directly (and so their rate limits are respected via caching).
import { cacheGet, cacheGetStale, cacheSet } from '../db.js';
import { OSM_CONTACT } from '../env.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';

const FORECAST_PARAMS = new URLSearchParams({
  current: 'temperature_2m,weather_code,wind_speed_10m',
  hourly: 'temperature_2m,precipitation_probability,wind_gusts_10m',
  daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,wind_speed_10m_max',
  forecast_days: '7',
  timezone: 'auto',
});

export const userAgent = () =>
  `Glassboard/1.0 (self-hosted dashboard${OSM_CONTACT ? `; ${OSM_CONTACT}` : ''})`;

const round = (n) => Math.round(Number(n) * 100) / 100;

async function fetchJson(url, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`upstream responded ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Forecast for a coordinate. Falls back to the last known payload when upstream is down. */
export async function getForecast(latitude, longitude, ttlSeconds = 900) {
  const lat = round(latitude);
  const lon = round(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('invalid coordinates');
  const key = `weather:forecast:${lat},${lon}`;

  const fresh = cacheGet(key);
  if (fresh) return { ...fresh, cached: true };

  try {
    const data = await fetchJson(`${FORECAST_URL}?latitude=${lat}&longitude=${lon}&${FORECAST_PARAMS}`);
    cacheSet(key, data, ttlSeconds);
    return { ...data, cached: false };
  } catch (error) {
    const stale = cacheGetStale(key);
    if (stale) return { ...stale.value, cached: true, stale: true, error: error.message };
    throw error;
  }
}

/** City name for a coordinate. Cached for a long time: places rarely move. */
export async function reverseGeocode(latitude, longitude) {
  const lat = round(latitude);
  const lon = round(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('invalid coordinates');
  const key = `weather:place:${lat},${lon}`;

  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    const data = await fetchJson(
      `${NOMINATIM_URL}?format=json&zoom=10&lat=${lat}&lon=${lon}`,
      8000
    );
    const address = data?.address ?? {};
    const name =
      address.city || address.town || address.village || address.municipality || address.county || '';
    const place = { name };
    cacheSet(key, place, 30 * 24 * 3600);
    return place;
  } catch {
    const stale = cacheGetStale(key);
    return stale ? stale.value : { name: '' };
  }
}
