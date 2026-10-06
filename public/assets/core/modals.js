/* Panel motion.
 *
 * A panel grows out of the card that opened it and shrinks back into it. The
 * dashboard already borrows the home-screen metaphor for dragging; this is the
 * same idea applied to opening, and it is what tells you at a glance which card
 * you are looking at.
 * The geometry is measured here and handed to CSS as custom properties, so the
 * timing, the easing and the look stay in the stylesheet with everything else.
 * Anything that cannot be measured — a card that has been re-rendered away, a
 * reader who asked for less motion — falls back to the plain fade the panels
 * have always had.
 *
 * Every open and every close goes through these two functions. A direct
 * classList.remove('open') elsewhere would cut the exit animation. */
import { id, reducedMotion } from './dom.js';

const MODAL_CLOSE_MS = 220;

/** What opened each panel, so closing can send it back there. */
const modalOrigins = new WeakMap();

/** The tile of a given type, for the paths that open a panel without a click —
 *  the side navigation, mostly. */
export const tileOfType = (type) => document.querySelector(`[data-type="${type}"]`);

/** Place a sheet over an element, as a translation and a scale from its centre. */
function sheetFrom(sheet, origin) {
  const from = origin.getBoundingClientRect();
  const to = sheet.getBoundingClientRect();
  if (!from.width || !to.width) return false;
  // One scale and not two: a sheet squashed to a card's proportions distorts
  // its own contents, and at this speed nobody sees the difference anyway.
  const scale = Math.min(0.9, Math.max(0.15, from.width / to.width));
  sheet.style.setProperty('--ox', `${(from.left + from.width / 2) - (to.left + to.width / 2)}px`);
  sheet.style.setProperty('--oy', `${(from.top + from.height / 2) - (to.top + to.height / 2)}px`);
  sheet.style.setProperty('--os', String(scale));
  return true;
}

const clearSheet = (sheet) => {
  sheet.classList.remove('fly-in', 'fly-out');
  sheet.style.removeProperty('--ox');
  sheet.style.removeProperty('--oy');
  sheet.style.removeProperty('--os');
};

/**
 * Open a panel.
 * @param {string} modalId
 * @param {Element|null} origin the card it should appear to come from
 */
export function openModal(modalId, origin = null) {
  const modal = id(modalId);
  if (!modal) return;
  const sheet = modal.querySelector('.sheet');
  modal.classList.remove('closing');
  modal.classList.add('open');
  if (!sheet) return;
  clearSheet(sheet);
  if (origin?.isConnected && !reducedMotion() && sheetFrom(sheet, origin)) {
    modalOrigins.set(modal, origin);
    sheet.classList.add('fly-in');
  } else {
    modalOrigins.delete(modal);
  }
}

/**
 * Close a panel, back into whatever opened it when that is still on screen.
 * Resolves once the panel is really gone, so a caller can tear down after it.
 */
export function closeModal(modalId) {
  const modal = typeof modalId === 'string' ? id(modalId) : modalId;
  if (!modal?.classList.contains('open')) return Promise.resolve();
  const sheet = modal.querySelector('.sheet');
  const origin = modalOrigins.get(modal);
  modalOrigins.delete(modal);

  const finish = () => {
    modal.classList.remove('open', 'closing');
    if (sheet) clearSheet(sheet);
  };

  if (!sheet || reducedMotion()) {
    finish();
    return Promise.resolve();
  }
  sheet.classList.remove('fly-in');
  if (origin?.isConnected) sheetFrom(sheet, origin);
  sheet.classList.add('fly-out');
  modal.classList.add('closing');
  return new Promise((resolve) => {
    // A timer and not animationend alone: an animation in a hidden tab never
    // fires, and a panel that cannot close is worse than one that closes
    // without its animation.
    const done = () => { finish(); resolve(); };
    const timer = setTimeout(done, MODAL_CLOSE_MS + 60);
    sheet.addEventListener('animationend', () => { clearTimeout(timer); done(); }, { once: true });
  });
}

/** Every open panel at once — what Escape and a sign-out do. */
export const closeAllModals = () => Promise.all(
  [...document.querySelectorAll('.modal.open')].map((modal) => closeModal(modal))
);

