/* Weather — Open-Meteo forecasts for the browser's position and for one
   followed city. No credential, no stored state: the lightest module there
   is, which is why it is the one the contract was shaped around. */
export default {
  id: 'weather',
  label: 'Weather',
  server: () => import('./server.js'),

  tiles: {
    'weather-local': {
      label: 'Weather — current position',
      singleton: true,
      settings: (v, s, path) => ({
        label: v.str(s.label, `${path}.label`, { max: 80, fallback: '' }),
      }),
    },
    'weather-secondary': {
      label: 'Weather — followed city',
      singleton: true,
      settings: (v, s, path) => ({
        name: v.str(s.name, `${path}.name`, { max: 80, fallback: '' }),
        latitude: v.num(s.latitude, `${path}.latitude`, { min: -90, max: 90, fallback: 0 }),
        longitude: v.num(s.longitude, `${path}.longitude`, { min: -180, max: 180, fallback: 0 }),
        timezone: v.str(s.timezone, `${path}.timezone`, { max: 60, fallback: 'Europe/Paris' }),
      }),
    },
  },

  settings: (v, raw, path) => ({
    enabled: v.bool(raw.enabled, true),
    useBrowserGeolocation: v.bool(raw.useBrowserGeolocation, true),
    fallback: {
      latitude: v.num(raw.fallback?.latitude, `${path}.fallback.latitude`, { min: -90, max: 90, fallback: 48.8566 }),
      longitude: v.num(raw.fallback?.longitude, `${path}.fallback.longitude`, { min: -180, max: 180, fallback: 2.3522 }),
    },
    reverseGeocoding: v.bool(raw.reverseGeocoding, true),
    refreshMinutes: v.num(raw.refreshMinutes, `${path}.refreshMinutes`, { min: 5, max: 720, fallback: 30 }),
  }),
};
