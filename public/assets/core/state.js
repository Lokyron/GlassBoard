/* What the page is currently showing.
 *
 * The core's own fields are listed here. A module keeps its own working data
 * under state.m[<module id>], which the registry creates for it: the kernel no
 * longer carries a field per feature, and a module cannot quietly reach into
 * another one's. */
export const state = {
  config: null,
  saved: null,
  tileTypes: {},
  editing: false,
  themePresets: {},
  wallpaperVersion: '',
  me: null,    // the signed-in account: its name, and whether it administers
  news: null,  // the changelog sections this account has not been shown
  m: {},       // module id -> that module's own state
};

/** The bag a module keeps its working data in, created on first use. */
export const moduleState = (moduleId) => (state.m[moduleId] ??= {});
