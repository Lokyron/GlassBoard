# Modules

One folder per feature. The core knows the contract, never the feature.

```
modules/<id>/
  manifest.js      what it is: its tiles, the shape of its settings, its default switch
  server.js        optional — routes(router), mounted at /api/m/<id>
  jobs.js          optional — recurring work, run off the request path
  worker.js        optional — the heavy half, run on its own thread
  client/tile.js   how it draws, served at /modules/<id>/tile.js
  client/pane.js   optional — its tab in the settings
```

Adding one means creating the folder and listing it in
`server/modules/registry.js`. Nothing else in the core changes: the tile
types, the configuration schema, the settings tabs, the routes and the
background work are all composed from what the manifests declare.

## The one rule

**A route does not call the network.** It reads what a job already wrote.

Node serves every request on one thread. A route that waits on a third-party
API holds up the reader; a route that *parses* what came back holds up every
reader on the instance, for every account. Both were true of this application
before the modules existed, and removing it is what they are for.

So: the network and anything expensive go in `jobs.js`, which the registry
schedules, and in `worker.js`, which runs on a thread of its own through
`runInWorker`. A worker opens its own SQLite connection — safe, because the
database is in WAL mode, where a writer does not block readers.

Weather is the documented exception, and `modules/weather/server.js` says why
it earns it.

## The manifest

```js
export default {
  id: 'example',
  label: 'Example',
  defaultEnabled: false,              // on a dashboard that has never heard of it
  server: () => import('./server.js'),
  jobs: () => import('./jobs.js'),
  hasPane: true,                      // it ships client/pane.js
  hasWorker: true,

  tiles: {
    example: {
      label: 'Example — something useful',
      singleton: true,                // at most one on a dashboard
      settings: (v, s, path) => ({    // validated by the module, not the core
        title: v.str(s.title, `${path}.title`, { max: 80, fallback: '' }),
      }),
    },
  },

  // The integrations.<id> block of the configuration. Omit it entirely for a
  // module with nothing to configure — see note/.
  settings: (v, raw, path) => ({
    refreshMinutes: v.num(raw.refreshMinutes, `${path}.refreshMinutes`, { min: 5, max: 720, fallback: 30 }),
  }),
};
```

There is no `enabled` field in `settings`. The switch lives in
`config.modules.<id>.enabled` and is the single answer to whether the feature
exists on this dashboard.

## The client

```js
import { api, el, id, state, moduleState } from '/assets/core/kernel.js';

const own = moduleState('example');   // this module's own state; nobody else's

export default {
  id: 'example',
  tiles: {
    example: {
      markup: (tile, index) => `<article …>`,
      open: (article, tile, event) => { … },   // a click on the card
    },
  },
  mounted() {},        // after a render — guard anything that must run once
  refresh() {},        // the data tick, and when the tab comes back
  navEntries() {},     // side-navigation entries this module contributes
  onResize() {},       // something it measured may have changed width
  onThemeChange() {},  // light and dark swapped
  closeViews() {},     // Escape, and signing out
  unmount() {},        // before a re-render: maps, observers, timers
};
```

Everything but `tiles` is optional; `modules/note/` has nothing else at all.
`/assets/core/kernel.js` is the whole surface the core promises — anything
not re-exported there is the core's own business and may change.

## What is served

Only `client/`, at `/modules/<id>/`, which is why the folder does not appear
in the URL. The manifest, the routes, the jobs and the worker sit beside it
and are reachable by nobody; `test/server.test.js` asserts it, path traversal
included.
