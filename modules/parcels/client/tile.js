/* Parcels — what is on its way, where it is, and the tracking numbers found
 * in the mailbox waiting for a yes.
 *
 * A 17TRACK credit is spent when a number is registered, never when a status
 * is read: nothing here registers anything on a timer. */
import {
  id, safe, esc, svg, state, moduleState, api, toast, openModal, closeModal,
  tileElement, tileOfType,
} from '/assets/core/kernel.js';

const own = moduleState('parcels');
Object.assign(own, {
  parcels: own.parcels ?? null,           // the payload: list and counts
  selectedParcel: own.selectedParcel ?? null,
  suggestions: own.suggestions ?? null,   // numbers found in the mailbox
});

function parcelsTileMarkup(tile, index) {
  const delay = `animation-delay:.${String(5 * (index + 1)).padStart(2, '0')}s`;
  return `<article class="card glass rise parcels" style="${delay}" data-tile="${tile.id}" data-type="parcels">
        <div class="wtop"><div><div class="lbl">${esc(t('pc.title'))}</div><h3 data-role="head">…</h3></div><div class="emoji">${svg('package', 'font-size:28px')}</div></div>
        <div class="pc-list" data-role="list"></div>
        <div class="insight-foot"><div class="dot" data-role="dot"></div><span data-role="foot">…</span></div></article>`;
}

/* --------------------------------- parcels -------------------------------- */
/* The six states the server folds every carrier status into, each with the one
   colour it is worth on a dashboard. `manual` is a parcel followed by hand,
   typically an Amazon Logistics shipment no third party can query. */

const PARCEL_STATES = {
  pending: '#8e8e93',
  transit: '#0a84ff',
  delivery: '#5e5ce6',
  pickup: '#ff9f0a',
  delivered: '#34c759',
  problem: '#ff453a',
  manual: '#8e8e93',
};

const parcelColour = (parcel) => PARCEL_STATES[parcel?.state] ?? PARCEL_STATES.pending;
const parcelStateLabel = (parcel) => t(`pc.state.${parcel?.state ?? 'pending'}`);
const parcelName = (parcel) => parcel.label || parcel.trackingNumber || t('pc.untitled');

/** Newest first, but anything delivered sinks below what is still moving. */
const parcelOrder = (a, b) => {
  const done = (parcel) => (parcel.state === 'delivered' ? 1 : 0);
  if (done(a) !== done(b)) return done(a) - done(b);
  return (b.lastEvent?.at ?? 0) - (a.lastEvent?.at ?? 0);
};

