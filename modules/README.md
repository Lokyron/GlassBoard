# Modules

One folder per feature. The core knows the contract, never the feature.

```
modules/<id>/
  manifest.js      what the module is: its tiles, and the shape of its settings
  server.js        optional — routes(router), mounted at /api/m/<id>
  jobs.js          optional — background work, run off the request path
  worker.js        optional — the heavy half, run in a worker thread
  client/          served at /modules/<id>/ — tile.js, pane.js
```

**A route never makes an outgoing network call.** It reads what a job wrote.
That single rule is what keeps one slow upstream API from holding up the
dashboard — or, worse, from holding up the event loop for every account on
the instance.

Adding a module means creating the folder and listing it in
`server/modules/registry.js`. Nothing else in the core changes: the tile
types, the configuration schema, the settings tabs and the routes are all
composed from what the manifests declare.
