/* A pinned note. No data, no refresh, nothing to tear down — the whole module
   is its markup, which is the point of it being one. */
import { esc, state } from '/assets/core/kernel.js';

function noteTileMarkup(tile, index) {
  const delay = `animation-delay:.${String(5 * (index + 1)).padStart(2, '0')}s`;
  return `<article class="card glass insight rise" style="${delay}" data-tile="${tile.id}" data-type="note">
        <div class="lbl">${esc(t('note.heading'))}</div><h3>${esc(tile.settings.heading || '')}</h3>
        <p>${esc(tile.settings.body || '')}</p>
        <div class="insight-foot"><div class="dot"></div><span>${esc(state.config.site.title)}</span></div></article>`;
}

export default {
  id: 'note',
  tiles: { note: { markup: noteTileMarkup } },
};
