/* Glassboard — live editing, settings and backup dialogs.
   Everything here is layered on top of the read-mode renderer in app.js: read
   mode renders exactly the same markup whether or not this file did anything. */

const uid = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const PALETTE = ['#0a84ff', '#5e5ce6', '#64d2ff', '#16a34a', '#34c759', '#eab308', '#f97316', '#ea580c', '#ef4444', '#ec4899', '#a129cc', '#8b5cf6', '#3b82f6', '#10b981', '#14b8a6', '#475569'];

/* ----------------------------- form building ----------------------------- */

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

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

function setEditing(on) {
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

/* ------------------------- drag & drop reordering ------------------------ */

/** Wire a container so its [data-index] children can be reordered by dragging. */
function makeSortable(container, selector, onReorder) {
  let dragIndex = null;
  container.querySelectorAll(selector).forEach((node) => {
    node.setAttribute('draggable', 'true');
    node.addEventListener('dragstart', (event) => {
      dragIndex = Number(node.dataset.index);
      node.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(dragIndex));
    });
    node.addEventListener('dragend', () => {
      node.classList.remove('dragging');
      container.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
    });
    node.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      node.classList.add('drop-target');
    });
    node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
    node.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const from = dragIndex ?? Number(event.dataTransfer.getData('text/plain'));
      const to = Number(node.dataset.index);
      node.classList.remove('drop-target');
      if (Number.isInteger(from) && Number.isInteger(to) && from !== to) onReorder(from, to);
    });
  });
}

const moveItem = (list, from, to) => { list.splice(to, 0, list.splice(from, 1)[0]); };

/* --------------------------- tiles in edit mode -------------------------- */