const parcelWhen = (at) => (at
  ? new Date(at).toLocaleString(state.config.site.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');

function renderParcelsTile(tile, payload) {
  const article = tileElement(tile.id);
  if (!article) return;
  const el = (role) => article.querySelector(`[data-role="${role}"]`);
  const usable = Boolean(payload?.ok);
  article.classList.toggle('pc-clickable', usable);

  if (!usable) {
    safe(el('head'), '');
    el('list').innerHTML = `<p class="gr-message">${esc(payload?.configured === false ? t('pc.notConfigured') : payload?.error || t('pc.unavailable'))}</p>`;
    el('dot').style.background = '#ff9f0a';
    el('dot').style.boxShadow = '0 0 0 5px rgba(255,159,10,.16)';
    safe(el('foot'), payload?.configured === false ? `${t('set.title')} → ${t('set.parcels')}` : t('pc.unavailable'));
    return;
  }

  const { counts } = payload;
  safe(el('head'), counts.active > 0 ? t('pc.onTheWay', { n: counts.active }) : t('pc.nothingMoving'));

  const shown = [...payload.parcels].sort(parcelOrder).slice(0, state.config.integrations.parcels.maxOnTile ?? 4);
  el('list').innerHTML = shown.length === 0
    ? `<p class="gr-message">${esc(t('pc.empty'))}</p>`
    : shown.map((parcel) => `<div class="pc-row">
        <span class="pc-dot" style="background:${parcelColour(parcel)}"></span>
        <span class="pc-name">${esc(parcelName(parcel))}</span>
        <span class="pc-state">${esc(parcelStateLabel(parcel))}</span>
      </div>`).join('');

  const worst = counts.problem > 0 ? '#ff453a' : counts.active > 0 ? '#0a84ff' : '#34c759';
  el('dot').style.background = worst;
  el('dot').style.boxShadow = `0 0 0 5px ${worst}29`;
  const parts = [];
  const waiting = own.suggestions?.length ?? 0;
  if (waiting > 0) parts.push(t('pc.foundInMail', { n: waiting }));
  if (counts.delivered > 0) parts.push(t('pc.deliveredCount', { n: counts.delivered }));
  if (counts.problem > 0) parts.push(t('pc.problemCount', { n: counts.problem }));
  if (payload.error) parts.push(t('pc.stale'));
  safe(el('foot'), parts.length ? parts.join(' · ') : t('pc.upToDate'));
}

async function loadParcels() {
  const tile = state.config.tiles.find((item) => item.type === 'parcels');
  if (!tile) return;
  try {
    own.parcels = await api('/api/m/parcels');
  } catch (error) {
    own.parcels = { ok: false, error: error.message };
  }
  renderParcelsTile(tile, own.parcels);
  loadSuggestions();
  if (id('parcels-modal')?.classList.contains('open')) renderParcels();
}

/* ---------------------- parcels found in the mailbox ---------------------- */
/* The scan proposes and the user decides, because accepting one of these is
   what spends a tracking credit. */

async function loadSuggestions() {
  if (!state.config.integrations.parcels?.mail?.enabled) {
    own.suggestions = [];
    renderSuggestions();
    return;
  }
  try {
    own.suggestions = (await api('/api/m/parcels/suggestions')).suggestions;
  } catch {
    own.suggestions = [];   // an instance without the scan: nothing to show
  }
  renderSuggestions();
}

function renderSuggestions() {
  const holder = id('pc-suggestions');
  if (!holder) return;
  const suggestions = own.suggestions ?? [];
  holder.hidden = suggestions.length === 0;
  if (suggestions.length === 0) {
    holder.innerHTML = '';
    return;
  }

  holder.innerHTML = `<div class="pc-suggest-head">${svg('envelope', 'font-size:16px')}<span>${esc(t('pc.foundInMail', { n: suggestions.length }))}</span></div>`
    + suggestions.map((suggestion) => `<div class="pc-suggest-row" data-suggestion="${esc(suggestion.id)}">
        <span class="pc-suggest-what">
          <span class="pc-suggest-label">${esc(suggestion.label || suggestion.trackingNumber)}</span>
          <span class="pc-suggest-meta">${esc(suggestion.trackingNumber)}${suggestion.carrier ? ` · ${esc(suggestion.carrier)}` : ''}${suggestion.trackable ? '' : ` · ${esc(t('pc.byHandOnly'))}`}</span>
        </span>
        <span class="row">
          <button class="btn primary" type="button" data-accept>${esc(t('pc.follow'))}</button>
          <button class="btn ghost" type="button" data-ignore>${esc(t('pc.ignore'))}</button>
        </span>
      </div>`).join('');

  holder.querySelectorAll('[data-suggestion]').forEach((row) => {
    const answer = async (action) => {
      row.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      try {
        await api(`/api/m/parcels/suggestions/${encodeURIComponent(row.dataset.suggestion)}/${action}`, { method: 'POST' });
        await loadParcels();
        if (action === 'accept') toast(t('pc.added'));
      } catch (error) {
        toast(error.message, 'error');
        row.querySelectorAll('button').forEach((button) => { button.disabled = false; });
      }
    };
    row.querySelector('[data-accept]').addEventListener('click', () => answer('accept'));
    row.querySelector('[data-ignore]').addEventListener('click', () => answer('ignore'));
  });
}

/** Take over the numbers already registered on the 17TRACK account — the ones
 *  added by hand on their site. Costs no quota: those numbers are declared
 *  already, so this only reads. */
async function importParcels(button) {
  button.disabled = true;
  try {
    const result = await api('/api/m/parcels/import', { method: 'POST' });
    own.parcels = result;
    renderParcelsTile(state.config.tiles.find((item) => item.type === 'parcels'), result);
    renderParcels();
    toast(result.imported > 0 ? t('pc.imported', { n: result.imported }) : t('pc.importNothing'));
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function scanMailbox(button) {
  button.disabled = true;
  try {
    const result = await api('/api/m/parcels/mail/scan', { method: 'POST' });
    own.suggestions = result.suggestions;
    renderSuggestions();
    await loadParcels();
    toast(result.proposed > 0 ? t('pc.scanFound', { n: result.proposed }) : t('pc.scanNothing'));
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

/* ----------------------- parcel detail view (history) --------------------- */

const closeParcelsModal = () => closeModal('parcels-modal');

function openParcelsModal(origin = null) {
  if (!own.parcels?.ok || !id('parcels-modal')) return;
  const scan = id('pc-scan');
  if (scan) scan.hidden = !state.config.integrations.parcels?.mail?.enabled;
  const importButton = id('pc-import');
  if (importButton) importButton.hidden = !own.parcels?.hasKey;
  openModal('parcels-modal', origin ?? tileOfType('parcels'));
  renderParcels();
}

/** The list on the left; the selection drives the panel on the right. */
function renderParcels() {
  const list = id('pc-list');
  const payload = own.parcels;
  if (!payload?.ok) {
    list.innerHTML = `<p class="gr-empty">${esc(payload?.error || t('pc.unavailable'))}</p>`;
    id('pc-detail').innerHTML = '';
    return;
  }

  renderSuggestions();
  const parcels = [...payload.parcels].sort(parcelOrder);
  if (parcels.length === 0) {
    list.innerHTML = `<p class="gr-empty">${esc(t('pc.empty'))}</p>`;
  } else {
    if (!parcels.some((parcel) => parcel.id === own.selectedParcel)) own.selectedParcel = parcels[0].id;
    list.innerHTML = parcels.map((parcel) => `<button class="gr-trip pc-item${parcel.id === own.selectedParcel ? ' active' : ''}" data-parcel="${esc(parcel.id)}">
        <span class="gr-trip-when"><span class="pc-dot" style="background:${parcelColour(parcel)}"></span>${esc(parcelName(parcel))}</span>
        <span class="gr-trip-where">${esc(parcelStateLabel(parcel))}${parcel.carrier?.name ? ` · ${esc(parcel.carrier.name)}` : ''}</span>
        <span class="gr-trip-figures">${esc(parcel.lastEvent?.at ? parcelWhen(parcel.lastEvent.at) : t('pc.noEvent'))}</span>
      </button>`).join('');
    list.querySelectorAll('[data-parcel]').forEach((button) => {
      button.addEventListener('click', () => {
        own.selectedParcel = button.dataset.parcel;
        renderParcels();
      });
    });
  }

  safe(id('pc-count'), payload.hidden > 0
    ? `${t('pc.following', { n: parcels.length })} · ${t('pc.hidden', { n: payload.hidden })}`
    : t('pc.following', { n: parcels.length }));
  renderParcelDetail(parcels.find((parcel) => parcel.id === own.selectedParcel) ?? null);
}

/** The chosen parcel: what it is, and every step the carrier reported. */
function renderParcelDetail(parcel) {
  const panel = id('pc-detail');
  if (!parcel) {
    panel.innerHTML = `<p class="gr-empty">${esc(t('pc.pick'))}</p>`;
    return;
  }

  const facts = [];
  if (parcel.trackingNumber) facts.push([t('pc.number'), parcel.trackingNumber]);
  if (parcel.carrier?.name) facts.push([t('pc.carrier'), parcel.carrier.name]);
  if (parcel.destination) facts.push([t('pc.destination'), parcel.destination]);
  if (parcel.daysInTransit !== null && parcel.daysInTransit !== undefined) {
    facts.push([t('pc.transit'), t(parcel.daysInTransit === 1 ? 'pc.day' : 'pc.days', { n: parcel.daysInTransit })]);
  }

  // A manually followed parcel has no history to show: it has a link instead.
  const events = parcel.events ?? [];
  const history = events.length > 0
    ? `<ol class="pc-steps">${events.map((event, index) => `<li class="pc-step${index === 0 ? ' now' : ''}">
          <span class="pc-step-dot"></span>
          <span class="pc-step-when">${esc(parcelWhen(event.at))}</span>
          <span class="pc-step-what">${esc(event.description || '—')}</span>
          ${event.location ? `<span class="pc-step-where">${esc(event.location)}</span>` : ''}
        </li>`).join('')}</ol>`
    : `<p class="gr-empty">${esc(parcel.provider === 'manual' ? t('pc.manualHint') : t('pc.noEvent'))}</p>`;

  panel.innerHTML = `
    <div class="pc-head">
      <div>
        <div class="pc-badge" style="background:${parcelColour(parcel)}1f;color:${parcelColour(parcel)}">${esc(parcelStateLabel(parcel))}</div>
        <h4>${esc(parcelName(parcel))}</h4>
      </div>
      <div class="row">
        ${parcel.url ? `<a class="btn ghost" href="${esc(parcel.url)}" target="_blank" rel="noopener noreferrer">${esc(t('pc.open'))}</a>` : ''}
        <button class="btn ghost danger" type="button" data-remove="${esc(parcel.id)}">${esc(t('pc.remove'))}</button>
      </div>
    </div>
    ${facts.length ? `<dl class="pc-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
    ${history}`;

  panel.querySelector('[data-remove]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!confirm(t('pc.confirmRemove', { name: parcelName(parcel) }))) return;
    button.disabled = true;
    try {
      await api(`/api/m/parcels/${encodeURIComponent(parcel.id)}`, { method: 'DELETE' });
      own.selectedParcel = null;
      await loadParcels();
      toast(t('pc.removed'));
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
    }
  });
}

/** Follow a new parcel. Without a number it is followed by hand, with a link. */
async function submitParcel(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const parcel = await api('/api/m/parcels', {
      method: 'POST',
      body: {
        label: id('pc-label').value,
        trackingNumber: id('pc-number').value,
        url: id('pc-url').value,
      },
    });
    form.reset();
    own.selectedParcel = parcel.parcel.id;
    await loadParcels();
    toast(t('pc.added'));
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function refreshParcels(button) {
  button.disabled = true;
  try {
    own.parcels = await api('/api/m/parcels/refresh', { method: 'POST' });
    const tile = state.config.tiles.find((item) => item.type === 'parcels');
    if (tile) renderParcelsTile(tile, own.parcels);
    renderParcels();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}


/* ------------------------------ the contract ------------------------------ */

export default {
  id: 'parcels',

  tiles: {
    parcels: {
      markup: parcelsTileMarkup,
      open: (article) => openParcelsModal(article),
    },
  },

  mounted() {
    if (own.wired) return;
    own.wired = true;
    const modal = id('parcels-modal');
    /* Optional throughout: a browser holding an older page in its cache has
       no parcel view, and a missing element must not stop the dashboard. */
    modal?.addEventListener('click', (event) => { if (event.target === modal) closeParcelsModal(); });
    id('pc-form')?.addEventListener('submit', submitParcel);
    id('pc-refresh')?.addEventListener('click', (event) => refreshParcels(event.currentTarget));
    id('pc-scan')?.addEventListener('click', (event) => scanMailbox(event.currentTarget));
    id('pc-import')?.addEventListener('click', (event) => importParcels(event.currentTarget));
  },

  refresh: loadParcels,
  closeViews: closeParcelsModal,
};
