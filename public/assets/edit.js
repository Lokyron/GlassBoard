/* Glassboard — live editing, settings and backup dialogs.
   Everything here is layered on top of the read-mode renderer: read mode
   renders exactly the same markup whether or not this file did anything. */
import {
  id, esc, svg, iconName, hydrateIcons, el, clone, state,
  api, toast, openDialog, closeDialog, tileElement,
} from './core/kernel.js';
import { applyAppearance, withTransition } from './core/theme.js';
import { renderLinks, openFolder, closeFolder, setEditDecorators } from './core/chrome.js';
import { renderTiles } from './core/tiles.js';
import { renderAll, refreshData } from './core/render.js';
import { downloadExport, openNewsHistory } from './core/shell.js';


const uid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const PALETTE = ['#0a84ff', '#5e5ce6', '#64d2ff', '#16a34a', '#34c759', '#eab308', '#f97316', '#ea580c', '#ef4444', '#ec4899', '#a129cc', '#8b5cf6', '#3b82f6', '#10b981', '#14b8a6', '#475569'];

/* ----------------------------- form building ----------------------------- */


function field(label, control, hint) {
  return el('label', { class: 'fld' }, [
    el('span', { class: 'fld-l', text: label }),
    control,
    hint ? el('span', { class: 'fld-h', text: hint }) : null,
  ]);
}

function textInput(value, attributes = {}) {
  return el('input', { class: 'inp', type: 'text', value: value ?? '', ...attributes });
}

function checkbox(label, checked, onChange) {
  const input = el('input', { type: 'checkbox', onchange: (event) => onChange(event.target.checked) });
  input.checked = Boolean(checked);
  return el('label', { class: 'chk' }, [input, el('span', { text: label })]);
}

function colourPicker(value, onChange) {
  const wrap = el('div', { class: 'swatches' });
  const native = el('input', { class: 'swatch-native', type: 'color', value, onchange: (e) => { onChange(e.target.value); paint(e.target.value); } });
  const buttons = PALETTE.map((colour) =>
    el('button', {
      class: 'swatch', type: 'button', 'data-colour': colour,
      style: `background:${colour}`,
      onclick: () => { native.value = colour; onChange(colour); paint(colour); },
    })
  );
  function paint(selected) {
    buttons.forEach((button) => button.classList.toggle('on', button.dataset.colour === selected));
  }
  buttons.forEach((button) => wrap.appendChild(button));
  wrap.appendChild(native);
  paint(value);
  return wrap;
}

function iconPicker(value, onChange) {
  const wrap = el('div', { class: 'iconpick' });
  const names = Object.keys(PH).sort();
  const buttons = names.map((name) =>
    el('button', {
      class: `iconopt${name === iconName(value) ? ' on' : ''}`, type: 'button', 'data-icon': name,
      title: name, html: svg(name),
      onclick: () => {
        onChange(name);
        wrap.querySelectorAll('.iconopt').forEach((b) => b.classList.toggle('on', b.dataset.icon === name));
      },
    })
  );
  buttons.forEach((button) => wrap.appendChild(button));
  return wrap;
}

function slider(value, min, max, step, onChange) {
  const output = el('span', { class: 'fld-h', text: String(value) });
  const input = el('input', {
    class: 'range', type: 'range', min: String(min), max: String(max), step: String(step), value: String(value),
    oninput: (event) => {
      const next = Number(event.target.value);
      output.textContent = String(next);
      onChange(next);
    },
  });
  return el('div', { class: 'rangerow' }, [input, output]);
}

function dialogFooter(onSave, onCancel = closeDialog, saveLabel = t('dlg.save')) {
  return el('div', { class: 'dlg-foot' }, [
    el('button', { class: 'btn ghost', type: 'button', text: t('dlg.cancel'), onclick: onCancel }),
    el('button', { class: 'btn primary', type: 'button', text: saveLabel, onclick: onSave }),
  ]);
}

/* ------------------------------- edit mode ------------------------------- */

const isDirty = () => JSON.stringify(state.config) !== JSON.stringify(state.saved);

export function setEditing(on) {
  if (!on && isDirty() && !confirm(t('edit.unsaved'))) return;
  state.editing = on;
  document.body.classList.toggle('editing', on);
  id('editbar').hidden = !on;
  renderAll();
  if (!on) refreshData();
  else refreshData();
}

async function saveDashboard() {
  try {
    const payload = await api('/api/config', { method: 'PUT', body: { config: state.config, note: 'edited in the browser' } });
    state.config = payload.config;
    state.saved = clone(payload.config);
    toast(t('edit.saved'));
    setEditing(false);
  } catch (error) {
    toast(error.details?.length ? `${error.message}: ${error.details[0]}` : error.message, 'error');
  }
}

function cancelEditing() {
  state.config = clone(state.saved);
  state.editing = false;
  document.body.classList.toggle('editing', false);
  id('editbar').hidden = true;
  renderAll();
  refreshData();
  toast(t('edit.discarded'));
}

/* ----------------------- home-screen style arranging ---------------------- */

const LONG_PRESS_MS = 300;
const DRAG_THRESHOLD = 6;
const NEST_GRACE_MS = 220;
const SLIDE = { duration: 240, easing: 'cubic-bezier(.2, .8, .2, 1)' };

/** Put `list` in the order given as a list of former indexes. */
const reorder = (list, order) => order.map((index) => list[index]);

/**
 * Rearrange the [data-index] children of a grid the way a phone home screen
 * does: the card lifts, follows the pointer, and the other cards slide out of
 * its way while it moves. A mouse drags at once; a finger holds still for a
 * moment first, so that a swipe keeps scrolling the page.
 *
 * - onReorder(order): released on the grid, `order` lists the former indexes.
 * - canNest(from, to) / onNest(from, to): dropped on the middle of an accepting
 *   card (a folder), the card goes inside it. Its edges still reorder.
 * - bounds() / onDropOutside(from): released outside that rectangle.
 *
 * A grid keeps its element across re-renders, so the listeners are bound once
 * and read the options of the latest render.
 */
function makeArrangeable(container, selector, options) {
  container.querySelectorAll(selector).forEach((node) => node.setAttribute('draggable', 'false'));
  const bound = Boolean(container.arrangeOptions);
  container.arrangeOptions = options;
  if (!bound) bindArranging(container, selector);
}

