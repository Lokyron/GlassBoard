/* Proxmox — the node card, and the guests behind it.
 *
 * The browser never talks to the hypervisor: it reads a snapshot the server
 * fetched and cached, which is what keeps the Proxmox token on the server and
 * the card's load off the request path.
 *
 * Read-only all the way down. There is no button here that could start or
 * stop anything, because there is no route behind one. */
import {
  id, safe, esc, svg, state, moduleState, api, toast, openModal, closeModal, tileElement,
} from '/assets/core/kernel.js';

/* How often the page asks while somebody is in front of it.
 *
 * Five seconds, and it is not what decides the load on the hypervisor: the
 * server answers from its cache and only goes upstream for a snapshot older
 * than ten seconds, so this rate costs at most six calls a minute however
 * many browsers are open. What it does decide is how fresh the figures look,
 * and under ten seconds there is nothing left to gain — `pvestatd` recomputes
 * them about that often.
 *
 * It stops dead when the tab is hidden. A dashboard nobody is looking at is
 * not worth a single request, on a phone least of all. */
const LIVE_SECONDS = 5;

const own = moduleState('pve');
Object.assign(own, {
  snapshot: own.snapshot ?? null,
  error: own.error ?? '',
  configured: own.configured ?? false,
  timer: own.timer ?? null,
});

/* -------------------------------- figures -------------------------------- */

/** Bytes in the unit a human would have used, and no more digits than that
 *  unit deserves: 1.4 GB, 970 MB, 2.1 TB. */
function bytes(value) {
  const n = Number(value) || 0;
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let step = 0;
  let left = n;
  while (left >= 1024 && step < units.length - 1) { left /= 1024; step += 1; }
  const digits = left < 10 && step > 0 ? 1 : 0;
  return `${left.toFixed(digits)} ${units[step]}`;
}

const percent = (share) => (share === null || share === undefined ? '—' : `${Math.round(share * 100)}%`);

/** An uptime a reader can take in at a glance: days and hours, or hours and
 *  minutes under a day. Seconds are never the answer to "since when". */
function uptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return t('pve.justStarted');
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return t('pve.dh', { d: days, h: hours });
  if (hours > 0) return t('pve.hm', { h: hours, m: minutes });
  return t('pve.m', { m: minutes });
}

/** The node the card shows: the one named in the settings, or the first. */
function chosenNode(snapshot) {
  const nodes = snapshot?.nodes ?? [];
  const wanted = state.config.integrations.pve?.node;
  return nodes.find((node) => node.name === wanted) ?? nodes[0] ?? null;
}

/** A share as one of three readings. Past four fifths of a disk or a memory,
 *  a homelab is a weekend's work away from a problem, so the card says so. */
const level = (share) => (share === null ? '' : share >= 0.9 ? 'bad' : share >= 0.8 ? 'warn' : '');

/* --------------------------------- card ---------------------------------- */

function pveTileMarkup(tile, index) {
  const delay = `animation-delay:.${String(5 * (index + 1)).padStart(2, '0')}s`;
  return `<article class="card glass rise pve" style="${delay}" data-tile="${tile.id}" data-type="pve">
        <div class="wtop"><div><div class="lbl">${esc(t('pve.title'))}</div><h3 data-role="name">…</h3></div><div class="emoji">${svg('hard-drives', 'font-size:28px')}</div></div>
        <div class="gr-stats" data-role="stats"></div>
        <div class="insight-foot"><div class="dot" data-role="dot"></div><span data-role="foot">…</span></div></article>`;
}

/* The detail goes on a line of its own rather than inside the figure, which
   is where GeoRide puts its unit. "62.7 GB" is not "km": next to a percentage
   in a quarter of a card it is ellipsis and nothing else. */
const statCell = (key, value, detail = '', tone = '') =>
  `<div class="gr-stat"><div class="k">${esc(key)}</div><div class="v${tone ? ` ${tone}` : ''}">${esc(value)}</div>${detail ? `<div class="s">${esc(detail)}</div>` : ''}</div>`;

