// The configuration a brand-new instance starts with.
// Deliberately neutral: no real service, no personal coordinates, no account.
import { CONFIG_VERSION } from './config-schema.js';

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    site: {
      title: 'Dashboard',
      subtitle: 'Home',
      greeting: '',
      sectionTitle: '',
      locale: 'en',
      clockTimezone: 'UTC',
      clockLabel: 'UTC',
    },
    search: {
      enabled: true,
      action: 'https://duckduckgo.com/',
      param: 'q',
      placeholder: '',
      newTab: true,
    },
    tiles: [
      { id: 'tile-weather-local', type: 'weather-local', span: 1.1, settings: { label: '' } },
      {
        id: 'tile-welcome',
        type: 'note',
        span: 1,
        settings: {
          heading: 'Welcome to Glassboard',
          body: 'Switch to edit mode with the pencil button in the top bar to add your own shortcuts, tiles and integrations. Nothing here is hard-coded.',
        },
      },
    ],
    links: [
      { id: 'lnk-example-1', title: 'Router', url: 'http://192.168.1.1/', color: '#0a84ff', icon: 'wifi-high' },
      { id: 'lnk-example-2', title: 'Documentation', url: 'https://example.org/', color: '#5e5ce6', icon: 'notebook' },
      {
        id: 'lnk-example-folder',
        title: 'Example folder',
        color: '#ea580c',
        icon: 'folder',
        items: [
          { id: 'sub-example-1', title: 'First link', url: 'https://example.org/one', color: '#ea580c', icon: 'link' },
          { id: 'sub-example-2', title: 'Second link', url: 'https://example.org/two', color: '#f97316', icon: 'link' },
        ],
      },
    ],
    integrations: {
      weather: {
        enabled: true,
        useBrowserGeolocation: true,
        fallback: { latitude: 48.8566, longitude: 2.3522 },
        reverseGeocoding: true,
        refreshMinutes: 30,
      },
      georide: {
        enabled: false,
        trackerId: null,
        trackerName: '',
        periodDays: 7,
        refreshMinutes: 5,
        showMap: true,
      },
    },
  };
}