function bindArranging(container, selector) {
  let press = null;
  let drag = null;

  const opts = () => container.arrangeOptions;
  const cards = () => [...container.querySelectorAll(selector)];
  const isCard = (node) => node && node.matches(selector) && node.parentElement === container;

  container.addEventListener('dragstart', (event) => { if (document.body.classList.contains('editing')) event.preventDefault(); });
  // Android opens a context menu on a long press, iOS a link preview.
  container.addEventListener('contextmenu', (event) => {
    if (document.body.classList.contains('editing') && event.target.closest(selector)) event.preventDefault();
  });

  container.addEventListener('pointerdown', (event) => {
    if (!document.body.classList.contains('editing')) return;
    if (drag || press || (event.pointerType === 'mouse' && event.button !== 0)) return;
    if (event.target.closest('.tile-edit, .tinybtn, .tile-grip, input, select, textarea')) return;
    const node = event.target.closest(selector);
    if (!isCard(node)) return;
    press = { node, pointer: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType !== 'mouse' };
    if (press.touch) {
      node.classList.add('pressing');
      press.timer = setTimeout(() => lift(), LONG_PRESS_MS);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  });

  function forgetPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press.node.classList.remove('pressing');
    press = null;
  }

  function unlisten() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
  }

  function onMove(event) {
    if (press && event.pointerId === press.pointer) {
      const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y) > DRAG_THRESHOLD;
      if (!moved) return;
      if (press.touch) { forgetPress(); unlisten(); return; } // a swipe: let the page scroll
      press.x = event.clientX;
      press.y = event.clientY;
      lift();
    }
    if (drag && event.pointerId === drag.pointer) follow(event.clientX, event.clientY);
  }

  function onUp(event) {
    if (press && event.pointerId === press.pointer) { forgetPress(); unlisten(); return; }
    if (drag && event.pointerId === drag.pointer) land(false);
  }

  function onCancel(event) {
    if (press && event.pointerId === press.pointer) { forgetPress(); unlisten(); return; }
    if (drag && event.pointerId === drag.pointer) land(true);
  }

  function lift() {
    const { node, x, y, pointer } = press;
    forgetPress();
    const box = node.getBoundingClientRect();
    const ghost = node.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('pressing', 'rise');
    ghost.removeAttribute('id');
    Object.assign(ghost.style, { width: `${box.width}px`, height: `${box.height}px` });
    document.body.appendChild(ghost);
    node.classList.add('drag-source');
    document.body.classList.add('arranging');
    drag = { node, ghost, pointer, from: Number(node.dataset.index), offX: x - box.left, offY: y - box.top, x, y, into: null, outside: false, over: null, overSince: 0 };
    place(x, y);
    navigator.vibrate?.(8);
    drag.frame = requestAnimationFrame(autoScroll);
  }

  function place(x, y) {
    drag.ghost.style.transform = `translate3d(${x - drag.offX}px, ${y - drag.offY}px, 0) scale(1.06)`;
  }

  function follow(x, y) {
    drag.x = x;
    drag.y = y;
    place(x, y);

    const { bounds, canNest } = opts();
    if (bounds) {
      const box = bounds();
      drag.outside = x < box.left || x > box.right || y < box.top || y > box.bottom;
      container.closest('.sheet')?.classList.toggle('drop-away', drag.outside);
      if (drag.outside) { markInto(null); return; }
    }

    const under = document.elementFromPoint(x, y)?.closest(selector);
    if (!isCard(under) || under === drag.node) { markInto(null); markOver(null); return; }
    markOver(under);
    // A card still sliding would bounce back under the pointer: wait for it to
    // settle. Timed by the clock, since animations stall in a background tab.
    if (performance.now() < (under.slidingUntil || 0)) return;

    const to = Number(under.dataset.index);
    const nestable = Boolean(canNest?.(drag.from, to));
    if (nestable && inMiddle(under, x, y)) { markInto(under); return; }
    markInto(null);
    // A folder is entered by its middle, but its edges are crossed first. Shoving
    // it aside straight away would move it out from under the pointer before the
    // middle is ever reached, which makes filing a shortcut impossible. So a
    // folder holds its ground for a moment, and only then steps aside.
    if (nestable && performance.now() - drag.overSince < NEST_GRACE_MS) return;

    const list = [...container.children];
    const after = list.indexOf(drag.node) < list.indexOf(under);
    slide(() => under[after ? 'after' : 'before'](drag.node));
  }

  /** The card the pointer sits on, and since when, to time the grace above. */
  function markOver(node) {
    if (drag.over === node) return;
    drag.over = node;
    drag.overSince = performance.now();
  }

  function markInto(node) {
    if (drag.into === node) return;
    drag.into?.classList.remove('drop-into');
    drag.into = node;
    node?.classList.add('drop-into');
  }

  /** Move DOM nodes, then animate every card from where it was to where it is. */
  function slide(mutate) {
    const others = [...container.children].filter((node) => node !== drag.node);
    const before = new Map(others.map((node) => [node, node.getBoundingClientRect()]));
    mutate();
    others.forEach((node) => {
      const from = before.get(node);
      const to = node.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (!dx && !dy) return;
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], SLIDE);
      node.slidingUntil = performance.now() + SLIDE.duration;
    });
  }

  function autoScroll() {
    if (!drag) return;
    const scroller = scrollParent(container);
    const view = scroller === document.scrollingElement
      ? { top: 0, bottom: innerHeight }
      : scroller.getBoundingClientRect();
    // Bars fixed at the bottom of a phone screen hide the last cards.
    const bar = id('editbar');
    const bottom = bar && !bar.hidden && scroller === document.scrollingElement ? Math.min(view.bottom, bar.getBoundingClientRect().top) : view.bottom;
    const edge = 72;
    let speed = 0;
    if (drag.y < view.top + edge) speed = -Math.min(1, (view.top + edge - drag.y) / edge);
    else if (drag.y > bottom - edge) speed = Math.min(1, (drag.y - (bottom - edge)) / edge);
    if (speed) {
      scroller.scrollBy(0, speed * 16);
      follow(drag.x, drag.y);
    }
    drag.frame = requestAnimationFrame(autoScroll);
  }

  function land(cancelled) {
    unlisten();
    cancelAnimationFrame(drag.frame);
    const { node, ghost, into, outside, from } = drag;
    container.closest('.sheet')?.classList.remove('drop-away');
    document.body.classList.remove('arranging');

    const { onReorder, onNest, onDropOutside } = opts();
    let commit;
    if (!cancelled && into) commit = () => onNest(from, Number(into.dataset.index));
    else if (!cancelled && outside && onDropOutside) commit = () => onDropOutside(from);
    else {
      // A cancelled drag still re-renders, which puts the cards back in place.
      const order = cancelled ? cards().map((_, i) => i) : cards().map((card) => Number(card.dataset.index));
      commit = () => onReorder(order);
    }

    const target = (into || node).getBoundingClientRect();
    const shrink = into ? 0.35 : 1;
    const landing = ghost.animate([
      { transform: ghost.style.transform, opacity: 1 },
      { transform: `translate3d(${target.left + (target.width * (1 - shrink)) / 2}px, ${target.top + (target.height * (1 - shrink)) / 2}px, 0) scale(${shrink})`, opacity: into || outside ? 0 : 1 },
    ], { duration: 200, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: 'forwards' });
    drag = null;
    suppressClick();
    // The change must not depend on the animation: it never ends in a hidden tab.
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      ghost.remove();
      node.classList.remove('drag-source');
      into?.classList.remove('drop-into');
      commit();
    };
    landing.onfinish = settle;
    setTimeout(settle, 260);
  }
}

/** The click that ends a drag must not open the card it was released on. */
function suppressClick() {
  const swallow = (event) => { event.preventDefault(); event.stopPropagation(); };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 350);
}

function inMiddle(node, x, y) {
  const box = node.getBoundingClientRect();
  const rx = (x - box.left) / box.width;
  const ry = (y - box.top) / box.height;
  return rx > 0.22 && rx < 0.78 && ry > 0.18 && ry < 0.82;
}

function scrollParent(node) {
  for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el;
  }
  return document.scrollingElement;
}

// While a card is lifted, a finger moving must drag it, not scroll the page.
document.addEventListener('touchmove', (event) => {
  if (document.body.classList.contains('arranging')) event.preventDefault();
}, { passive: false });

/* --------------------------- tiles in edit mode -------------------------- */

export function decorateTilesForEditing() {
  const grid = id('tiles');
  state.config.tiles.forEach((tile, index) => {
    const article = tileElement(tile.id);
    if (!article) return;
    article.dataset.index = index;
    article.classList.add('editable');
    const bar = el('div', { class: 'tile-edit' }, [
      el('button', { class: 'tinybtn', title: t('edit.settings'), html: svg('gear-six'), onclick: (e) => { e.stopPropagation(); openTileDialog(index); } }),
      el('button', { class: 'tinybtn danger', title: t('edit.remove'), html: svg('trash'), onclick: (e) => { e.stopPropagation(); removeTile(index); } }),
    ]);
    const grip = el('div', { class: 'tile-grip', title: 'resize', html: svg('arrows-out-line-horizontal') });
    grip.addEventListener('pointerdown', (event) => startResize(event, index));
    article.appendChild(bar);
    article.appendChild(grip);
  });

  const add = el('button', { class: 'card glass tile-add', html: `${svg('plus', 'font-size:26px')}<span>${esc(t('edit.addTile'))}</span>`, onclick: openAddTileDialog });
  grid.appendChild(add);
  grid.style.gridTemplateColumns = `${state.config.tiles.map((tile) => `${tile.span}fr`).join(' ')} .5fr`;

  makeArrangeable(grid, '.editable', {
    onReorder: (order) => {
      state.config.tiles = reorder(state.config.tiles, order);
      renderTiles();
      refreshData();
    },
  });
}

