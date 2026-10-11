/* Weather — Open-Meteo forecasts for the browser's position, and for as many
   cities as the account cares to follow. No credential, no stored state: the
   lightest module there is, which is why it is the one the contract was shaped
   around.

   There used to be a second tile type for a followed city. One card per city
   does not scale past two, so the cities now live in the module's settings and
   the detailed panel picks between them; the dashboard keeps a single weather
   card, and it is always the one for where you are. */

/* A guard rather than a design limit: every city is one more forecast to
   fetch and cache, and a longer list stops being a row of choices and
   becomes a menu nobody reads. */
export const MAX_CITIES = 8;

export default {
  id: 'weather',
  label: 'Weather',
  labelKey: 'set.weather',
  defaultEnabled: true,
  server: () => import('./server.js'),
  // Its own tab in the settings, served from client/pane.js.
  hasPane: true,

  tiles: {
    'weather-local': {
      label: 'Weather',
      labelKey: 'tiletype.weather-local',
      singleton: true,
      settings: (v, s, path) => ({
        label: v.str(s.label, `${path}.label`, { max: 80, fallback: '' }),
      }),
    },
  },

  settings: (v, raw, path) => ({
    useBrowserGeolocation: v.bool(raw.useBrowserGeolocation, true),
    fallback: {
      latitude: v.num(raw.fallback?.latitude, `${path}.fallback.latitude`, { min: -90, max: 90, fallback: 48.8566 }),
      longitude: v.num(raw.fallback?.longitude, `${path}.fallback.longitude`, { min: -180, max: 180, fallback: 2.3522 }),
    },
    reverseGeocoding: v.bool(raw.reverseGeocoding, true),
    refreshMinutes: v.num(raw.refreshMinutes, `${path}.refreshMinutes`, { min: 5, max: 720, fallback: 30 }),
    /* The cities the detailed panel offers besides the current position. */
    cities: Array.isArray(raw.cities)
      ? raw.cities.slice(0, MAX_CITIES).map((city, i) => ({
        id: v.id(city?.id, `${path}.cities[${i}].id`, 'wxc'),
        name: v.str(city?.name, `${path}.cities[${i}].name`, { max: 80, fallback: '' }),
        latitude: v.num(city?.latitude, `${path}.cities[${i}].latitude`, { min: -90, max: 90, fallback: 0 }),
        longitude: v.num(city?.longitude, `${path}.cities[${i}].longitude`, { min: -180, max: 180, fallback: 0 }),
      })).filter((city) => city.name)
      : [],
  }),
};
