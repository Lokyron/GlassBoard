/* Starting the dashboard, and keeping it ticking.
 *
 * Nothing here mentions a feature by name. The modules the configuration
 * needs are imported, rendered and refreshed through the registry; adding one
 * changes nothing in this file. */
import { id, clone, hydrateIcons, html, reducedMotion } from './dom.js';
import { api, toast } from './api.js';
import { state } from './state.js';
import { closeAllModals } from './modals.js';
import { setTheme, toggleTheme, loadWallpaperVersion, shuffleTheme } from './theme.js';
import { updateTime, closeFolder, setAccountMenuToggle } from './chrome.js';
import { loadModulesForConfig, resizeModules, closeModuleViews } from './tiles.js';
import { renderAll, refreshData, sinceLastRefresh } from './render.js';
import { closeDialog } from './dialogs.js';
import {
  checkForUpdateBadge, syncInstallItem, installApp, checkForNews,
  toggleAccountMenu, doLogout,
} from './shell.js';
import { setEditing, openSettings, openExportDialog, openImportDialog, bindEditor } from '../edit.js';

/* --------------------------------- timers -------------------------------- */
/* Nothing ticks while the tab is hidden: on a phone that is battery, and on a
   dashboard left open all day it is a poll every few minutes for nobody. */

let clockTimer = null;
let dataTimer = null;

export function startTimers() {
  stopTimers();
  clockTimer = setInterval(updateTime, 1000);
  const minutes = Math.max(5, state.config?.integrations?.weather?.refreshMinutes ?? 30);
  dataTimer = setInterval(refreshData, minutes * 60000);
}

export function stopTimers() {
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
  if (sinceLastRefresh() > 60000) refreshData();
  startTimers();
}

/**
 * Background parallax, on a pointer that can actually hover and at one update
 * per frame. Touch screens and reduced-motion users get a still backdrop.
 */
function installParallax() {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches || reducedMotion()) return;
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

/* ---------------------------------- boot ---------------------------------- */

async function boot() {
  hydrateIcons();
  const stored = (() => { try { return localStorage.getItem('theme'); } catch { return null; } })();
  setTheme(stored ? stored === 'dark' : matchMedia('(prefers-color-scheme:dark)').matches);
  id('theme-toggle-top').addEventListener('click', toggleTheme);

  setAccountMenuToggle(toggleAccountMenu);
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
  id('dialog-close').addEventListener('click', closeDialog);
  id('dialog-modal').addEventListener('click', (event) => { if (event.target === id('dialog-modal')) closeDialog(); });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeAllModals();
    closeModuleViews();
    toggleAccountMenu(false);
  });

  installParallax();
  bindEditor();
  pwa.onChange = syncInstallItem;
  syncInstallItem();
  checkForUpdateBadge();

  document.addEventListener('visibilitychange', onVisibilityChange);

  let resizeTimer;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeModules, 150);
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

  // The modules this dashboard needs, and only those. Awaited: a tile cannot
  // be drawn by a module that has not arrived.
  await loadModulesForConfig();

  renderAll();
  refreshData();
  startTimers();
  // Last, and deliberately not awaited: the dialog is the least urgent thing
  // on the page and must never hold the dashboard up.
  checkForNews();
}

boot().catch((error) => {
  console.error(error);
  if (error.message !== 'unauthenticated') toast(error.message, 'error');
});
