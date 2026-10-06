/* The page around the tiles: navigation, shortcuts, folders, the clock and
   the header. None of it knows which features the instance has. */
import { id, safe, esc, svg, iconName } from './dom.js';
import { state } from './state.js';
import { openModal, closeModal } from './modals.js';
import { applyAppearance } from './theme.js';

/* Edit mode layers itself on top of read mode. Rather than the renderer
   calling into the editor, the editor registers what it wants decorated — so
   a page that never enters edit mode never mentions it. */
const decorators = { links: null, folder: null, tiles: null };
export const setEditDecorators = (next) => Object.assign(decorators, next);
export const decorate = (what, ...args) => { if (state.editing) decorators[what]?.(...args); };

/* The account menu lives in the shell, but the phone dock has to reach it. */
let openAccountMenu = () => {};
export const setAccountMenuToggle = (fn) => { openAccountMenu = fn; };

/* ------------------------------- navigation ------------------------------ */

export function goTo(anchor, trigger) {
  const target = id(anchor);
  // On a phone the overview wrapper has no box of its own: go to the top instead.
  if (target?.getClientRects().length) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  else window.scrollTo({ top: 0, behavior: 'smooth' });
  document.querySelectorAll('.pill, .dock-item').forEach((p) => p.classList.remove('active'));
  if (trigger) trigger.classList.add('active');
}

/* A module may add entries of its own — a weather tile puts its city in the
   side navigation. The two below are the only ones the core owns. */
let moduleNavEntries = () => [];
export const setModuleNavEntries = (fn) => { moduleNavEntries = fn; };

export function navEntries() {
  return [
    { icon: 'sparkle', label: t('nav.overview'), short: t('dock.overview'), run: (button) => goTo('overview', button) },
    { icon: 'folder', label: t('nav.apps'), short: t('dock.apps'), run: (button) => goTo('apps-section', button) },
    ...moduleNavEntries(),
  ];
}

export function renderNav() {
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
  account.addEventListener('click', (event) => { event.stopPropagation(); openAccountMenu(); });
  dock.appendChild(account);
}

/* ------------------------------- shortcuts ------------------------------- */

export function linkCardInner(link, { showCaret }) {
  const sheen = `<div class="sheen" style="background:linear-gradient(180deg,transparent,${esc(link.color)})"></div>`;
  const caret = showCaret ? `<div class="caret">${svg('caret-down', 'font-size:12px')}</div>` : '';
  const subtitle = link.items ? t('apps.links', { n: link.items.length }) : t('apps.direct');
  return `${sheen}${caret}<div class="appic" style="background:${esc(link.color)};box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 10px 24px ${esc(link.color)}44">${svg(link.icon)}</div>` +
    `<div><div class="app-tt">${esc(link.title)}</div><div class="app-sub">${esc(subtitle)}</div></div>`;
}

export function renderLinks() {
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
    // The card itself goes along, so the folder opens out of it.
    el.addEventListener('click', () => openFolder(Number(el.dataset.link), el));
  });
  decorate('links');
}

export function openFolder(index, origin = null) {
  const folder = state.config.links[index];
  if (!folder?.items) return;
  safe(id('folder-modal-title'), folder.title);
  id('folder-modal-icon-bg').style.background = folder.color;
  id('folder-modal-icon').innerHTML = PH[iconName(folder.icon)] || '';
  id('folder-modal').dataset.folder = index;
  id('folder-links-grid').innerHTML = folder.items
    .map(
      (item, i) =>
        `<a class="app in" data-item="${i}" style="--i:${i}" href="${esc(item.url)}" target="_blank" rel="noopener">` +
        `<div class="appic" style="background:${esc(item.color)};box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 8px 18px ${esc(item.color)}44">${svg(item.icon)}</div>` +
        `<div><div class="app-tt">${esc(item.title)}</div><div class="app-sub">${esc(t('apps.direct'))}</div></div></a>`
    )
    .join('');
  decorate('folder', index);
  openModal('folder-modal', origin ?? document.querySelector(`[data-folder][data-link="${index}"]`));
}

export const closeFolder = () => closeModal('folder-modal');

/* ------------------------------ clock & date ----------------------------- */

export function updateTime() {
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

/* -------------------------------- header --------------------------------- */

export function renderChrome() {
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
