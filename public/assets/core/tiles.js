/* The client-side module registry.
 *
 * The renderer no longer knows what a weather tile or a parcel tile is. It
 * reads the tiles in the configuration, asks the server which module owns
 * each type, and imports that module's client — only the ones the dashboard
 * actually shows. A module nobody has a tile for is never fetched, which is
 * what keeps a feature off the page instead of merely out of sight.
 *
 * A module client is an ES module whose default export is:
 *
 *   {
 *     id,
 *     tiles: { '<type>': { markup(tile, index), open(article, tile) } },
 *     mounted(),      after a render, to attach anything the markup implies
 *     refresh(),      on the data tick, and when the tab comes back
 *     navEntries(),   side-navigation entries this module contributes
 *     unmount(),      before a re-render, to release maps, timers, listeners
 *   }
 *
 * Everything but `tiles` is optional. */
import { id, esc } from './dom.js';
import { state } from './state.js';
import { decorate, setModuleNavEntries } from './chrome.js';
import { onThemeChange } from './theme.js';

/** module id -> its loaded client. */
const loaded = new Map();

export const tileElement = (tileId) => document.querySelector(`[data-tile="${CSS.escape(tileId)}"]`);

/** The module that owns a tile type, as the server composed it. */
const moduleIdOf = (type) => state.tileTypes?.[type]?.module ?? null;

/** The one switch, per module and per account. */
export const isModuleEnabled = (moduleId) => state.config?.modules?.[moduleId]?.enabled === true;

/* A switched-off module is not drawn and not even fetched. Its tiles stay in
   the configuration, so switching it back on returns the dashboard as it was. */
export const visibleTiles = () =>
  (state.config?.tiles ?? []).filter((tile) => isModuleEnabled(moduleIdOf(tile.type)));

/** The module clients the current configuration needs, loaded once each. */
export async function loadModulesForConfig() {
  const wanted = new Set(visibleTiles().map((tile) => moduleIdOf(tile.type)).filter(Boolean));
  await Promise.all(
    [...wanted]
      .filter((moduleId) => !loaded.has(moduleId))
      .map(async (moduleId) => {
        try {
          // Mounted from the module's client/ folder, so the folder itself does
          // not appear in the URL. test/server.test.js asserts the two agree.
          const imported = await import(`/modules/${moduleId}/tile.js`);
          const client = imported.default;
          loaded.set(moduleId, client);
          if (client.onThemeChange) onThemeChange(() => client.onThemeChange());
        } catch (error) {
          // One module failing to load is not the dashboard failing to load.
          console.error(`[glassboard] module "${moduleId}" did not load`, error);
        }
      })
  );
  setModuleNavEntries(() =>
    [...loaded.values()].flatMap((client) => (client.navEntries ? client.navEntries() : []))
  );
}

const clientFor = (type) => loaded.get(moduleIdOf(type)) ?? null;
const tileSpecFor = (type) => clientFor(type)?.tiles?.[type] ?? null;

/** A tile whose module did not load, said plainly rather than left blank. */
const missingMarkup = (tile, index) =>
  `<article class="card glass rise" style="animation-delay:.${String(5 * (index + 1)).padStart(2, '0')}s" data-tile="${esc(tile.id)}" data-type="${esc(tile.type)}">
     <div class="lbl">${esc(tile.type)}</div><p class="gr-message">${esc(t('tile.moduleUnavailable'))}</p></article>`;

export function renderTiles() {
  const grid = id('tiles');
  const tiles = visibleTiles();

  /* Adding a tile in edit mode can call for a module the page has never
     needed. Rather than make every caller await, the tile is drawn as
     unavailable, the module is fetched, and the grid is drawn again — which
     is over before the card has finished sliding in. */
  const absent = tiles.some((tile) => moduleIdOf(tile.type) && !loaded.has(moduleIdOf(tile.type)));
  if (absent) loadModulesForConfig().then(renderTiles);

  // Anything the previous render left running — a map, an observer — goes
  // before its element does.
  loaded.forEach((client) => client.unmount?.());

  grid.style.gridTemplateColumns = tiles.length ? tiles.map((tile) => `${tile.span}fr`).join(' ') : '1fr';
  grid.innerHTML = tiles
    .map((tile, index) => tileSpecFor(tile.type)?.markup(tile, index) ?? missingMarkup(tile, index))
    .join('');

  // Opening a tile's own panel. Never in edit mode: there, a click is a grab.
  tiles.forEach((tile) => {
    const spec = tileSpecFor(tile.type);
    const article = tileElement(tile.id);
    if (!spec?.open || !article) return;
    article.addEventListener('click', (event) => {
      if (state.editing) return;
      spec.open(article, tile, event);
    });
  });

  loaded.forEach((client) => client.mounted?.());
  decorate('tiles');
}

/** The data tick: every module refreshes its own tiles, none waits on another.
 *
 * A module switched off while the page was open stays in memory — there is no
 * unloading an ES module — so the switch is checked here rather than assumed
 * from the module not being there. Without it, a module turned off went on
 * polling a route that now answers 404. */
export function refreshModules() {
  loaded.forEach((client, moduleId) => {
    if (!isModuleEnabled(moduleId)) return;
    try { client.refresh?.(); } catch (error) { console.error(error); }
  });
}

/* A window resize reaches the modules that measure something — a canvas, a
   viewBox cut to its column, a map. Debounced once here rather than once per
   module. */
export function resizeModules() {
  loaded.forEach((client) => {
    try { client.onResize?.(); } catch (error) { console.error(error); }
  });
}

/** Closing everything: each module puts away whatever it had open. */
export function closeModuleViews() {
  loaded.forEach((client) => {
    try { client.closeViews?.(); } catch (error) { console.error(error); }
  });
}
