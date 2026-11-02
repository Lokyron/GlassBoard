/* The one reusable dialog. Everything that is not a tile's own panel — the
   settings, the editors, the changelog, an import — is shown in it.
 *
 * A nested editor (a shortcut inside a folder) must reopen its parent on the
 * same draft rather than close it, or the draft is lost. */
import { id, safe, hydrateIcons } from './dom.js';
import { openModal, closeModal } from './modals.js';

export function openDialog({ title, subtitle = '', body }) {
  safe(id('dialog-title'), title);
  safe(id('dialog-subtitle'), subtitle);
  const container = id('dialog-body');
  container.innerHTML = '';
  container.appendChild(body);
  hydrateIcons(container);
  openModal('dialog-modal');
}

export const closeDialog = () => closeModal('dialog-modal');