function renderPveTile(tile) {
  const article = tileElement(tile.id);
  if (!article) return;
  const el = (role) => article.querySelector(`[data-role="${role}"]`);
  // A card with nothing behind it opens nothing, so it does not offer to.
  article.classList.toggle('pve-clickable', Boolean(own.configured && own.snapshot));
  const stats = el('stats');
  const dot = el('dot');
  const foot = el('foot');

  if (!own.configured) {
    safe(el('name'), t('pve.notConfigured'));
    stats.innerHTML = `<p class="gr-message">${esc(t('pve.notConfiguredHint'))}</p>`;
    if (dot) dot.style.background = 'var(--muted)';
    safe(foot, t('pve.notConnected'));
    return;
  }

  const snapshot = own.snapshot;
  const node = chosenNode(snapshot);
  if (!node) {
    safe(el('name'), t('pve.title'));
    stats.innerHTML = `<p class="gr-message">${esc(own.error || t('pve.unavailable'))}</p>`;
    if (dot) dot.style.background = '#ff453a';
    safe(foot, t('pve.unavailable'));
    return;
  }

  safe(el('name'), node.name);
  stats.innerHTML = [
    statCell(t('pve.cpu'), percent(node.cpu), t('pve.cores', { n: node.cores }), level(node.cpu)),
    statCell(t('pve.memory'), percent(node.memory.share), `${bytes(node.memory.used)} / ${bytes(node.memory.total)}`, level(node.memory.share)),
    statCell(t('pve.disk'), percent(node.disk.share), `${bytes(node.disk.used)} / ${bytes(node.disk.total)}`, level(node.disk.share)),
    statCell(t('pve.uptime'), uptime(node.uptime)),
  ].join('');

  const mine = (snapshot.guests ?? []).filter((guest) => guest.node === node.name);
  const running = mine.filter((guest) => guest.running).length;
  if (dot) dot.style.background = node.online ? '#34c759' : '#ff453a';
  // A snapshot served from a host that has since gone quiet says so, rather
  // than showing figures from an hour ago as if they were current.
  safe(foot, snapshot.stale
    ? t('pve.stale', { when: when(snapshot.fetchedAt) })
    : t('pve.guestsRunning', { running, total: mine.length }));
}

/** A timestamp as the reader's own clock would show it. */
const when = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString(state.config.site.locale, { hour: '2-digit', minute: '2-digit' });
};

async function loadPve({ live = false } = {}) {
  try {
    const payload = await api(`/api/m/pve/snapshot${live ? '?live=1' : ''}`);
    own.configured = payload.configured === true;
    own.snapshot = payload.snapshot ?? null;
    own.error = '';
  } catch (error) {
    own.error = error.message;
    // A failed refresh keeps the last snapshot: a blank card says less than
    // an old one with the time it was taken.
    own.configured = true;
  }
  const tile = state.config.tiles.find((item) => item.type === 'pve');
  if (tile) renderPveTile(tile);
  if (id('pve-modal')?.classList.contains('open')) renderPveModal();
}

/* ---------------------------------- live --------------------------------- */

const hasTile = () => state.config.tiles.some((tile) => tile.type === 'pve');

function stopLive() {
  if (own.timer) clearInterval(own.timer);
  own.timer = null;
}

/** Start, restart or decline to start the live tick, depending on whether
 *  there is anything to show and anyone to show it to. */
function startLive() {
  stopLive();
  if (document.hidden || !hasTile()) return;
  own.timer = setInterval(() => loadPve({ live: true }), LIVE_SECONDS * 1000);
}

/* --------------------------------- panel --------------------------------- */

const bar = (share) => {
  const width = share === null ? 0 : Math.min(100, Math.max(0, share * 100));
  return `<div class="pve-bar${level(share) ? ` ${level(share)}` : ''}"><div style="width:${width.toFixed(1)}%"></div></div>`;
};

function nodeCard(node) {
  return `<div class="box pve-node">
      <div class="pve-node-head"><span class="pve-node-name">${esc(node.name)}</span>
        <span class="pve-pill${node.online ? ' on' : ''}">${esc(node.online ? t('pve.online') : t('pve.offline'))}</span></div>
      <div class="pve-meter"><span>${esc(t('pve.cpu'))}</span><strong>${esc(percent(node.cpu))}</strong>${bar(node.cpu)}
        <small>${esc(t('pve.cores', { n: node.cores }))}</small></div>
      <div class="pve-meter"><span>${esc(t('pve.memory'))}</span><strong>${esc(percent(node.memory.share))}</strong>${bar(node.memory.share)}
        <small>${esc(bytes(node.memory.used))} / ${esc(bytes(node.memory.total))}</small></div>
      <div class="pve-meter"><span>${esc(t('pve.disk'))}</span><strong>${esc(percent(node.disk.share))}</strong>${bar(node.disk.share)}
        <small>${esc(bytes(node.disk.used))} / ${esc(bytes(node.disk.total))}</small></div>
      <div class="pve-meter"><span>${esc(t('pve.uptime'))}</span><strong>${esc(uptime(node.uptime))}</strong></div>
    </div>`;
}

function guestRow(guest) {
  const kind = guest.kind === 'lxc' ? t('pve.lxc') : t('pve.qemu');
  const figures = guest.running
    ? `${percent(guest.cpu)} · ${bytes(guest.memory.used)} / ${bytes(guest.memory.total)} · ${uptime(guest.uptime)}`
    : t('pve.stopped');
  return `<div class="gr-trip pve-guest${guest.running ? '' : ' off'}">
      <div class="gr-trip-when"><span class="pc-dot" style="background:${guest.running ? '#34c759' : 'var(--muted)'}"></span>
        <span class="pve-guest-name">${esc(guest.name)}</span>
        <span class="pve-kind">${esc(kind)}</span>
        <span class="pve-vmid">#${guest.vmid}</span></div>
      <div class="gr-trip-figures">${esc(figures)}</div>
    </div>`;
}

