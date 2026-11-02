/* The weather settings tab.
 *
 * Shipped by the module rather than by the editor: the core's settings
 * dialog lists the tabs the enabled modules declare and knows nothing about
 * what is in them. */
import { el, svg, api, field, textInput, checkbox } from '/assets/core/kernel.js';

/* The same cap the manifest validates against. Repeated rather than imported:
   only client/ is served over HTTP, and the manifest deliberately is not. */
const MAX_CITIES = 8;

export function pane(draft) {
  const weather = draft.integrations.weather;
  weather.cities ??= [];
  const pane = el('div', { class: 'pane' });
  pane.appendChild(checkbox(t('set.useGeo'), weather.useBrowserGeolocation, (value) => { weather.useBrowserGeolocation = value; }));
  pane.appendChild(checkbox(t('set.reverse'), weather.reverseGeocoding, (value) => { weather.reverseGeocoding = value; }));
  pane.appendChild(field(t('set.fallbackLat'), textInput(weather.fallback.latitude, { type: 'number', step: '0.0001', oninput: (e) => { weather.fallback.latitude = Number(e.target.value); } })));
  pane.appendChild(field(t('set.fallbackLon'), textInput(weather.fallback.longitude, { type: 'number', step: '0.0001', oninput: (e) => { weather.fallback.longitude = Number(e.target.value); } })));
  pane.appendChild(field(t('set.refresh'), textInput(weather.refreshMinutes, { type: 'number', min: '5', max: '720', oninput: (e) => { weather.refreshMinutes = Number(e.target.value); } })));

  pane.appendChild(citiesSection(weather));
  return pane;
}

/* ------------------------------- the cities ------------------------------- */
/* A section of its own, and self-contained: it owns its search field, its
   results and its list, and touches nothing above it. What comes next on this
   tab — another provider, alerts, units — can be added beside it without
   reading a line of this. */

function citiesSection(weather) {
  const section = el('div', { class: 'wx-cities' });
  section.appendChild(el('h4', { class: 'pane-title', text: t('set.cities') }));
  section.appendChild(el('p', { class: 'fld-h', text: t('set.citiesIntro') }));

  const list = el('div', { class: 'sub-list' });
  const results = el('div', { class: 'wx-results', hidden: true });
  const status = el('div', { class: 'fld-h' });

  const search = textInput('', { placeholder: t('set.citiesSearch'), autocomplete: 'off', spellcheck: 'false' });

  const renderList = () => {
    list.innerHTML = '';
    if (weather.cities.length === 0) {
      list.appendChild(el('p', { class: 'fld-h', text: t('set.citiesEmpty') }));
    }
    weather.cities.forEach((city, index) => {
      list.appendChild(el('div', { class: 'sub-row' }, [
        el('span', { class: 'sub-ic', style: 'background:#5e5ce6', html: svg('buildings') }),
        el('span', { class: 'sub-tt', text: city.name }),
        el('span', { class: 'wx-coords', text: `${city.latitude.toFixed(2)}, ${city.longitude.toFixed(2)}` }),
        /* Order is the order the pastilles appear in, so it is worth being
           able to change without deleting and searching again. */
        el('button', {
          class: 'tinybtn', type: 'button', title: t('set.citiesUp'),
          'aria-label': t('set.citiesUp'),
          disabled: index === 0,
          // There is no caret-up in the icon set; this is the same glyph turned over.
          html: svg('caret-down', 'transform:rotate(180deg)'),
          onclick: () => { move(index, -1); },
        }),
        el('button', {
          class: 'tinybtn', type: 'button', title: t('set.citiesDown'),
          'aria-label': t('set.citiesDown'),
          disabled: index === weather.cities.length - 1,
          html: svg('caret-down'),
          onclick: () => { move(index, 1); },
        }),
        el('button', {
          class: 'tinybtn danger', type: 'button', title: t('edit.remove'),
          'aria-label': t('edit.remove'),
          html: svg('trash'),
          onclick: () => { weather.cities.splice(index, 1); renderList(); },
        }),
      ]));
    });
    search.disabled = weather.cities.length >= MAX_CITIES;
    status.textContent = search.disabled ? t('set.citiesFull', { n: MAX_CITIES }) : '';
  };

  const move = (index, by) => {
    const to = index + by;
    if (to < 0 || to >= weather.cities.length) return;
    const [city] = weather.cities.splice(index, 1);
    weather.cities.splice(to, 0, city);
    renderList();
  };

  const add = (place) => {
    const name = [place.name, place.region].filter(Boolean).join(', ');
    results.hidden = true;
    search.value = '';
    if (weather.cities.length >= MAX_CITIES) return;
    // Same coordinates twice would be two pastilles showing one forecast.
    const already = weather.cities.some(
      (city) => Math.abs(city.latitude - place.latitude) < 0.01 && Math.abs(city.longitude - place.longitude) < 0.01
    );
    if (already) {
      status.textContent = t('set.citiesAlready', { name });
      return;
    }
    weather.cities.push({
      id: `wxc-${Math.random().toString(36).slice(2, 10)}`,
      name,
      latitude: place.latitude,
      longitude: place.longitude,
    });
    renderList();
  };

  const renderResults = (places) => {
    results.innerHTML = '';
    if (places.length === 0) {
      results.appendChild(el('p', { class: 'fld-h', text: t('set.citiesNone') }));
    }
    places.forEach((place) => {
      const where = [place.region, place.country].filter(Boolean).join(' · ');
      results.appendChild(el('button', {
        class: 'wx-result', type: 'button',
        onclick: () => add(place),
      }, [
        el('span', { class: 'wx-result-name', text: place.name }),
        where ? el('span', { class: 'wx-result-where', text: where }) : null,
      ]));
    });
    results.hidden = false;
  };

  /* One request per pause in the typing, not per keystroke: the geocoder is
     somebody else's service, and a name is rarely finished in one letter.
     The sequence number is what keeps a slow answer to "Mon" from landing on
     top of the answer to "Montpellier". */
  let timer = null;
  let sequence = 0;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    const query = search.value.trim();
    if (query.length < 2) {
      results.hidden = true;
      return;
    }
    timer = setTimeout(async () => {
      const mine = ++sequence;
      status.textContent = t('set.citiesSearching');
      try {
        const payload = await api(`/api/m/weather/search?q=${encodeURIComponent(query)}`);
        if (mine !== sequence) return;
        status.textContent = '';
        renderResults(payload.results ?? []);
      } catch (error) {
        if (mine !== sequence) return;
        status.textContent = error.message;
        results.hidden = true;
      }
    }, 350);
  });
  // Enter on the first result is what a search field is expected to do.
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    results.querySelector('.wx-result')?.click();
  });

  section.appendChild(field(t('set.citiesSearch'), search, t('set.citiesSearchHint')));
  section.appendChild(results);
  section.appendChild(status);
  section.appendChild(list);
  renderList();
  return section;
}