function startResize(event, index) {
  event.preventDefault();
  event.stopPropagation();
  const grid = id('tiles');
  const startX = event.clientX;
  const startSpan = state.config.tiles[index].span;
  const totalSpan = state.config.tiles.reduce((sum, tile) => sum + tile.span, 0) + 0.5;
  const pxPerFr = grid.getBoundingClientRect().width / totalSpan;

  const move = (moveEvent) => {
    const delta = (moveEvent.clientX - startX) / pxPerFr;
    const span = Math.min(4, Math.max(0.4, Math.round((startSpan + delta) * 20) / 20));
    state.config.tiles[index].span = span;
    grid.style.gridTemplateColumns = `${state.config.tiles.map((tile) => `${tile.span}fr`).join(' ')} .5fr`;
    if (state.map) state.map.invalidateSize();
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

function removeTile(index) {
  const tile = state.config.tiles[index];
  if (!confirm(t('edit.confirmRemove', { name: state.tileTypes[tile.type]?.label || tile.type }))) return;
  state.config.tiles.splice(index, 1);
  renderTiles();
  refreshData();
}

/** The icon each tile type is offered with; anything new falls back to weather. */
const TILE_ICONS = { georide: 'motorcycle', note: 'notebook', parcels: 'package' };

function openAddTileDialog() {
  const used = new Set(state.config.tiles.map((tile) => tile.type));
  const available = Object.entries(state.tileTypes).filter(([type, meta]) => !meta.singleton || !used.has(type));
  const body = el('div', { class: 'dlg' }, [
    el('div', { class: 'tile-choices' }, available.map(([type, meta]) =>
      el('button', {
        class: 'tile-choice', type: 'button',
        html: `${svg(TILE_ICONS[type] ?? 'cloud-sun', 'font-size:22px')}<span>${esc(meta.label)}</span>`,
        onclick: () => { addTile(type); closeDialog(); },
      })
    )),
    available.length === 0 ? el('p', { class: 'fld-h', text: '—' }) : null,
  ]);
  openDialog({ title: t('edit.addTile'), body });
}

function addTile(type) {
  const tile = { id: uid('tile'), type, span: 1, settings: {} };
  if (type === 'note') tile.settings = { heading: t('note.heading'), body: '' };
  if (type === 'weather-secondary') tile.settings = { name: '', latitude: 0, longitude: 0, timezone: 'Europe/Paris' };
  if (type === 'weather-local') tile.settings = { label: '' };
  state.config.tiles.push(tile);
  renderTiles();
  refreshData();
}

function openTileDialog(index) {
  const tile = clone(state.config.tiles[index]);
  const body = el('div', { class: 'dlg' });

  if (tile.type === 'note') {
    body.appendChild(field(t('dlg.title'), textInput(tile.settings.heading, { oninput: (e) => { tile.settings.heading = e.target.value; } })));
    const area = el('textarea', { class: 'inp', rows: '4', oninput: (e) => { tile.settings.body = e.target.value; } });
    area.value = tile.settings.body || '';
    body.appendChild(field(t('dlg.text'), area));
  } else if (tile.type === 'weather-secondary') {
    body.appendChild(field(t('dlg.name'), textInput(tile.settings.name, { oninput: (e) => { tile.settings.name = e.target.value; } })));
    body.appendChild(field('Latitude', textInput(tile.settings.latitude, { type: 'number', step: '0.0001', oninput: (e) => { tile.settings.latitude = Number(e.target.value); } })));
    body.appendChild(field('Longitude', textInput(tile.settings.longitude, { type: 'number', step: '0.0001', oninput: (e) => { tile.settings.longitude = Number(e.target.value); } })));
  } else if (tile.type === 'weather-local') {
    body.appendChild(field(t('dlg.title'), textInput(tile.settings.label, { oninput: (e) => { tile.settings.label = e.target.value; } })));
  } else if (tile.type === 'georide') {
    body.appendChild(el('p', { class: 'fld-h', text: t('set.georide') }));
    body.appendChild(el('button', { class: 'btn ghost', type: 'button', text: t('set.title'), onclick: () => { closeDialog(); openSettings('georide'); } }));
  }

  body.appendChild(dialogFooter(() => {
    state.config.tiles[index] = tile;
    closeDialog();
    renderTiles();
    refreshData();
  }));
  openDialog({ title: t('edit.settings'), subtitle: state.tileTypes[tile.type]?.label ?? '', body });
}

/* --------------------------- links in edit mode -------------------------- */

export function decorateLinksForEditing() {
  const grid = id('links-grid');
  grid.querySelectorAll('[data-link]').forEach((node) => {
    const index = Number(node.dataset.link);
    node.dataset.index = index;
    node.classList.add('editable');
    // Captured, so that it still runs for a click on the buttons below, which
    // stop the event from bubbling up to the shortcut.
    if (node.tagName === 'A') node.addEventListener('click', (event) => event.preventDefault(), { capture: true });
    node.appendChild(el('div', { class: 'tile-edit' }, [
      el('button', { class: 'tinybtn', title: t('edit.settings'), html: svg('pencil-simple'), onclick: (e) => { e.stopPropagation(); openLinkDialog(index); } }),
      el('button', { class: 'tinybtn danger', title: t('edit.remove'), html: svg('trash'), onclick: (e) => { e.stopPropagation(); removeLink(index); } }),
    ]));
  });

  grid.appendChild(el('button', { class: 'app app-add', html: `${svg('plus', 'font-size:22px')}<span>${esc(t('edit.addLink'))}</span>`, onclick: () => addLink(false) }));
  grid.appendChild(el('button', { class: 'app app-add', html: `${svg('folder', 'font-size:22px')}<span>${esc(t('edit.addFolder'))}</span>`, onclick: () => addLink(true) }));

  makeArrangeable(grid, '.editable', {
    onReorder: (order) => {
      state.config.links = reorder(state.config.links, order);
      renderLinks();
    },
    // Folders hold shortcuts only: a folder is never nested in another one.
    canNest: (from, to) => !state.config.links[from]?.items && Boolean(state.config.links[to]?.items),
    onNest: (from, to) => {
      const folder = state.config.links[to];
      const [link] = state.config.links.splice(from, 1);
      placeLink(link, folder.id);
      renderLinks();
    },
  });
}

function addLink(isFolder) {
  const link = isFolder
    ? { id: uid('lnk'), title: 'Folder', color: '#0a84ff', icon: 'folder', items: [] }
    : { id: uid('lnk'), title: 'Shortcut', url: 'https://example.org/', color: '#0a84ff', icon: 'link' };
  state.config.links.push(link);
  renderLinks();
  openLinkDialog(state.config.links.length - 1, null, { isNew: true });
}

/** Put a shortcut in a folder, or back on the main grid when `folderId` is empty. */
function placeLink(link, folderId) {
  const folder = folderId ? state.config.links.find((entry) => entry.id === folderId && entry.items) : null;
  if (folder) folder.items.push({ ...link, id: uid('sub') });
  else state.config.links.push({ ...link, id: uid('lnk') });
  toast(t('edit.movedTo', { name: link.title, folder: folder ? folder.title : t('dlg.mainGrid') }));
}

/** The shortcut list a link lives in: the main grid, or one folder's items. */
const linkList = (folderIndex) => (folderIndex === null ? state.config.links : state.config.links[folderIndex].items);

function removeLink(index) {
  if (!confirm(t('edit.confirmRemove', { name: state.config.links[index].title }))) return;
  state.config.links.splice(index, 1);
  renderLinks();
}

function openLinkDialog(index, folderIndex = null, { draft: kept = null, isNew = false, destination: keptDestination } = {}) {
  const draft = kept ?? clone(linkList(folderIndex)[index]);
  const isFolder = Boolean(draft.items);
  const currentFolderId = folderIndex === null ? '' : state.config.links[folderIndex].id;
  let destination = keptDestination ?? currentFolderId;
  // A nested editor takes over the single dialog; it reopens this one on the
  // same draft when it closes, so nothing typed here is lost.
  const reopen = () => openLinkDialog(index, folderIndex, { draft, isNew, destination });

  const folders = state.config.links.filter((entry) => entry.items);
  const locationPicker = () => {
    const select = el('select', { class: 'inp', onchange: (e) => { destination = e.target.value; } }, [
      el('option', { value: '', text: t('dlg.mainGrid') }),
      ...folders.map((folder) => el('option', { value: folder.id, text: folder.title })),
    ]);
    select.value = destination;
    return select;
  };

  const body = el('div', { class: 'dlg' }, [
    field(t('dlg.title'), textInput(draft.title, { oninput: (e) => { draft.title = e.target.value; } })),
    isFolder ? null : field(t('dlg.url'), textInput(draft.url, { oninput: (e) => { draft.url = e.target.value; }, placeholder: 'https://' })),
    isFolder || folders.length === 0 ? null : field(t('dlg.location'), locationPicker()),
    field(t('dlg.colour'), colourPicker(draft.color, (colour) => { draft.color = colour; })),
    field(t('dlg.icon'), iconPicker(draft.icon, (icon) => { draft.icon = icon; })),
  ]);

  if (isFolder) {
    const list = el('div', { class: 'sub-list' });
    const renderSubList = () => {
      list.innerHTML = '';
      draft.items.forEach((item, i) => {
        list.appendChild(el('div', { class: 'sub-row' }, [
          el('span', { class: 'sub-ic', style: `background:${item.color}`, html: svg(item.icon) }),
          el('span', { class: 'sub-tt', text: item.title }),
          el('button', { class: 'tinybtn', type: 'button', html: svg('pencil-simple'), onclick: () => openSubItemDialog(draft, i, reopen) }),
          el('button', { class: 'tinybtn danger', type: 'button', html: svg('trash'), onclick: () => { draft.items.splice(i, 1); renderSubList(); } }),
        ]));
      });
      list.appendChild(el('button', { class: 'btn ghost', type: 'button', text: t('edit.addItem'), onclick: () => {
        draft.items.push({ id: uid('sub'), title: 'Link', url: 'https://example.org/', color: draft.color, icon: 'link' });
        openSubItemDialog(draft, draft.items.length - 1, reopen, { isNew: true });
      } }));
    };
    renderSubList();
    body.appendChild(field(t('apps.links', { n: draft.items.length }), list));
  }

  const done = () => {
    closeDialog();
    renderLinks();
    if (folderIndex !== null) openFolder(folderIndex);
  };
  const save = () => {
    if (destination === currentFolderId) {
      linkList(folderIndex)[index] = draft;
    } else {
      linkList(folderIndex).splice(index, 1);
      placeLink(draft, destination);
    }
    done();
  };
  // Cancelling a link that was just added takes its placeholder away again.
  const cancel = () => {
    if (isNew) linkList(folderIndex).splice(index, 1);
    done();
  };
  body.appendChild(dialogFooter(save, cancel));
  openDialog({ title: draft.title, subtitle: isFolder ? t('edit.addFolder') : t('edit.addLink'), body });
}

/** Nested editor for one link inside a folder, without leaving the folder dialog. */
function openSubItemDialog(folderDraft, itemIndex, onDone, { isNew = false } = {}) {
  const item = clone(folderDraft.items[itemIndex]);
  const body = el('div', { class: 'dlg' }, [
    field(t('dlg.title'), textInput(item.title, { oninput: (e) => { item.title = e.target.value; } })),
    field(t('dlg.url'), textInput(item.url, { oninput: (e) => { item.url = e.target.value; } })),
    field(t('dlg.colour'), colourPicker(item.color, (colour) => { item.color = colour; })),
    field(t('dlg.icon'), iconPicker(item.icon, (icon) => { item.icon = icon; })),
  ]);
  body.appendChild(dialogFooter(() => {
    folderDraft.items[itemIndex] = item;
    onDone();
  }, () => {
    if (isNew) folderDraft.items.splice(itemIndex, 1);
    onDone();
  }));
  openDialog({ title: item.title, body });
}

export function decorateFolderForEditing(folderIndex) {
  const grid = id('folder-links-grid');
  grid.querySelectorAll('[data-item]').forEach((node) => {
    const i = Number(node.dataset.item);
    node.dataset.index = i;
    node.classList.add('editable');
    node.addEventListener('click', (event) => event.preventDefault(), { capture: true });
    node.appendChild(el('div', { class: 'tile-edit' }, [
      el('button', { class: 'tinybtn', html: svg('pencil-simple'), onclick: (e) => { e.stopPropagation(); openLinkDialog(i, folderIndex); } }),
      el('button', { class: 'tinybtn danger', html: svg('trash'), onclick: (e) => { e.stopPropagation(); state.config.links[folderIndex].items.splice(i, 1); openFolder(folderIndex); renderLinks(); } }),
    ]));
  });
  grid.appendChild(el('button', { class: 'app app-add', html: `${svg('plus', 'font-size:22px')}<span>${esc(t('edit.addItem'))}</span>`, onclick: () => {
    const items = state.config.links[folderIndex].items;
    items.push({ id: uid('sub'), title: 'Link', url: 'https://example.org/', color: state.config.links[folderIndex].color, icon: 'link' });
    openFolder(folderIndex);
    renderLinks();
    openLinkDialog(items.length - 1, folderIndex, { isNew: true });
  } }));
  const folder = state.config.links[folderIndex];
  makeArrangeable(grid, '.editable', {
    onReorder: (order) => {
      folder.items = reorder(folder.items, order);
      openFolder(folderIndex);
      renderLinks();
    },
    // Released outside the folder, a link goes back to the main grid.
    bounds: () => grid.closest('.sheet').getBoundingClientRect(),
    onDropOutside: (from) => {
      const [link] = folder.items.splice(from, 1);
      placeLink(link, '');
      renderLinks();
      closeFolder();
    },
  });
}

/* ------------------------------ about & update --------------------------- */

const shortCommit = (sha) => (sha ? sha.slice(0, 7) : null);

/** Version, what GitHub has, and the button that asks for an update. */
function aboutPane() {
  const pane = el('div', { class: 'pane' });
  const body = el('div', { class: 'dlg' });
  pane.appendChild(body);
  const draw = (payload) => {
    body.innerHTML = '';
    const installed = payload?.installed ?? {};
    const latest = payload?.latest ?? null;
    const behind = Boolean(latest?.commit && installed.commit && latest.commit !== installed.commit);
    const unknown = !installed.commit;
    const running = payload?.status?.state === 'running';
    // Coming from another branch is not "being behind": it is a switch, and the
    // button says so rather than promising an update.
    const switching = Boolean(latest?.branch && installed.branch && latest.branch !== installed.branch);

    const line = (label, value, hint) => {
      const rows = [el('div', { class: 'fld-l', text: label }), el('div', { class: 'about-v', text: value })];
      if (hint) rows.push(el('p', { class: 'fld-h', text: hint }));
      return el('div', { class: 'about-row' }, rows);
    };

    body.appendChild(line(
      t('upd.installed'),
      installed.commit ? `${installed.version ?? ''} · ${shortCommit(installed.commit)}`.trim() : (installed.version ?? t('upd.unknown')),
      [
        installed.branch ? t('upd.fromBranch', { branch: installed.branch }) : null,
        installed.installedAt ? new Date(installed.installedAt).toLocaleString(state.config.site.locale) : null,
      ].filter(Boolean).join(' · ') || undefined
    ));

    // The channel picker comes before the version it points at, because it is
    // what the next two lines are talking about.
    if ((payload?.channels?.length ?? 0) > 1) {
      const picker = el('div', { class: 'seg' });
      payload.channels.forEach((channel) => {
        picker.appendChild(el('button', {
          class: `seg-btn${channel.id === payload.channel ? ' on' : ''}`,
          type: 'button',
          text: t(`upd.channel.${channel.id}`),
          disabled: running,
          onclick: async () => {
            if (channel.id === payload.channel) return;
            picker.querySelectorAll('button').forEach((button) => { button.disabled = true; });
            try {
              draw(await api('/api/update/channel', { method: 'POST', body: { channel: channel.id } }));
            } catch (error) {
              toast(error.message, 'error');
              loadAbout(draw, false);
            }
          },
        }));
      });
      body.appendChild(el('div', { class: 'about-row' }, [
        el('div', { class: 'fld-l', text: t('upd.channel') }),
        picker,
        el('p', { class: 'fld-h', text: t(`upd.channelHint.${payload.channel}`) }),
      ]));
    }

    body.appendChild(line(
      t('upd.latest'),
      latest ? `${shortCommit(latest.commit)}` : (payload?.error || t('upd.unknown')),
      [latest?.branch ? t('upd.onBranch', { branch: latest.branch }) : null, latest?.message].filter(Boolean).join(' · ') || undefined
    ));

    if (running) {
      body.appendChild(el('p', { class: 'fld-h', text: `${t('upd.running')} ${payload.status.step ?? ''}` }));
    } else if (payload?.status?.state === 'failed') {
      body.appendChild(el('p', { class: 'fld-h danger-text', text: t('upd.failed', { message: payload.status.message || '' }) }));
    } else if (!unknown && !behind && latest) {
      body.appendChild(el('p', { class: 'fld-h', text: t('upd.upToDate') }));
    }

    // Reachable on purpose, not only when it appears by itself after an
    // update: the one thing worse than a dialog nobody asked for is one you
    // cannot get back once you have dismissed it. It has nothing to do with
    // whether this instance updates itself, so it sits above that question.
    const news = el('button', { class: 'btn ghost', type: 'button', text: t('news.open'), onclick: openNewsHistory });

    if (!payload?.enabled) {
      body.appendChild(el('p', { class: 'fld-h', text: t('upd.disabled') }));
      body.appendChild(news);
      return;
    }
    const button = el('button', {
      class: `btn ${behind ? 'primary' : 'ghost'}`,
      type: 'button',
      text: running ? t('upd.updating')
        : switching ? t('upd.switchTo', { channel: t(`upd.channel.${payload.channel}`) })
          : t('upd.update'),
      // Nothing to install when the channel's branch could not be read: the
      // updater would only download a 404 and roll itself back.
      disabled: running || !latest,
      onclick: () => {
        if (!confirm(switching ? t('upd.confirmSwitch', { branch: latest.branch }) : t('upd.confirm'))) return;
        startUpdate(draw);
      },
    });
    body.appendChild(button);
    body.appendChild(el('button', { class: 'btn ghost', type: 'button', text: t('upd.check'), onclick: () => loadAbout(draw, true) }));
    body.appendChild(news);
  };

  loadAbout(draw, false);
  return pane;
}

async function loadAbout(draw, force) {
  try {
    draw(await api(`/api/update${force ? '?check=1' : ''}`));
  } catch (error) {
    draw({ enabled: false, error: error.message, installed: {}, status: { state: 'idle' } });
  }
}

/**
 * Ask for the update, then follow it. The server goes away when it restarts, so
 * a failing request is expected: keep polling until it answers again.
 */
async function startUpdate(draw) {
  try {
    await api('/api/update/start', { method: 'POST' });
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  toast(t('upd.running'));
  const deadline = Date.now() + 5 * 60_000;
  const poll = async () => {
    if (Date.now() > deadline) return;
    let payload = null;
    try {
      payload = await api('/api/update');
    } catch {
      setTimeout(poll, 2500); // the service is restarting
      return;
    }
    draw(payload);
    if (payload.status?.state === 'running') {
      setTimeout(poll, 2000);
      return;
    }
    if (payload.status?.state === 'done') {
      toast(t('upd.done'));
      setTimeout(() => window.location.reload(), 1500);
    } else if (payload.status?.state === 'failed') {
      toast(t('upd.failed', { message: payload.status.message || '' }), 'error');
    }
  };
  setTimeout(poll, 2000);
}


/* ------------------------------- accounts --------------------------------- */
/* Administrators only. The tab is not even built for anyone else, and the API
   refuses every route here regardless — the hidden tab is a convenience, not
   the control. */


/** "2 hours ago", or the date once that stops being useful. */
function sinceLabel(iso) {
  if (!iso) return t('adm.never');
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 2) return t('adm.justNow');
  if (minutes < 60) return t('adm.minutesAgo', { n: minutes });
  if (minutes < 1440) return t('adm.hoursAgo', { n: Math.round(minutes / 60) });
  if (minutes < 20160) return t('adm.daysAgo', { n: Math.round(minutes / 1440) });
  return new Date(iso).toLocaleDateString(state.config.site.locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "in 47 hours". The other direction, for a date that has not arrived yet:
 *  an invitation's expiry read through sinceLabel came out as "just now",
 *  because the difference it measures is negative for anything in the future. */
function untilLabel(iso) {
  const minutes = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (!Number.isFinite(minutes) || minutes <= 0) return t('adm.expired');
  if (minutes < 60) return t('adm.inMinutes', { n: minutes });
  if (minutes < 2880) return t('adm.inHours', { n: Math.round(minutes / 60) });
  return t('adm.inDays', { n: Math.round(minutes / 1440) });
}

function accountsPane() {
  const pane = el('div', { class: 'pane' });
  const list = el('div', { class: 'adm-list' });
  const invites = el('div', { class: 'adm-list' });
  const invitesTitle = el('div', { class: 'fld-l', text: t('adm.pending'), hidden: true });
  let data = null;

  const reload = async () => {
    try {
      data = await api('/api/admin/accounts');
      renderAccounts();
      renderInvitations();
    } catch (error) {
      list.innerHTML = '';
      list.appendChild(el('p', { class: 'fld-h', text: error.message }));
    }
  };

  const act = async (label, run) => {
    try {
      await run();
      toast(label);
      await reload();
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  function renderAccounts() {
    list.innerHTML = '';
    for (const account of data.accounts) {
      const isMe = account.id === data.me;
      const row = el('div', { class: `adm-row${isMe ? ' me' : ''}` });

      const who = el('div', { class: 'adm-who' }, [
        el('div', { class: 'adm-name' }, [
          el('span', { text: account.username }),
          account.role === 'admin' ? el('span', { class: 'adm-badge', text: t('adm.roleAdmin') }) : null,
          isMe ? el('span', { class: 'adm-badge you', text: t('adm.you') }) : null,
        ]),
        el('div', { class: 'adm-meta', text: [
          account.email || t('adm.noEmail'),
          account.enrolled ? t('adm.seen', { when: sinceLabel(account.lastSeenAt) }) : t('adm.neverSignedIn'),
          account.openSessions > 0 ? t('adm.openSessions', { n: account.openSessions }) : '',
        ].filter(Boolean).join(' · ') }),
      ]);

      const actions = el('div', { class: 'adm-actions' });
      const roleSelect = el('select', {
        class: 'inp small',
        onchange: (event) => act(t('msg.saved'), () =>
          api(`/api/admin/accounts/${account.id}`, { method: 'PATCH', body: { role: event.target.value } })),
      }, [
        el('option', { value: 'user', text: t('adm.roleUser') }),
        el('option', { value: 'admin', text: t('adm.roleAdmin') }),
      ]);
      roleSelect.value = account.role;
      actions.appendChild(roleSelect);

      if (account.openSessions > 0) {
        actions.appendChild(el('button', {
          class: 'btn ghost small', type: 'button', text: t('adm.signOut'),
          onclick: () => act(t('adm.signedOut'), () =>
            api(`/api/admin/accounts/${account.id}/sign-out`, { method: 'POST', body: {} })),
        }));
      }
      if (!isMe) {
        actions.appendChild(el('button', {
          class: 'btn danger small', type: 'button', text: t('adm.delete'),
          // Deleting takes the dashboard, the credentials and the parcels with
          // it, so it asks — once, plainly, naming what goes.
          onclick: () => {
            if (!window.confirm(t('adm.deleteConfirm', { name: account.username }))) return;
            act(t('adm.deleted'), () => api(`/api/admin/accounts/${account.id}`, { method: 'DELETE' }));
          },
        }));
      }

      row.append(who, actions);
      list.appendChild(row);
    }
  }

  function renderInvitations() {
    invites.innerHTML = '';
    invitesTitle.hidden = data.invitations.length === 0;
    for (const invitation of data.invitations) {
      invites.appendChild(el('div', { class: 'adm-row' }, [
        el('div', { class: 'adm-who' }, [
          el('div', { class: 'adm-name' }, [
            el('span', { text: invitation.username || invitation.email || t('adm.anyone') }),
            invitation.role === 'admin' ? el('span', { class: 'adm-badge', text: t('adm.roleAdmin') }) : null,
          ]),
          el('div', { class: 'adm-meta', text: [
            invitation.sentTo ? t('adm.sentTo', { email: invitation.sentTo }) : t('adm.linkOnly'),
            t('adm.expires', { when: untilLabel(invitation.expiresAt) }),
          ].join(' · ') }),
        ]),
        el('div', { class: 'adm-actions' }, [
          el('button', {
            class: 'btn ghost small', type: 'button', text: t('adm.revoke'),
            onclick: () => act(t('adm.revoked'), () =>
              api(`/api/admin/invitations/${invitation.id}`, { method: 'DELETE' })),
          }),
        ]),
      ]));
    }
  }

  pane.appendChild(el('p', { class: 'fld-h', text: t('adm.intro') }));
  pane.appendChild(list);

  /* ---- create an account outright ---- */
  pane.appendChild(el('div', { class: 'divider' }));
  pane.appendChild(el('div', { class: 'fld-l', text: t('adm.addTitle') }));
  pane.appendChild(el('p', { class: 'fld-h', text: t('adm.addHint') }));
  const newName = textInput('', { placeholder: t('auth.username'), autocomplete: 'off' });
  const newPassword = textInput('', { type: 'password', placeholder: t('auth.password'), autocomplete: 'new-password' });
  const newRole = el('select', { class: 'inp' }, [
    el('option', { value: 'user', text: t('adm.roleUser') }),
    el('option', { value: 'admin', text: t('adm.roleAdmin') }),
  ]);
  pane.appendChild(el('div', { class: 'adm-form' }, [newName, newPassword, newRole,
    el('button', {
      class: 'btn primary', type: 'button', text: t('adm.add'),
      onclick: () => act(t('adm.added'), async () => {
        await api('/api/admin/accounts', { method: 'POST', body: {
          username: newName.value, password: newPassword.value, role: newRole.value,
        } });
        newName.value = '';
        newPassword.value = '';
      }),
    })]));

  /* ---- or invite ---- */
  pane.appendChild(el('div', { class: 'divider' }));
  pane.appendChild(el('div', { class: 'fld-l', text: t('adm.inviteTitle') }));
  pane.appendChild(el('p', { class: 'fld-h', text: t('adm.inviteHint') }));
  const inviteName = textInput('', { placeholder: t('adm.inviteNamePlaceholder'), autocomplete: 'off' });
  const inviteEmail = textInput('', { type: 'email', placeholder: t('adm.inviteEmailPlaceholder'), autocomplete: 'off' });
  const inviteRole = el('select', { class: 'inp' }, [
    el('option', { value: 'user', text: t('adm.roleUser') }),
    el('option', { value: 'admin', text: t('adm.roleAdmin') }),
  ]);
  // The link is shown whatever happened to the mail, because it is the thing
  // that actually works: an instance with no mail server is a normal instance.
  const linkBox = el('div', { class: 'adm-link', hidden: true });
  pane.appendChild(el('div', { class: 'adm-form' }, [inviteName, inviteEmail, inviteRole,
    el('button', {
      class: 'btn primary', type: 'button', text: t('adm.invite'),
      onclick: async () => {
        try {
          const result = await api('/api/admin/invitations', { method: 'POST', body: {
            username: inviteName.value, email: inviteEmail.value, role: inviteRole.value,
          } });
          inviteName.value = '';
          inviteEmail.value = '';
          linkBox.hidden = false;
          linkBox.innerHTML = '';
          linkBox.append(
            el('div', { class: 'fld-l', text: result.sent ? t('adm.inviteSent') : t('adm.inviteReady') }),
            el('code', { text: result.link }),
            el('button', {
              class: 'btn ghost small', type: 'button', text: t('adm.copyLink'),
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(result.link);
                  toast(t('msg.copied'));
                } catch {
                  toast(t('msg.copyFailed'), 'error');
                }
              },
            }),
            result.mailError ? el('p', { class: 'fld-h', text: t('adm.inviteMailFailed', { error: result.mailError }) }) : null
          );
          data = { ...data, invitations: result.invitations };
          renderInvitations();
        } catch (error) {
          toast(error.message, 'error');
        }
      },
    })]));
  pane.appendChild(linkBox);
  pane.appendChild(invitesTitle);
  pane.appendChild(invites);

  reload();
  return pane;
}

/* ---------------------------------- SMTP ---------------------------------- */

function smtpPane() {
  const pane = el('div', { class: 'pane' });
  pane.appendChild(el('p', { class: 'fld-h', text: t('smtp.intro') }));

  const host = textInput('', { placeholder: 'smtp.example.org', autocomplete: 'off' });
  const port = textInput('', { type: 'number', min: 1, max: 65535 });
  const security = el('select', { class: 'inp' }, [
    el('option', { value: 'starttls', text: t('smtp.starttls') }),
    el('option', { value: 'tls', text: t('smtp.tls') }),
    el('option', { value: 'none', text: t('smtp.none') }),
  ]);
  const user = textInput('', { autocomplete: 'off' });
  const password = textInput('', { type: 'password', autocomplete: 'new-password' });
  const from = textInput('', { type: 'email', placeholder: 'glassboard@example.org', autocomplete: 'off' });
  const fromName = textInput('', { autocomplete: 'off' });
  const status = el('div', { class: 'status', text: '…' });

  pane.appendChild(status);
  pane.appendChild(field(t('smtp.host'), host));
  pane.appendChild(field(t('smtp.port'), port));
  pane.appendChild(field(t('smtp.security'), security, t('smtp.securityHint')));
  pane.appendChild(field(t('smtp.user'), user));
  pane.appendChild(field(t('smtp.password'), password, t('smtp.passwordHint')));
  pane.appendChild(field(t('smtp.from'), from, t('smtp.fromHint')));
  pane.appendChild(field(t('smtp.fromName'), fromName));

  const testTo = textInput('', { type: 'email', placeholder: t('smtp.testToPlaceholder'), autocomplete: 'off' });
  pane.appendChild(el('div', { class: 'divider' }));
  pane.appendChild(field(t('smtp.testTo'), testTo, t('smtp.testHint')));

  /** What is on screen, so a test says whether these settings work — not
   *  whether the saved ones do. An untouched password field means "keep the
   *  stored one", which is why it is only sent when it has something in it. */
  const onScreen = () => ({
    host: host.value.trim(),
    port: Number(port.value) || 587,
    security: security.value,
    user: user.value.trim(),
    from: from.value.trim(),
    fromName: fromName.value.trim(),
    ...(password.value ? { password: password.value } : {}),
  });

  const row = el('div', { class: 'row' }, [
    el('button', {
      class: 'btn ghost', type: 'button', text: t('smtp.test'),
      onclick: async (event) => {
        const button = event.currentTarget;
        const label = button.textContent;
        button.disabled = true;
        button.textContent = t('smtp.testing');
        try {
          const result = await api('/api/admin/smtp/test', {
            method: 'POST', body: { ...onScreen(), ...(testTo.value.trim() ? { to: testTo.value.trim() } : {}) },
          });
          status.classList.remove('danger-text');
          status.textContent = result.sent ? t('smtp.testSent') : t('smtp.testOk');
          toast(result.sent ? t('smtp.testSent') : t('smtp.testOk'));
        } catch (error) {
          // A toast is the wrong place for an instruction: it is gone before
          // it has been acted on. The advice stays in the panel, next to the
          // field it is about.
          status.classList.add('danger-text');
          status.textContent = error.code === 'app_password' ? t('smtp.appPassword') : error.message;
          toast(error.message, 'error');
        } finally {
          button.disabled = false;
          button.textContent = label;
        }
      },
    }),
    el('button', {
      class: 'btn primary', type: 'button', text: t('set.save'),
      onclick: async () => {
        try {
          await api('/api/admin/smtp', { method: 'PUT', body: onScreen() });
          password.value = '';
          toast(t('msg.saved'));
          load();
        } catch (error) {
          toast(error.message, 'error');
        }
      },
    }),
  ]);
  pane.appendChild(row);

  async function load() {
    try {
      const { smtp } = await api('/api/admin/smtp');
      host.value = smtp.host;
      port.value = smtp.port;
      security.value = smtp.security;
      user.value = smtp.user;
      from.value = smtp.from;
      fromName.value = smtp.fromName;
      status.textContent = smtp.hasPassword ? t('smtp.hasPassword') : t('smtp.noPassword');
    } catch (error) {
      status.textContent = error.message;
    }
  }
  load();
  return pane;
}

/* -------------------------------- settings ------------------------------- */

export async function openSettings(section = 'general') {
  const draft = clone(state.config);
  const body = el('div', { class: 'dlg' });
  const tabs = el('div', { class: 'tabs' });
  const panes = el('div', { class: 'panes' });

  const sections = {
    general: () => generalPane(draft),
    appearance: () => appearancePane(draft),
    weather: () => weatherPane(draft),
    georide: () => georidePane(draft),
    parcels: () => parcelsPane(draft),
    account: () => accountPane(),
    data: () => dataPane(),
    about: () => aboutPane(),
  };
  const labels = {
    general: t('set.general'), appearance: t('set.appearance'), weather: t('set.weather'),
    georide: t('set.georide'), parcels: t('set.parcels'), account: t('set.account'), data: t('set.data'),
    about: t('set.about'),
  };

  /* The two administration tabs exist only for an administrator. Hiding them
     is a courtesy to everyone else, not the control: every route behind them
     refuses a standard account on its own. */
  if (state.me?.admin) {
    sections.accounts = () => accountsPane();
    sections.smtp = () => smtpPane();
    labels.accounts = t('adm.tab');
    labels.smtp = t('smtp.tab');
  }

  const show = (name) => {
    panes.innerHTML = '';
    panes.appendChild(sections[name]());
    hydrateIcons(panes);
    tabs.querySelectorAll('button').forEach((button) => button.classList.toggle('on', button.dataset.tab === name));
  };
  Object.keys(sections).forEach((name) => {
    tabs.appendChild(el('button', { class: 'tab', type: 'button', 'data-tab': name, text: labels[name], onclick: () => show(name) }));
  });

  body.appendChild(tabs);
  body.appendChild(panes);
  body.appendChild(dialogFooter(async () => {
    try {
      const payload = await api('/api/config', { method: 'PUT', body: { config: draft, note: 'settings updated' } });
      state.config = payload.config;
      state.saved = clone(payload.config);
      closeDialog();
      renderAll();
      refreshData();
      toast(t('msg.saved'));
    } catch (error) {
      toast(error.details?.length ? `${error.message}: ${error.details[0]}` : error.message, 'error');
    }
  }, () => { closeDialog(); applyAppearance(); }));

  openDialog({ title: t('set.title'), body });
  show(section);
}

function generalPane(draft) {
  const pane = el('div', { class: 'pane' });
  pane.appendChild(field(t('set.siteTitle'), textInput(draft.site.title, { oninput: (e) => { draft.site.title = e.target.value; } })));
  pane.appendChild(field(t('set.siteSubtitle'), textInput(draft.site.subtitle, { oninput: (e) => { draft.site.subtitle = e.target.value; } })));
  pane.appendChild(field(t('set.greeting'), textInput(draft.site.greeting, { oninput: (e) => { draft.site.greeting = e.target.value; } })));
  pane.appendChild(field(t('set.sectionTitle'), textInput(draft.site.sectionTitle, { oninput: (e) => { draft.site.sectionTitle = e.target.value; } })));

  const locale = el('select', { class: 'inp', onchange: (e) => { draft.site.locale = e.target.value; } });
  availableLocales().forEach((code) => {
    const option = el('option', { value: code, text: localeName(code) });
    if (code === draft.site.locale) option.selected = true;
    locale.appendChild(option);
  });
  pane.appendChild(field(t('set.locale'), locale));
  pane.appendChild(field(t('set.clockLabel'), textInput(draft.site.clockLabel, { oninput: (e) => { draft.site.clockLabel = e.target.value; } })));
  pane.appendChild(field(t('set.clockTz'), textInput(draft.site.clockTimezone, { oninput: (e) => { draft.site.clockTimezone = e.target.value; } }), 'Europe/Paris, UTC, America/New_York…'));
  pane.appendChild(checkbox(t('set.searchEnabled'), draft.search.enabled, (value) => { draft.search.enabled = value; }));
  pane.appendChild(field(t('set.searchAction'), textInput(draft.search.action, { oninput: (e) => { draft.search.action = e.target.value; } })));
  pane.appendChild(field(t('set.searchParam'), textInput(draft.search.param, { oninput: (e) => { draft.search.param = e.target.value; } })));
  pane.appendChild(checkbox(t('set.searchNewTab'), draft.search.newTab !== false, (value) => { draft.search.newTab = value; }));
  return pane;
}

function appearancePane(draft) {
  const appearance = draft.appearance;
  const wallpaper = appearance.wallpaper;
  const pane = el('div', { class: 'pane' });
  // Everything on this pane previews live, so the choice can be judged on the
  // real dashboard rather than on a swatch.
  const preview = () => applyAppearance(appearance, state.wallpaperVersion);
  const previewFaded = () => withTransition(preview);

  const themes = el('div', { class: 'themes' });
  const paint = () => themes.querySelectorAll('.theme').forEach((b) => b.classList.toggle('on', b.dataset.preset === appearance.preset));
  Object.entries(state.themePresets).forEach(([key, meta]) => {
    themes.appendChild(el('button', {
      class: 'theme', type: 'button', 'data-preset': key,
      html: `<span class="theme-dots">${meta.swatch.map((c) => `<i style="background:${c}"></i>`).join('')}</span><span>${esc(meta.label)}</span>`,
      onclick: () => { appearance.preset = key; paint(); previewFaded(); },
    }));
  });
  paint();
  pane.appendChild(field(t('set.theme'), themes));
  pane.appendChild(el('button', {
    class: 'btn ghost', type: 'button',
    html: `${svg('shuffle')}<span>${esc(t('menu.shuffle'))}</span>`,
    onclick: () => {
      const options = Object.keys(state.themePresets).filter((key) => key !== appearance.preset);
      if (options.length === 0) return;
      appearance.preset = options[Math.floor(Math.random() * options.length)];
      paint();
      previewFaded();
    },
  }));
  pane.appendChild(checkbox(t('set.orbs'), appearance.orbs !== false, (value) => { appearance.orbs = value; preview(); }));

  pane.appendChild(el('div', { class: 'divider' }));
  pane.appendChild(el('div', { class: 'fld-l', text: t('set.wallpaper') }));

  const status = el('div', { class: 'status', text: t('set.wallpaperNone') });
  const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
  const pick = el('button', { class: 'btn ghost', type: 'button', text: t('set.wallpaperUpload'), onclick: () => file.click() });
  const drop = el('button', { class: 'btn ghost', type: 'button', text: t('set.wallpaperRemove'), onclick: async () => {
    await api('/api/appearance/wallpaper', { method: 'DELETE' });
    wallpaper.enabled = false;
    state.wallpaperVersion = '';
    status.textContent = t('set.wallpaperNone');
    preview();
  } });

  file.addEventListener('change', async () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    pick.disabled = true;
    try {
      // Raw bytes: no multipart parser to pull in for a single file.
      const response = await fetch('/api/appearance/wallpaper', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': chosen.type || 'application/octet-stream' },
        body: chosen,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      state.wallpaperVersion = payload.updatedAt || String(Date.now());
      wallpaper.enabled = true;
      enabled.querySelector('input').checked = true;
      status.textContent = `${chosen.name} — ${Math.round(payload.bytes / 1024)} KB`;
      preview();
      toast(t('msg.wallpaperSaved'));
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      pick.disabled = false;
      file.value = '';
    }
  });

  const enabled = checkbox(t('set.wallpaperEnabled'), wallpaper.enabled, (value) => { wallpaper.enabled = value; preview(); });
  pane.appendChild(status);
  pane.appendChild(el('div', { class: 'row' }, [pick, drop, file]));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.wallpaperHint') }));
  pane.appendChild(enabled);
  pane.appendChild(field(t('set.wallpaperDim'), slider(wallpaper.dim ?? 0.4, 0, 0.9, 0.05, (value) => { wallpaper.dim = value; preview(); })));
  pane.appendChild(field(t('set.wallpaperBlur'), slider(wallpaper.blur ?? 0, 0, 24, 1, (value) => { wallpaper.blur = value; preview(); })));

  api('/api/appearance/wallpaper/info')
    .then((info) => {
      if (!info.wallpaper) return;
      state.wallpaperVersion = info.wallpaper.updatedAt || '';
      status.textContent = `${info.wallpaper.mime} — ${Math.round(info.wallpaper.bytes / 1024)} KB`;
    })
    .catch(() => {});

  return pane;
}

function weatherPane(draft) {
  const weather = draft.integrations.weather;
  const pane = el('div', { class: 'pane' });
  pane.appendChild(checkbox(t('set.weatherEnabled'), weather.enabled, (value) => { weather.enabled = value; }));
  pane.appendChild(checkbox(t('set.useGeo'), weather.useBrowserGeolocation, (value) => { weather.useBrowserGeolocation = value; }));
  pane.appendChild(checkbox(t('set.reverse'), weather.reverseGeocoding, (value) => { weather.reverseGeocoding = value; }));
  pane.appendChild(field(t('set.fallbackLat'), textInput(weather.fallback.latitude, { type: 'number', step: '0.0001', oninput: (e) => { weather.fallback.latitude = Number(e.target.value); } })));
  pane.appendChild(field(t('set.fallbackLon'), textInput(weather.fallback.longitude, { type: 'number', step: '0.0001', oninput: (e) => { weather.fallback.longitude = Number(e.target.value); } })));
  pane.appendChild(field(t('set.refresh'), textInput(weather.refreshMinutes, { type: 'number', min: '5', max: '720', oninput: (e) => { weather.refreshMinutes = Number(e.target.value); } })));
  return pane;
}

function georidePane(draft) {
  const georide = draft.integrations.georide;
  const pane = el('div', { class: 'pane' });
  const status = el('div', { class: 'status', text: '…' });
  pane.appendChild(status);

  const trackerSelect = el('select', { class: 'inp', onchange: (e) => {
    georide.trackerId = e.target.value ? Number(e.target.value) : null;
    georide.trackerName = e.target.selectedOptions[0]?.dataset.name || '';
  } });

  const fillTrackers = (trackers) => {
    trackerSelect.innerHTML = '';
    trackers.forEach((tracker) => {
      const option = el('option', { value: tracker.trackerId, text: `${tracker.trackerName} (#${tracker.trackerId})`, 'data-name': tracker.trackerName });
      if (Number(georide.trackerId) === Number(tracker.trackerId)) option.selected = true;
      trackerSelect.appendChild(option);
    });
    if (!georide.trackerId && trackers[0]) {
      georide.trackerId = trackers[0].trackerId;
      georide.trackerName = trackers[0].trackerName;
    }
  };

  const email = textInput('', { type: 'email', placeholder: 'you@example.org' });
  const password = textInput('', { type: 'password' });
  const connect = el('button', { class: 'btn primary', type: 'button', text: t('set.georideConnect'), onclick: async () => {
    connect.disabled = true;
    try {
      const result = await api('/api/integrations/georide/login', { method: 'POST', body: { email: email.value, password: password.value } });
      fillTrackers(result.trackers);
      georide.enabled = true;
      status.textContent = t('set.georideConnected', { email: email.value });
      password.value = '';
      toast(t('msg.saved'));
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      connect.disabled = false;
    }
  } });
  const disconnect = el('button', { class: 'btn ghost', type: 'button', text: t('set.georideDisconnect'), onclick: async () => {
    await api('/api/integrations/georide/logout', { method: 'POST' });
    georide.enabled = false;
    status.textContent = t('gr.notConfigured');
    toast(t('msg.saved'));
  } });

  pane.appendChild(checkbox(t('set.georideEnabled'), georide.enabled, (value) => { georide.enabled = value; }));
  pane.appendChild(field(t('set.georideEmail'), email));
  pane.appendChild(field(t('set.georidePassword'), password));
  pane.appendChild(el('div', { class: 'row' }, [connect, disconnect]));
  pane.appendChild(field(t('set.georideTracker'), trackerSelect));
  pane.appendChild(field(t('set.periodDays'), textInput(georide.periodDays, { type: 'number', min: '1', max: '31', oninput: (e) => { georide.periodDays = Number(e.target.value); } })));
  pane.appendChild(field(t('set.refresh'), textInput(georide.refreshMinutes, { type: 'number', min: '1', max: '720', oninput: (e) => { georide.refreshMinutes = Number(e.target.value); } })));
  pane.appendChild(checkbox(t('set.georideMap'), georide.showMap, (value) => { georide.showMap = value; }));

  api('/api/integrations/georide/status')
    .then(async (result) => {
      status.textContent = result.configured ? t('set.georideConnected', { email: result.email || '—' }) : t('gr.notConfigured');
      if (result.configured) {
        try { fillTrackers((await api('/api/integrations/georide/trackers')).trackers); } catch { /* offline */ }
      }
    })
    .catch(() => { status.textContent = t('gr.unavailable'); });

  return pane;
}

function parcelsPane(draft) {
  const parcels = draft.integrations.parcels;
  const pane = el('div', { class: 'pane' });
  const status = el('div', { class: 'status', text: '…' });
  pane.appendChild(status);

  const key = textInput('', { type: 'password', placeholder: '••••••••••••', autocomplete: 'off' });
  const save = el('button', { class: 'btn primary', type: 'button', text: t('set.parcelsSaveKey'), onclick: async () => {
    save.disabled = true;
    try {
      await api('/api/integrations/parcels/key', { method: 'PUT', body: { apiKey: key.value } });
      key.value = '';
      parcels.enabled = true;
      await showStatus();
      toast(t('msg.saved'));
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      save.disabled = false;
    }
  } });
  const forget = el('button', { class: 'btn ghost', type: 'button', text: t('set.parcelsForgetKey'), onclick: async () => {
    await api('/api/integrations/parcels/key', { method: 'DELETE' });
    await showStatus();
    toast(t('msg.saved'));
  } });

  // The remaining allowance matters here: with this provider a unit is spent
  // when a parcel is added, never when its status is read.
  async function showStatus() {
    try {
      const result = await api('/api/integrations/parcels/status');
      if (!result.hasKey) {
        status.textContent = t('set.parcelsNoKey');
      } else if (result.quota) {
        status.textContent = t('set.parcelsQuota', { remaining: result.quota.remaining, total: result.quota.total });
      } else {
        status.textContent = result.error || t('set.parcelsConnected');
      }
    } catch (error) {
      status.textContent = error.message;
    }
  }

  pane.appendChild(checkbox(t('set.parcelsEnabled'), parcels.enabled, (value) => { parcels.enabled = value; }));
  pane.appendChild(field(t('set.parcelsKey'), key, t('set.parcelsKeyHint')));
  pane.appendChild(el('div', { class: 'row' }, [save, forget]));
  pane.appendChild(field(t('set.refresh'), textInput(parcels.refreshMinutes, { type: 'number', min: '15', max: '1440', oninput: (e) => { parcels.refreshMinutes = Number(e.target.value); } }), t('set.parcelsRefreshHint')));
  pane.appendChild(field(t('set.parcelsHideAfter'), textInput(parcels.hideDeliveredAfterDays, { type: 'number', min: '0', max: '30', oninput: (e) => { parcels.hideDeliveredAfterDays = Number(e.target.value); } }), t('set.parcelsHideAfterHint')));
  pane.appendChild(field(t('set.parcelsMaxOnTile'), textInput(parcels.maxOnTile, { type: 'number', min: '1', max: '10', oninput: (e) => { parcels.maxOnTile = Number(e.target.value); } })));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.parcelsManualHint') }));

  /* -------------------------- the mailbox scan -------------------------- */

  const mail = parcels.mail;
  pane.appendChild(el('h4', { class: 'pane-title', text: t('set.mailTitle') }));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.mailIntro') }));

  const mailStatus = el('div', { class: 'status', text: '…' });
  pane.appendChild(mailStatus);

  const mailPassword = textInput('', { type: 'password', placeholder: '••••••••••••', autocomplete: 'off' });
  const saveMail = el('button', { class: 'btn primary', type: 'button', text: t('set.mailSave'), onclick: async () => {
    saveMail.disabled = true;
    try {
      await api('/api/integrations/parcels/mail/password', { method: 'PUT', body: { password: mailPassword.value } });
      mailPassword.value = '';
      mail.enabled = true;
      await showMailStatus();
      toast(t('msg.saved'));
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      saveMail.disabled = false;
    }
  } });
  const forgetMail = el('button', { class: 'btn ghost', type: 'button', text: t('set.mailForget'), onclick: async () => {
    await api('/api/integrations/parcels/mail/password', { method: 'DELETE' });
    mail.enabled = false;
    await showMailStatus();
    toast(t('msg.saved'));
  } });
  // Saving the whole settings dialog is not needed to find out whether the
  // credentials work: the test signs in and hangs up, and says what failed.
  const testMail = el('button', { class: 'btn ghost', type: 'button', text: t('set.mailTest'), onclick: async () => {
    testMail.disabled = true;
    mailStatus.textContent = t('set.mailTesting');
    try {
      const result = await api('/api/integrations/parcels/mail/test', { method: 'POST' });
      mailStatus.textContent = t('set.mailWorks', { n: result.recent });
    } catch (error) {
      mailStatus.textContent = error.message;
    } finally {
      testMail.disabled = false;
    }
  } });

  async function showMailStatus() {
    try {
      const result = await api('/api/integrations/parcels/status');
      if (!result.mail?.configured) {
        mailStatus.textContent = t('set.mailNoPassword');
      } else if (result.mail.lastScan) {
        mailStatus.textContent = t('set.mailLastScan', {
          when: new Date(result.mail.lastScan).toLocaleString(state.config.site.locale),
          n: result.mail.pending,
        });
      } else {
        mailStatus.textContent = t('set.mailNeverScanned');
      }
    } catch (error) {
      mailStatus.textContent = error.message;
    }
  }

  pane.appendChild(checkbox(t('set.mailEnabled'), mail.enabled, (value) => { mail.enabled = value; }));
  pane.appendChild(field(t('set.mailAddress'), textInput(mail.user, { type: 'email', placeholder: 'you@gmail.com', oninput: (e) => { mail.user = e.target.value.trim(); } })));
  pane.appendChild(field(t('set.mailPassword'), mailPassword, t('set.mailPasswordHint')));
  pane.appendChild(el('div', { class: 'row' }, [saveMail, forgetMail, testMail]));
  pane.appendChild(field(t('set.mailHost'), textInput(mail.host, { oninput: (e) => { mail.host = e.target.value.trim(); } })));
  pane.appendChild(field(t('set.mailPort'), textInput(mail.port, { type: 'number', min: '1', max: '65535', oninput: (e) => { mail.port = Number(e.target.value); } })));
  pane.appendChild(field(t('set.mailSenders'), textInput(mail.senders, { placeholder: '@colissimo.fr, @amazon.fr', oninput: (e) => { mail.senders = e.target.value; } }), t('set.mailSendersHint')));
  pane.appendChild(field(t('set.mailSinceDays'), textInput(mail.sinceDays, { type: 'number', min: '1', max: '60', oninput: (e) => { mail.sinceDays = Number(e.target.value); } }), t('set.mailSinceDaysHint')));
  pane.appendChild(field(t('set.mailScanHours'), textInput(mail.scanHours, { type: 'number', min: '1', max: '48', oninput: (e) => { mail.scanHours = Number(e.target.value); } })));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.mailPrivacy') }));

  showStatus();
  showMailStatus();
  return pane;
}

function accountPane() {
  const pane = el('div', { class: 'pane' });
  const status = el('div', { class: 'status', text: '…' });
  pane.appendChild(status);

  const current = textInput('', { type: 'password' });
  const next = textInput('', { type: 'password' });
  pane.appendChild(field(t('set.currentPassword'), current));
  pane.appendChild(field(t('set.newPassword'), next));
  pane.appendChild(el('button', { class: 'btn primary', type: 'button', text: t('set.changePassword'), onclick: async () => {
    try {
      await api('/api/auth/password', { method: 'POST', body: { currentPassword: current.value, newPassword: next.value } });
      current.value = '';
      next.value = '';
      toast(t('msg.saved'));
    } catch (error) {
      toast(error.message, 'error');
    }
  } }));

  const codesBox = el('div', { class: 'codes', hidden: true });
  const regenPassword = textInput('', { type: 'password', placeholder: t('set.currentPassword') });
  pane.appendChild(el('div', { class: 'divider' }));
  pane.appendChild(el('div', { class: 'fld-l', text: t('set.recoveryCodes') }));
  pane.appendChild(regenPassword);
  pane.appendChild(el('button', { class: 'btn ghost', type: 'button', text: t('set.regenerate'), onclick: async () => {
    try {
      const result = await api('/api/auth/recovery-codes', { method: 'POST', body: { password: regenPassword.value } });
      regenPassword.value = '';
      codesBox.hidden = false;
      codesBox.innerHTML = result.recoveryCodes.map((code) => `<code>${esc(code)}</code>`).join('');
    } catch (error) {
      toast(error.message, 'error');
    }
  } }));
  pane.appendChild(codesBox);

  pane.appendChild(el('div', { class: 'divider' }));
  pane.appendChild(el('div', { class: 'fld-l', text: t('set.sessions') }));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.sessionsHint') }));
  const sessions = el('div', { class: 'sess-list' });
  pane.appendChild(sessions);
  loadSessions(sessions);

  api('/api/auth/me').then((me) => {
    status.textContent = `${t('set.signedInAs', { name: me.username })} — ${t('set.recoveryLeft', { n: me.recoveryCodesLeft })}`;
  }).catch(() => { status.textContent = ''; });

  return pane;
}

/** Which devices hold a session, and the means to end any of them.
 *  A user agent is chosen by the device that sent it, so it is only ever read
 *  into a text node, never into markup. */
function loadSessions(container) {
  container.innerHTML = '';
  api('/api/auth/sessions').then(({ sessions }) => {
    container.innerHTML = '';
    if (sessions.length <= 1) {
      container.appendChild(el('p', { class: 'fld-h', text: t('set.sessionsEmpty') }));
    }
    for (const session of sessions) {
      const when = session.lastSeenAt
        ? t('set.sessionLastSeen', {
          when: new Date(session.lastSeenAt).toLocaleString(state.config.site.locale, {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
          }),
        })
        : t('set.sessionNever');
      const how = session.origin === 'qr' ? t('set.sessionQr') : t('set.sessionPassword');
      const row = el('div', { class: 'sess', title: session.userAgent || '' }, [
        el('div', { class: 'sess-main' }, [
          el('div', { class: 't', text: describeAgent(session.userAgent) }),
          el('div', { class: 's', text: `${when} — ${how}` }),
        ]),
        session.current
          ? el('span', { class: 'sess-now', text: t('set.sessionCurrent') })
          : el('button', {
            class: 'btn ghost', type: 'button', text: t('set.sessionRevoke'),
            onclick: async () => {
              try {
                await api(`/api/auth/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
                toast(t('set.sessionRevoked'));
                loadSessions(container);
              } catch (error) {
                toast(error.message, 'error');
              }
            },
          }),
      ]);
      container.appendChild(row);
    }
  }).catch(() => { container.innerHTML = ''; });
}

/* A label for a user agent string. Read, never trusted: the raw value goes in
   the tooltip, as a text attribute, so a crafted one cannot pose as a name. */
function describeAgent(agent) {
  const ua = String(agent || '');
  if (!ua) return t('qr.unknownDevice');
  const browser = [
    [/\bEdg\//, 'Edge'], [/\bOPR\//, 'Opera'], [/\bFirefox\//, 'Firefox'],
    [/\bChrome\//, 'Chrome'], [/\bSafari\//, 'Safari'],
  ].find(([re]) => re.test(ua))?.[1];
  const system = [
    [/\bWindows\b/, 'Windows'], [/\b(iPhone|iPad|iPod)\b/, 'iOS'], [/\bMac OS X\b/, 'macOS'],
    [/\bAndroid\b/, 'Android'], [/\bLinux\b/, 'Linux'],
  ].find(([re]) => re.test(ua))?.[1];
  if (browser && system) return t('qr.agentOn', { browser, system });
  return browser || system || t('qr.unknownDevice');
}

function dataPane() {
  const pane = el('div', { class: 'pane' });
  pane.appendChild(el('button', { class: 'btn primary', type: 'button', text: t('set.exportPlain'), onclick: () => downloadExport(false) }));
  pane.appendChild(el('button', { class: 'btn ghost', type: 'button', text: t('set.exportSecrets'), onclick: () => {
    if (confirm(t('set.exportSecretsWarn'))) downloadExport(true);
  } }));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.exportSecretsWarn') }));
  pane.appendChild(el('div', { class: 'divider' }));
  pane.appendChild(el('button', { class: 'btn ghost', type: 'button', text: t('set.import'), onclick: openImportDialog }));
  pane.appendChild(el('p', { class: 'fld-h', text: t('set.importWarn') }));
  return pane;
}

/* ----------------------------- export / import ---------------------------- */

export function openExportDialog() {
  const body = el('div', { class: 'dlg' }, [
    el('button', { class: 'btn primary', type: 'button', text: t('set.exportPlain'), onclick: () => { downloadExport(false); closeDialog(); } }),
    el('button', { class: 'btn ghost', type: 'button', text: t('set.exportSecrets'), onclick: () => {
      if (confirm(t('set.exportSecretsWarn'))) { downloadExport(true); closeDialog(); }
    } }),
    el('p', { class: 'fld-h', text: t('set.exportSecretsWarn') }),
  ]);
  openDialog({ title: t('menu.export'), body });
}

export function openImportDialog() {
  let includeSecrets = false;
  const input = el('input', { class: 'inp', type: 'file', accept: 'application/json,.json' });
  const body = el('div', { class: 'dlg' }, [
    el('p', { class: 'fld-h', text: t('set.importWarn') }),
    field(t('set.import'), input),
    checkbox(t('set.importSecrets'), false, (value) => { includeSecrets = value; }),
  ]);
  body.appendChild(dialogFooter(async () => {
    const file = input.files?.[0];
    if (!file) return;
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      toast(t('msg.invalidJson'), 'error');
      return;
    }
    try {
      const result = await api('/api/config/import', { method: 'POST', body: { payload, includeSecrets } });
      state.config = result.config;
      state.saved = clone(result.config);
      closeDialog();
      renderAll();
      refreshData();
      toast(t('msg.imported'));
    } catch (error) {
      toast(error.details?.length ? `${error.message} ${error.details[0]}` : error.message, 'error');
    }
  }, closeDialog, t('menu.import')));
  openDialog({ title: t('menu.import'), body });
}

/* --------------------------------- wiring -------------------------------- */

/* Called by the boot, rather than waiting for DOMContentLoaded: a module
   script is deferred, so by the time this runs the document is already
   parsed and the event has been and gone. */
export function bindEditor() {
  id('edit-save').addEventListener('click', saveDashboard);
  id('edit-cancel').addEventListener('click', cancelEditing);
  // The renderer decorates nothing by itself; it calls back here in edit mode.
  setEditDecorators({
    links: decorateLinksForEditing,
    folder: decorateFolderForEditing,
    tiles: decorateTilesForEditing,
  });
}

addEventListener('beforeunload', (event) => {
  if (state.editing && isDirty()) {
    event.preventDefault();
    event.returnValue = '';
  }
});
