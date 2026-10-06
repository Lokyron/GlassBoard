/* What a module may use.
 *
 * One import for the whole surface, so a module's dependency on the core is a
 * single line and what the core promises is a single file. Anything not
 * re-exported here is the core's own business and may change without warning
 * to a module.
 *
 *   import { api, el, t, openModal } from '/assets/core/kernel.js';
 */
export { html, id, safe, esc, svg, iconName, hydrateIcons, el, clone, reducedMotion, localDayKey, clockOf } from './dom.js';
export { api, toast } from './api.js';
export { state, moduleState } from './state.js';
export { openModal, closeModal, closeAllModals, tileOfType } from './modals.js';
export { onThemeChange, withTransition } from './theme.js';
export { goTo } from './chrome.js';
export { openDialog, closeDialog } from './dialogs.js';
export { tileElement } from './tiles.js';
export { field, textInput, checkbox, colourPicker, iconPicker, slider, dialogFooter, uid } from './forms.js';

/* t() and applyTranslations() come from /assets/i18n.js, a classic script the
   sign-in pages share with the dashboard, so they are globals rather than
   exports. Re-exported here all the same: a module should not have to know
   which of the things it uses happen to arrive that way. */
export const translate = (key, vars) => t(key, vars);
export const locale = () => currentLocale();
