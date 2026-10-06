/* Light and dark, the colour presets, the orbs and the wallpaper. */
import { html, id, reducedMotion, clone } from './dom.js';
import { api, toast } from './api.js';
import { state } from './state.js';

/* The kernel used to repaint the GeoRide map itself when the theme changed.
   It no longer knows there is a map: a module subscribes, and is called. */
const themeListeners = new Set();
export const onThemeChange = (fn) => { themeListeners.add(fn); return () => themeListeners.delete(fn); };
const announceTheme = () => themeListeners.forEach((fn) => { try { fn(); } catch { /* one module's problem */ } });

export function setTheme(dark) {
  html.setAttribute('data-theme', dark ? 'dark' : 'light');
  const icon = id('theme-icon');
  if (icon) icon.innerHTML = PH[dark ? 'moon' : 'sun'] || '';
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* private mode */ }
  announceTheme();
  syncStatusBarColour();
}

/** Paint the phone status bar and the PWA chrome with the current backdrop. */
export function syncStatusBarColour() {
  const meta = id('meta-theme-color');
  if (!meta) return;
  // Sampled from the backdrop so the status bar blends into the page.
  const base = getComputedStyle(html).getPropertyValue('--wall-base-1').trim();
  if (base) meta.setAttribute('content', base);
}

export function toggleTheme() { setTheme(html.getAttribute('data-theme') !== 'dark'); }

/** Apply a colour preset, the orbs and the wallpaper. Pass a draft to preview it. */
export function applyAppearance(appearance = state.config?.appearance, version = state.wallpaperVersion) {
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
export function setPreset(preset) {
  // The state changes now, synchronously: a view transition defers its
  // callback, and anything saving right after would send the previous value.
  state.config.appearance.preset = preset;
  withTransition(() => {
    applyAppearance();
    syncStatusBarColour();
  });
}

/** Run a repaint inside a cross-fade where the browser supports one. */
export function withTransition(repaint) {
  if (typeof document.startViewTransition === 'function' && !reducedMotion()) {
    document.startViewTransition(repaint);
  } else {
    repaint();
  }
}

/** Pick a preset at random, never the one already showing. */
export async function shuffleTheme() {
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

/** The image is cached hard, so its timestamp is what busts that cache. */
export async function loadWallpaperVersion() {
  try {
    const info = await api('/api/appearance/wallpaper/info');
    state.wallpaperVersion = info.wallpaper?.updatedAt || '';
  } catch {
    state.wallpaperVersion = '';
  }
}