function decorateTilesForEditing() {
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

  makeSortable(grid, '.editable', (from, to) => {
    moveItem(state.config.tiles, from, to);
    renderTiles();
    refreshData();
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

function openAddTileDialog() {
  const used = new Set(state.config.tiles.map((tile) => tile.type));
  const available = Object.entries(state.tileTypes).filter(([type, meta]) => !meta.singleton || !used.has(type));
  const body = el('div', { class: 'dlg' }, [
    el('div', { class: 'tile-choices' }, available.map(([type, meta]) =>
      el('button', {
        class: 'tile-choice', type: 'button',
        html: `${svg(type === 'georide' ? 'motorcycle' : type === 'note' ? 'notebook' : 'cloud-sun', 'font-size:22px')}<span>${esc(meta.label)}</span>`,
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

function decorateLinksForEditing() {
  const grid = id('links-grid');
  grid.querySelectorAll('[data-link]').forEach((node) => {
    const index = Number(node.dataset.link);
    node.dataset.index = index;
    node.classList.add('editable');
    if (node.tagName === 'A') node.addEventListener('click', (event) => event.preventDefault());
    node.appendChild(el('div', { class: 'tile-edit' }, [
      el('button', { class: 'tinybtn', title: t('edit.settings'), html: svg('pencil-simple'), onclick: (e) => { e.stopPropagation(); openLinkDialog(index); } }),
      el('button', { class: 'tinybtn danger', title: t('edit.remove'), html: svg('trash'), onclick: (e) => { e.stopPropagation(); removeLink(index); } }),
    ]));
    if (state.config.links[index].items) {
      node.addEventListener('dblclick', () => openFolder(index));
    }
  });

  grid.appendChild(el('button', { class: 'app app-add', html: `${svg('plus', 'font-size:22px')}<span>${esc(t('edit.addLink'))}</span>`, onclick: () => addLink(false) }));
  grid.appendChild(el('button', { class: 'app app-add', html: `${svg('folder', 'font-size:22px')}<span>${esc(t('edit.addFolder'))}</span>`, onclick: () => addLink(true) }));

  makeSortable(grid, '.editable', (from, to) => {
    moveItem(state.config.links, from, to);
    renderLinks();
  });
}

function addLink(isFolder) {
  const link = isFolder
    ? { id: uid('lnk'), title: 'Folder', color: '#0a84ff', icon: 'folder', items: [] }
    : { id: uid('lnk'), title: 'Shortcut', url: 'https://example.org/', color: '#0a84ff', icon: 'link' };
  state.config.links.push(link);
  renderLinks();
  openLinkDialog(state.config.links.length - 1);
}

function removeLink(index) {
  if (!confirm(t('edit.confirmRemove', { name: state.config.links[index].title }))) return;
  state.config.links.splice(index, 1);
  renderLinks();
}

function openLinkDialog(index, folderIndex = null) {
  const source = folderIndex === null ? state.config.links[index] : state.config.links[folderIndex].items[index];
  const draft = clone(source);
  const isFolder = Boolean(draft.items);

  const body = el('div', { class: 'dlg' }, [
    field(t('dlg.title'), textInput(draft.title, { oninput: (e) => { draft.title = e.target.value; } })),
    isFolder ? null : field(t('dlg.url'), textInput(draft.url, { oninput: (e) => { draft.url = e.target.value; }, placeholder: 'https://' })),
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
          el('button', { class: 'tinybtn', type: 'button', html: svg('pencil-simple'), onclick: () => openSubItemDialog(draft, i, renderSubList) }),
          el('button', { class: 'tinybtn danger', type: 'button', html: svg('trash'), onclick: () => { draft.items.splice(i, 1); renderSubList(); } }),
        ]));
      });
      list.appendChild(el('button', { class: 'btn ghost', type: 'button', text: t('edit.addItem'), onclick: () => {
        draft.items.push({ id: uid('sub'), title: 'Link', url: 'https://example.org/', color: draft.color, icon: 'link' });
        openSubItemDialog(draft, draft.items.length - 1, renderSubList);
      } }));
    };
    renderSubList();
    body.appendChild(field(t('apps.links', { n: draft.items.length }), list));
  }

  body.appendChild(dialogFooter(() => {
    if (folderIndex === null) state.config.links[index] = draft;
    else state.config.links[folderIndex].items[index] = draft;
    closeDialog();
    renderLinks();
    if (folderIndex !== null) openFolder(folderIndex);
  }));
  openDialog({ title: draft.title, subtitle: isFolder ? t('edit.addFolder') : t('edit.addLink'), body });
}

/** Nested editor for one link inside a folder, without leaving the folder dialog. */
function openSubItemDialog(folderDraft, itemIndex, onDone) {
  const item = clone(folderDraft.items[itemIndex]);
  const body = el('div', { class: 'dlg' }, [
    field(t('dlg.title'), textInput(item.title, { oninput: (e) => { item.title = e.target.value; } })),
    field(t('dlg.url'), textInput(item.url, { oninput: (e) => { item.url = e.target.value; } })),
    field(t('dlg.colour'), colourPicker(item.color, (colour) => { item.color = colour; })),
    field(t('dlg.icon'), iconPicker(item.icon, (icon) => { item.icon = icon; })),
  ]);
  body.appendChild(dialogFooter(() => {
    folderDraft.items[itemIndex] = item;
    closeDialog();
    onDone();
  }));
  openDialog({ title: item.title, body });
}

function decorateFolderForEditing(folderIndex) {
  const grid = id('folder-links-grid');
  grid.querySelectorAll('[data-item]').forEach((node) => {
    const i = Number(node.dataset.item);
    node.dataset.index = i;
    node.classList.add('editable');
    node.addEventListener('click', (event) => event.preventDefault());
    node.appendChild(el('div', { class: 'tile-edit' }, [
      el('button', { class: 'tinybtn', html: svg('pencil-simple'), onclick: (e) => { e.stopPropagation(); openLinkDialog(i, folderIndex); } }),
      el('button', { class: 'tinybtn danger', html: svg('trash'), onclick: (e) => { e.stopPropagation(); state.config.links[folderIndex].items.splice(i, 1); openFolder(folderIndex); renderLinks(); } }),
    ]));
  });
  grid.appendChild(el('button', { class: 'app app-add', html: `${svg('plus', 'font-size:22px')}<span>${esc(t('edit.addItem'))}</span>`, onclick: () => {
    state.config.links[folderIndex].items.push({ id: uid('sub'), title: 'Link', url: 'https://example.org/', color: state.config.links[folderIndex].color, icon: 'link' });
    openFolder(folderIndex);
    renderLinks();
  } }));
  makeSortable(grid, '.editable', (from, to) => {
    moveItem(state.config.links[folderIndex].items, from, to);
    openFolder(folderIndex);
    renderLinks();
  });
}

/* -------------------------------- settings ------------------------------- */

async function openSettings(section = 'general') {
  const draft = clone(state.config);
  const body = el('div', { class: 'dlg' });
  const tabs = el('div', { class: 'tabs' });
  const panes = el('div', { class: 'panes' });

  const sections = {
    general: () => generalPane(draft),
    appearance: () => appearancePane(draft),
    weather: () => weatherPane(draft),
    georide: () => georidePane(draft),
    account: () => accountPane(),
    data: () => dataPane(),
  };
  const labels = {
    general: t('set.general'), appearance: t('set.appearance'), weather: t('set.weather'),
    georide: t('set.georide'), account: t('set.account'), data: t('set.data'),
  };

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

  api('/api/auth/me').then((me) => {
    status.textContent = `${t('set.signedInAs', { name: me.username })} — ${t('set.recoveryLeft', { n: me.recoveryCodesLeft })}`;
  }).catch(() => { status.textContent = ''; });

  return pane;
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

function openExportDialog() {
  const body = el('div', { class: 'dlg' }, [
    el('button', { class: 'btn primary', type: 'button', text: t('set.exportPlain'), onclick: () => { downloadExport(false); closeDialog(); } }),
    el('button', { class: 'btn ghost', type: 'button', text: t('set.exportSecrets'), onclick: () => {
      if (confirm(t('set.exportSecretsWarn'))) { downloadExport(true); closeDialog(); }
    } }),
    el('p', { class: 'fld-h', text: t('set.exportSecretsWarn') }),
  ]);
  openDialog({ title: t('menu.export'), body });
}

function openImportDialog() {
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

document.addEventListener('DOMContentLoaded', () => {
  id('edit-save').addEventListener('click', saveDashboard);
  id('edit-cancel').addEventListener('click', cancelEditing);
});

addEventListener('beforeunload', (event) => {
  if (state.editing && isDirty()) {
    event.preventDefault();
    event.returnValue = '';
  }
});