function storageRow(storage) {
  return `<div class="pve-storage">
      <div class="pve-storage-head"><span>${esc(storage.name)}</span>
        <small>${esc(bytes(storage.used))} / ${esc(bytes(storage.total))}</small></div>
      ${bar(storage.share)}
    </div>`;
}

function renderPveModal() {
  const snapshot = own.snapshot;
  const nodes = snapshot?.nodes ?? [];
  safe(id('pve-modal-title'), chosenNode(snapshot)?.name || t('pve.title'));
  safe(id('pve-modal-sub'), snapshot?.version ? `Proxmox VE ${snapshot.version}` : t('pve.subtitle'));

  id('pve-nodes').innerHTML = nodes.length ? nodes.map(nodeCard).join('') : '';

  const guests = snapshot?.guests ?? [];
  safe(id('pve-guests-count'), t('pve.guestsRunning', {
    running: guests.filter((guest) => guest.running).length,
    total: guests.length,
  }));
  id('pve-guests').innerHTML = guests.length
    ? guests.map(guestRow).join('')
    : `<p class="gr-empty">${esc(t('pve.noGuests'))}</p>`;

  const storages = (snapshot?.storages ?? []).filter((storage) => storage.total > 0);
  const storageBox = id('pve-storages');
  storageBox.hidden = storages.length === 0;
  storageBox.innerHTML = storages.length
    ? `<div class="pve-storages-head">${esc(t('pve.storage'))}</div>${storages.map(storageRow).join('')}`
    : '';

  id('pve-live')?.classList.toggle('off', Boolean(snapshot?.stale) || !snapshot);
  safe(id('pve-fetched'), snapshot?.fetchedAt
    ? t(snapshot.stale ? 'pve.stale' : 'pve.fetched', { when: when(snapshot.fetchedAt) })
    : '');
}

/* Asking the hypervisor again, now.
 *
 * The button is in the panel's head and nowhere else: the card is a reading,
 * and a control on it would be a thing to press by accident every time the
 * card is opened. Here it is a deliberate click on an open panel.
 *
 * Disabled while the request is in the air, which is both the feedback and
 * the guard — a held-down button cannot become a queue of calls to Proxmox. */
async function forceRefresh(button) {
  button.disabled = true;
  try {
    const payload = await api('/api/m/pve/refresh', { method: 'POST' });
    own.configured = payload.configured === true;
    own.snapshot = payload.snapshot ?? own.snapshot;
    own.error = '';
    const tile = state.config.tiles.find((item) => item.type === 'pve');
    if (tile) renderPveTile(tile);
    renderPveModal();
    /* A host that did not answer gives back the last good snapshot rather than
       nothing, which is right for the refresh nobody asked for — but this one
       was asked for, and "dernier contact à…" replacing "à…" in small grey
       text is not an answer to a button press. */
    if (payload.snapshot?.stale) toast(payload.snapshot.error || t('pve.unavailable'), 'error');
  } catch (error) {
    // The panel keeps the snapshot it had; the toast says why it is still it.
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function openPveModal(origin = null) {
  if (!own.configured || !own.snapshot) return;
  const tile = state.config.tiles.find((item) => item.type === 'pve');
  openModal('pve-modal', origin ?? (tile ? tileElement(tile.id) : null));
  renderPveModal();
}

/* ------------------------------ the contract ------------------------------ */

export default {
  id: 'pve',

  tiles: {
    pve: {
      markup: pveTileMarkup,
      open: (article) => openPveModal(article),
    },
  },

  mounted() {
    /* The tick is restarted on every render, because a render may have added
       or removed the tile. The listeners below are wired once. */
    startLive();
    if (own.wired) return;
    own.wired = true;
    /* The core stops its own timers when the tab goes away but has no way to
       tell a module to stop its, so the module listens for itself. Coming
       back asks at once rather than waiting out an interval: the figures on
       screen are as old as the time spent in another tab. */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return stopLive();
      loadPve({ live: true });
      startLive();
    });
    id('pve-modal').addEventListener('click', (event) => {
      if (event.target === id('pve-modal')) closeModal('pve-modal');
    });
    id('pve-refresh')?.addEventListener('click', (event) => forceRefresh(event.currentTarget));
  },

  refresh: loadPve,

  navEntries: () =>
    state.config.tiles
      .filter((tile) => tile.type === 'pve')
      .map(() => ({
        icon: 'hard-drives',
        label: t('pve.title'),
        short: t('pve.title'),
        run: () => openPveModal(),
      })),

  closeViews: () => closeModal('pve-modal'),

  /* A re-render throws the tile away; the tick that feeds it goes too, and
     mounted() starts a new one if there is still a tile to feed. */
  unmount: stopLive,
};
