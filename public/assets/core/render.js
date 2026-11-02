/* Drawing the whole page, and the data tick.
 *
 * Its own file rather than part of the boot, because the editor calls both of
 * these after a change and the boot calls into the editor to wire it up —
 * leaving them together made the two files import each other. */
import { renderChrome, renderNav, renderLinks, renderSidebar, updateTime } from './chrome.js';
import { renderTiles, refreshModules } from './tiles.js';
import { applyBentoLayout } from './bento.js';

export function renderAll() {
  renderChrome();
  renderNav();
  renderTiles();
  renderSidebar();
  renderLinks();
  updateTime();
  // Last: the bento frame rearranges the pieces the renderers just drew. In
  // glass it is a no-op, so read mode there stays exactly as it was.
  applyBentoLayout();
}

/* When the data last came in, so returning to a tab that has been hidden for
   a while refreshes and flicking between tabs does not. */
let lastRefresh = 0;
export const sinceLastRefresh = () => Date.now() - lastRefresh;

export function refreshData() {
  lastRefresh = Date.now();
  refreshModules();
}
