/* GeoRide — a motorcycle tracker: its position, its weekly figures and a month
   of rides. The heavy module, and the reason the contract keeps the network
   off the request path. */
export default {
  id: 'georide',
  label: 'GeoRide',
  server: () => import('./server.js'),
  jobs: () => import('./jobs.js'),
  hasWorker: true,

  tiles: {
    georide: {
      label: 'GeoRide — weekly stats and map',
      singleton: true,
      // Everything this tile shows is governed by the integration settings,
      // which are per account rather than per tile.
      settings: () => ({}),
    },
  },

  settings: (v, raw, path) => ({
    enabled: v.bool(raw.enabled, false),
    trackerId:
      raw.trackerId === null || raw.trackerId === undefined
        ? null
        : v.num(raw.trackerId, `${path}.trackerId`, { min: 1, max: 1e12, fallback: null }),
    trackerName: v.str(raw.trackerName, `${path}.trackerName`, { max: 80, fallback: '' }),
    // 31 and not 30: it is the retention the store keeps, and the detail view
    // may ask for all of it.
    periodDays: v.num(raw.periodDays, `${path}.periodDays`, { min: 1, max: 31, fallback: 7 }),
    refreshMinutes: v.num(raw.refreshMinutes, `${path}.refreshMinutes`, { min: 1, max: 720, fallback: 5 }),
    showMap: v.bool(raw.showMap, true),
  }),
};
