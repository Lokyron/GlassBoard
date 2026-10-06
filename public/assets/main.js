/* The dashboard's entry point.
 *
 * Loaded as <script type="module">, which is deferred: the classic scripts the
 * sign-in pages share with this one — icons.js, i18n.js, pwa.js — have already
 * run and their top-level declarations are visible here as globals.
 *
 * Everything else is an ES module, and the features arrive by dynamic import
 * from the registry rather than by being listed in the page. */
import './core/boot.js';
