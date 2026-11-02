/* Proxmox VE — the health of a hypervisor and the guests running on it.

   Read-only by design, and not merely by omission: the token Glassboard asks
   for is an audit token, every call is a GET, and there is no route that could
   start or stop anything. A dashboard left open on a phone cannot turn a
   homelab off by being sat on. */
export default {
  id: 'pve',
  label: 'Proxmox',
  labelKey: 'set.pve',
  defaultEnabled: false,
  server: () => import('./server.js'),
  // Its own tab in the settings, served from client/pane.js.
  hasPane: true,
  jobs: () => import('./jobs.js'),

  tiles: {
    pve: {
      label: 'Proxmox — node health and guests',
      labelKey: 'tiletype.pve',
      singleton: true,
      // Everything this tile shows comes from the integration settings, which
      // are per account rather than per tile.
      settings: () => ({}),
    },
  },

  settings: (v, raw, path) => ({
    /* The host on its own: no scheme and no path. A Proxmox API lives at a
       fixed path on a fixed port, and letting a URL in here would let it
       carry one of its own. */
    host: v.str(raw.host, `${path}.host`, { max: 200, fallback: '' }).trim(),
    port: v.num(raw.port, `${path}.port`, { min: 1, max: 65535, fallback: 8006 }),
    /* Off by default. Almost every Proxmox host signs its own certificate, so
       almost everybody will turn this on — but they will turn it on knowing
       they did, having read the error that says why. */
    allowSelfSigned: v.bool(raw.allowSelfSigned, false),
    /* Which node the card shows. Empty means the first one, which is the
       right answer for the standalone host most people run. */
    node: v.str(raw.node, `${path}.node`, { max: 80, fallback: '' }),
    refreshMinutes: v.num(raw.refreshMinutes, `${path}.refreshMinutes`, { min: 1, max: 60, fallback: 2 }),
  }),
};
