/* A pinned note. No data, no refresh, nothing to tear down — the whole module
   is its markup, which is the point of it being one. */
import { esc, svg, state } from '/assets/core/kernel.js';

function noteTileMarkup(tile, index) {
  const delay = `animation-delay:.${String(5 * (index + 1)).padStart(2, '0')}s`;
  const heading = esc(tile.settings.heading || '');
  const body = esc(tile.settings.body || '');
  // Bento drops the uppercase label and the signed footer: a module header, a
  // title and the note. Glass keeps its original card exactly.
  if ((state.config?.appearance?.style || 'bento') === 'bento') {
    return `<article class="card glass insight rise" style="${delay}" data-tile="${tile.id}" data-type="note">
        <div class="bento-th">${svg('notebook', 'font-size:15px')}<span>${esc(t('note.heading'))}</span></div>
        <div class="note-title">${heading}</div>
        <p class="note-body">${body}</p></article>`;
  }
  return `<article class="card glass insight rise" style="${delay}" data-tile="${tile.id}" data-type="note">
        <div class="lbl">${esc(t('note.heading'))}</div><h3>${heading}</h3>
        <p>${body}</p>
        <div class="insight-foot"><div class="dot"></div><span>${esc(state.config.site.title)}</span></div></article>`;
}

export default {
  id: 'note',
  tiles: { note: { markup: noteTileMarkup } },
};
