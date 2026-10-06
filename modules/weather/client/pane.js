/* The weather settings tab.
 *
 * Shipped by the module rather than by the editor: the core's settings
 * dialog lists the tabs the enabled modules declare and knows nothing about
 * what is in them. */
import { el, field, textInput, checkbox } from '/assets/core/kernel.js';

export function pane(draft) {
  const weather = draft.integrations.weather;
  const pane = el('div', { class: 'pane' });
  pane.appendChild(checkbox(t('set.useGeo'), weather.useBrowserGeolocation, (value) => { weather.useBrowserGeolocation = value; }));
  pane.appendChild(checkbox(t('set.reverse'), weather.reverseGeocoding, (value) => { weather.reverseGeocoding = value; }));
  pane.appendChild(field(t('set.fallbackLat'), textInput(weather.fallback.latitude, { type: 'number', step: '0.0001', oninput: (e) => { weather.fallback.latitude = Number(e.target.value); } })));
  pane.appendChild(field(t('set.fallbackLon'), textInput(weather.fallback.longitude, { type: 'number', step: '0.0001', oninput: (e) => { weather.fallback.longitude = Number(e.target.value); } })));
  pane.appendChild(field(t('set.refresh'), textInput(weather.refreshMinutes, { type: 'number', min: '5', max: '720', oninput: (e) => { weather.refreshMinutes = Number(e.target.value); } })));
  return pane;
}
