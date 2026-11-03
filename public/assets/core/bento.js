/* The bento layout adapter.
 *
 * The dark bento style is not a reskin of the glass chrome: it rearranges the
 * same pieces into a different frame — a left sidebar, a header inside the main
 * column, a twelve-column grid. Rather than duplicate every dynamic container
 * (nav, tiles, clock, search…) this module *relocates the real elements*. Their
 * ids never change, so every renderer in chrome.js, tiles.js and the modules
 * keeps writing to them exactly as before, whichever style is on.
 *
 * mount() moves the nodes into a scaffold it builds once; unmount() puts each
 * one back where index.html had it, so switching back to glass is lossless and
 * the glass DOM is never touched while glass is the active style.
 *
 * base.css is untouched; the bento frame's own rules live in styles/bento.css.
 */
import { id, svg, esc } from './dom.js';
import { state } from './state.js';

/* Handlers the header and sidebar buttons need, injected by the boot so this
   core module never imports the editor (which would close an import cycle). */
let handlers = { toggleEdit: () => {}, openSettings: () => {} };
export const setBentoHandlers = (next) => { handlers = { ...handlers, ...next }; };

let mounted = false;
let scaffold = null;          // the elements we create once and reuse
const homes = new Map();      // node -> { parent, next } captured before the first move

/** Remember where a node lived so unmount can return it exactly there. */
function rememberHome(node) {
  if (node && !homes.has(node)) homes.set(node, { parent: node.parentNode, next: node.nextSibling });
}

/** Build the static pieces the bento frame adds: a brand block and a footer for
 *  the sidebar, and the header shell with its Edit button. Built once, reused. */
function buildScaffold() {
  if (scaffold) return scaffold;

  const brand = document.createElement('div');
  brand.className = 'bento-brand';
  brand.innerHTML =
    `<div class="bento-mark">${svg('house', 'font-size:18px')}</div>` +
    `<div class="bento-brand-txt"><div class="bento-brand-title" id="bento-brand-title"></div>` +
    `<div class="bento-brand-sub" id="bento-brand-sub"></div></div>`;

  const foot = document.createElement('div');
  foot.className = 'bento-foot';
  const settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'bento-foot-btn';
  settingsBtn.innerHTML = `${svg('gear-six', 'font-size:18px')}<span data-t="menu.settings">Settings</span>`;
  settingsBtn.addEventListener('click', () => handlers.openSettings());
  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'bento-foot-btn bento-collapse';
  collapseBtn.innerHTML = `${svg('caret-right', 'font-size:18px')}<span class="bento-collapse-label"></span>`;
  collapseBtn.addEventListener('click', toggleCollapse);
  foot.append(settingsBtn, collapseBtn);

  const head = document.createElement('header');
  head.className = 'bento-head';
  const left = document.createElement('div');
  left.className = 'bento-head-l';
  const right = document.createElement('div');
  right.className = 'bento-head-r';
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'bento-edit';
  editBtn.addEventListener('click', () => handlers.toggleEdit());
  head.append(left, right);

  // The date line: the pieces (date, time, alt clock) are moved in by mount();
  // these are the separators and the wrapper the updater never touches.
  const dateline = document.createElement('div');
  dateline.className = 'bento-dateline';

  scaffold = { brand, foot, collapseBtn, head, left, right, editBtn, dateline, settingsBtn };
  return scaffold;
}

/** The collapsed state lives in localStorage so it survives a reload, like the
 *  theme does. Labels hide; the chevron flips. */
function toggleCollapse() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;
  const collapsed = !sidebar.classList.contains('bento-collapsed');
  sidebar.classList.toggle('bento-collapsed', collapsed);
  try { localStorage.setItem('sidebar', collapsed ? 'collapsed' : 'expanded'); } catch { /* private mode */ }
  syncCollapseLabel(collapsed);
}

function syncCollapseLabel(collapsed) {
  if (!scaffold) return;
  const label = scaffold.collapseBtn.querySelector('.bento-collapse-label');
  if (label) label.textContent = collapsed ? t('bento.expand') : t('bento.collapse');
  scaffold.collapseBtn.setAttribute('title', collapsed ? t('bento.expand') : t('bento.collapse'));
}

/** Move a node into a new parent, remembering where it came from. */
function move(node, parent) {
  if (!node || !parent) return;
  rememberHome(node);
  parent.appendChild(node);
}

