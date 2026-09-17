// Validation and normalisation of the dashboard configuration document.
// Hand-written on purpose: the shape is small, and this keeps the dependency
// list short while producing readable error messages for imports.

export const CONFIG_VERSION = 1;

/** Tile types the renderer knows about. Adding an integration means adding an entry here. */
export const TILE_TYPES = {
  'weather-local': { label: 'Weather — current position', integration: 'weather', singleton: true },
  'weather-secondary': { label: 'Weather — followed city', integration: 'weather', singleton: true },
  georide: { label: 'GeoRide — weekly stats and map', integration: 'georide', singleton: true },
  note: { label: 'Note', integration: null, singleton: false },
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;

class Validator {
  constructor() {
    this.errors = [];
  }

  fail(path, message) {
    this.errors.push(`${path}: ${message}`);
  }

  str(value, path, { max = 400, fallback = '', required = false } = {}) {
    if (value === undefined || value === null) {
      if (required) this.fail(path, 'is required');
      return fallback;
    }
    if (typeof value !== 'string') {
      this.fail(path, 'must be a string');
      return fallback;
    }
    if (value.length > max) {
      this.fail(path, `must be at most ${max} characters`);
      return value.slice(0, max);
    }
    return value;
  }

  bool(value, fallback = false) {
    return typeof value === 'boolean' ? value : fallback;
  }

  num(value, path, { min = -Infinity, max = Infinity, fallback = 0 } = {}) {
    const n = typeof value === 'number' ? value : Number.parseFloat(value);
    if (!Number.isFinite(n)) return fallback;
    if (n < min || n > max) {
      this.fail(path, `must be between ${min} and ${max}`);
      return Math.min(max, Math.max(min, n));
    }
    return n;
  }

  color(value, path, fallback = '#0a84ff') {
    if (typeof value === 'string' && HEX_COLOR.test(value)) return value.toLowerCase();
    if (value !== undefined && value !== null) this.fail(path, 'must be a #rrggbb colour');
    return fallback;
  }

  /** Only http(s) links are accepted, so a config file can never smuggle in javascript: URLs. */
  url(value, path, { required = true } = {}) {
    const raw = this.str(value, path, { max: 2000, required });
    if (!raw) return '';
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      this.fail(path, 'must be a valid absolute URL');
      return '';
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      this.fail(path, 'must use http:// or https://');
      return '';
    }
    return raw;
  }

  id(value, path, prefix) {
    if (typeof value === 'string' && ID.test(value)) return value;
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function normaliseLink(v, raw, path, { allowItems }) {
  const link = {
    id: v.id(raw?.id, `${path}.id`, allowItems ? 'lnk' : 'sub'),
    title: v.str(raw?.title, `${path}.title`, { max: 80, required: true, fallback: 'Untitled' }),
    color: v.color(raw?.color, `${path}.color`),
    icon: v.str(raw?.icon, `${path}.icon`, { max: 60, fallback: 'link' }),
  };
  if (allowItems && Array.isArray(raw?.items)) {
    link.items = raw.items
      .slice(0, 100)
      .map((item, i) => normaliseLink(v, item, `${path}.items[${i}]`, { allowItems: false }));
    return link;
  }
  link.url = v.url(raw?.url, `${path}.url`);
  return link;
}

function normaliseTile(v, raw, index) {
  const path = `tiles[${index}]`;
  const type = v.str(raw?.type, `${path}.type`, { max: 40, required: true });
  if (!TILE_TYPES[type]) {
    v.fail(`${path}.type`, `unknown tile type "${type}"`);
    return null;
  }
  const tile = {
    id: v.id(raw?.id, `${path}.id`, 'tile'),
    type,
    span: v.num(raw?.span, `${path}.span`, { min: 0.4, max: 4, fallback: 1 }),
    settings: {},
  };
  const s = raw?.settings ?? {};
  if (type === 'weather-secondary') {
    tile.settings = {
      name: v.str(s.name, `${path}.settings.name`, { max: 80, fallback: '' }),
      latitude: v.num(s.latitude, `${path}.settings.latitude`, { min: -90, max: 90, fallback: 0 }),
      longitude: v.num(s.longitude, `${path}.settings.longitude`, { min: -180, max: 180, fallback: 0 }),
      timezone: v.str(s.timezone, `${path}.settings.timezone`, { max: 60, fallback: 'Europe/Paris' }),
    };
  } else if (type === 'weather-local') {
    tile.settings = {
      label: v.str(s.label, `${path}.settings.label`, { max: 80, fallback: '' }),
    };
  } else if (type === 'note') {
    tile.settings = {
      heading: v.str(s.heading, `${path}.settings.heading`, { max: 80, fallback: 'Note' }),
      body: v.str(s.body, `${path}.settings.body`, { max: 2000, fallback: '' }),
    };
  }
  return tile;
}

/**
 * Validate an arbitrary object as a dashboard configuration.
 * Always returns a usable document: unknown fields are dropped, malformed ones
 * are reported in `errors` and replaced by a safe default.
 */
export function validateConfig(input) {
  const v = new Validator();
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['config: must be an object'], value: null };
  }

  const version = v.num(input.version, 'version', { min: 1, max: CONFIG_VERSION, fallback: CONFIG_VERSION });
  const site = input.site ?? {};
  const search = input.search ?? {};
  const integrations = input.integrations ?? {};
  const weather = integrations.weather ?? {};
  const georide = integrations.georide ?? {};

  const value = {
    version: CONFIG_VERSION,
    site: {
      title: v.str(site.title, 'site.title', { max: 60, fallback: 'Dashboard' }) || 'Dashboard',
      subtitle: v.str(site.subtitle, 'site.subtitle', { max: 60, fallback: '' }),
      greeting: v.str(site.greeting, 'site.greeting', { max: 60, fallback: '' }),
      sectionTitle: v.str(site.sectionTitle, 'site.sectionTitle', { max: 80, fallback: 'Applications & folders' }),
      locale: v.str(site.locale, 'site.locale', { max: 10, fallback: 'en' }),
      clockTimezone: v.str(site.clockTimezone, 'site.clockTimezone', { max: 60, fallback: 'Europe/Paris' }),
      clockLabel: v.str(site.clockLabel, 'site.clockLabel', { max: 40, fallback: '' }),
    },
    search: {
      enabled: v.bool(search.enabled, true),
      action: search.action === undefined ? 'https://duckduckgo.com/' : v.url(search.action, 'search.action', { required: false }),
      param: v.str(search.param, 'search.param', { max: 20, fallback: 'q' }) || 'q',
      placeholder: v.str(search.placeholder, 'search.placeholder', { max: 60, fallback: 'Quick search…' }),
      newTab: v.bool(search.newTab, true),
    },
    tiles: [],
    links: [],
    integrations: {
      weather: {
        enabled: v.bool(weather.enabled, true),
        useBrowserGeolocation: v.bool(weather.useBrowserGeolocation, true),
        fallback: {
          latitude: v.num(weather.fallback?.latitude, 'integrations.weather.fallback.latitude', { min: -90, max: 90, fallback: 48.8566 }),
          longitude: v.num(weather.fallback?.longitude, 'integrations.weather.fallback.longitude', { min: -180, max: 180, fallback: 2.3522 }),
        },
        reverseGeocoding: v.bool(weather.reverseGeocoding, true),
        refreshMinutes: v.num(weather.refreshMinutes, 'integrations.weather.refreshMinutes', { min: 5, max: 720, fallback: 30 }),
      },
      georide: {
        enabled: v.bool(georide.enabled, false),
        trackerId: georide.trackerId === null || georide.trackerId === undefined
          ? null
          : v.num(georide.trackerId, 'integrations.georide.trackerId', { min: 1, max: 1e12, fallback: null }),
        trackerName: v.str(georide.trackerName, 'integrations.georide.trackerName', { max: 80, fallback: '' }),
        periodDays: v.num(georide.periodDays, 'integrations.georide.periodDays', { min: 1, max: 31, fallback: 7 }),
        refreshMinutes: v.num(georide.refreshMinutes, 'integrations.georide.refreshMinutes', { min: 1, max: 720, fallback: 5 }),
        showMap: v.bool(georide.showMap, true),
      },
    },
  };

  if (!Array.isArray(input.tiles)) {
    v.fail('tiles', 'must be an array');
  } else {
    const seen = new Set();
    value.tiles = input.tiles
      .slice(0, 24)
      .map((tile, i) => normaliseTile(v, tile, i))
      .filter((tile) => {
        if (!tile) return false;
        if (TILE_TYPES[tile.type].singleton && seen.has(tile.type)) {
          v.fail('tiles', `tile type "${tile.type}" may only appear once`);
          return false;
        }
        seen.add(tile.type);
        return true;
      });
  }

  if (!Array.isArray(input.links)) {
    v.fail('links', 'must be an array');
  } else {
    value.links = input.links
      .slice(0, 400)
      .map((link, i) => normaliseLink(v, link, `links[${i}]`, { allowItems: true }));
  }

  // A link entry must be either a shortcut or a folder, never both.
  value.links.forEach((link, i) => {
    if (link.items && link.url) {
      v.fail(`links[${i}]`, 'cannot be both a folder and a shortcut');
      delete link.url;
    }
  });

  return { ok: v.errors.length === 0, errors: v.errors, value, sourceVersion: version };
}

/**
 * Bring an older configuration document up to the current version.
 * Kept explicit so that future format changes stay auditable.
 */
export function migrateConfig(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  let doc = { ...raw };
  const from = Number(doc.version) || 1;
  if (from > CONFIG_VERSION) {
    throw new Error(
      `This file was produced by a newer Glassboard (config version ${from}, this instance supports ${CONFIG_VERSION}). Upgrade before importing.`
    );
  }
  // No migration steps yet — version 1 is the initial format.
  doc.version = CONFIG_VERSION;
  return doc;
}