function mount() {
  if (mounted) return;
  const sidebar = document.querySelector('.sidebar');
  const overview = id('overview');
  const tiles = id('tiles');
  if (!sidebar || !overview || !tiles) return;
  const s = buildScaffold();

  // Sidebar: brand on top, then the existing nav, then the footer.
  sidebar.insertBefore(s.brand, sidebar.firstChild);
  sidebar.appendChild(s.foot);

  // Header, first thing in the main column. Greeting and the date line on the
  // left; search and the three buttons on the right.
  overview.insertBefore(s.head, overview.firstChild);
  move(id('greeting'), s.left);
  s.left.appendChild(s.dateline);
  move(id('header-date'), s.dateline);
  s.dateline.appendChild(sep());
  move(id('digital-clock'), s.dateline);
  move(id('alt-clock-row'), s.dateline);

  move(id('search-form'), s.right);
  s.right.appendChild(s.editBtn);
  move(id('theme-toggle-top'), s.right);
  move(id('account-toggle'), s.right);

  // The calendar card becomes a tall tile in the grid rather than a sidebar
  // card. Empty (its module off), it hides itself through CSS.
  move(id('side-extra'), tiles);

  mounted = true;
  // Restore the collapsed state, label the Edit button, translate the new bits.
  let collapsed = false;
  try { collapsed = localStorage.getItem('sidebar') === 'collapsed'; } catch { /* private mode */ }
  sidebar.classList.toggle('bento-collapsed', collapsed);
  sync();
}

/** A middle-dot separator for the date line. */
function sep() {
  const span = document.createElement('span');
  span.className = 'bento-sep';
  span.setAttribute('aria-hidden', 'true');
  span.textContent = '·';
  return span;
}

function unmount() {
  if (!mounted) return;
  // Put every moved node back exactly where index.html had it.
  for (const [node, home] of homes) {
    if (home.parent) home.parent.insertBefore(node, home.next);
  }
  homes.clear();
  // Detach the pieces we added. They are kept for the next mount.
  scaffold?.brand.remove();
  scaffold?.foot.remove();
  scaffold?.head.remove();
  const sidebar = document.querySelector('.sidebar');
  sidebar?.classList.remove('bento-collapsed');
  mounted = false;
}

/** Keep the bento-only text in step with the configuration and the state: the
 *  brand, the Edit button's label, the collapse label, and any fresh icons. */
export function sync() {
  if (!mounted || !scaffold) return;
  const config = state.config || {};
  scaffold.brand.querySelector('#bento-brand-title').textContent = config.site?.title || '';
  const sub = scaffold.brand.querySelector('#bento-brand-sub');
  sub.textContent = config.site?.subtitle || '';
  sub.hidden = !config.site?.subtitle;

  scaffold.editBtn.innerHTML = state.editing
    ? `${svg('pencil-simple', 'font-size:16px')}<span>${esc(t('edit.done'))}</span>`
    : `${svg('pencil-simple', 'font-size:16px')}<span>${esc(t('menu.edit'))}</span>`;

  const collapsed = document.querySelector('.sidebar')?.classList.contains('bento-collapsed');
  syncCollapseLabel(collapsed);
}

/** Called after every full render and whenever the style changes: mount the
 *  bento frame when bento is on, take it down when it is not. */
export function applyBentoLayout() {
  const style = state.config?.appearance?.style || 'bento';
  if (style === 'bento') { mount(); sync(); }
  else unmount();
  applyMobileHidden();
}

/** Mark the cards the phone view hides, so the stylesheet can drop them under
 *  820px. The attribute is set in both styles; only the bento phone layout acts
 *  on it. Pass a list to preview a choice before it is saved. */
export function applyMobileHidden(list = state.config?.layout?.mobileHidden) {
  const set = new Set(Array.isArray(list) ? list : []);
  const mark = (node, key) => {
    if (!node) return;
    if (set.has(key)) node.setAttribute('data-mobile-hidden', '');
    else node.removeAttribute('data-mobile-hidden');
  };
  mark(id('search-card'), 'search');
  mark(id('search-form'), 'search');
  mark(id('apps-section'), 'apps');
  mark(id('side-extra'), 'calendar');
  for (const tile of state.config?.tiles || []) {
    mark(document.querySelector(`[data-tile="${CSS.escape(tile.id)}"]`), tile.id);
  }
}
