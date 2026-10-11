/* The validator is the one piece of the server that an arbitrary file is fed
   through: an import, a restored revision, an older document meeting a newer
   build. It must always hand back something the dashboard can render. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('schema');
const { validateConfig, migrateConfig, CONFIG_VERSION, TILE_TYPES } =
  await import('../server/config-schema.js');
const { defaultConfig } = await import('../server/default-config.js');

describe('validateConfig', () => {
  it('accepts the shipped default without a single complaint', () => {
    const result = validateConfig(defaultConfig());
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it('is idempotent: validating its own output changes nothing', () => {
    const once = validateConfig(defaultConfig()).value;
    const twice = validateConfig(once).value;
    // Ids are generated when missing, so a second pass that re-rolled them
    // would quietly break every reference the dashboard holds.
    assert.deepEqual(twice, once);
  });

  it('refuses anything that is not an object', () => {
    for (const input of [null, undefined, 42, 'config', [], true]) {
      const result = validateConfig(input);
      assert.equal(result.ok, false, `${JSON.stringify(input)} should be refused`);
      assert.equal(result.value, null);
    }
  });

  it('completes a document that is missing everything', () => {
    // This is the migration path: a configuration written by an older build
    // has none of the fields a newer one added.
    const result = validateConfig({});
    assert.ok(result.value, 'a usable document comes back');
    assert.equal(result.value.version, CONFIG_VERSION);
    assert.ok(Array.isArray(result.value.tiles));
    assert.ok(Array.isArray(result.value.links));
    assert.ok(result.value.site);
    assert.ok(result.value.integrations);
  });

  it('clamps a number that is out of range, and says so', () => {
    const result = validateConfig({ tiles: [{ type: 'note', span: 99 }] });
    assert.equal(result.ok, false);
    assert.equal(result.value.tiles[0].span, 4);
    assert.ok(result.errors.some((e) => e.includes('span')));
  });

  it('drops a tile whose type does not exist', () => {
    const result = validateConfig({ tiles: [{ type: 'stock-ticker' }, { type: 'note' }] });
    assert.equal(result.ok, false);
    assert.equal(result.value.tiles.length, 1);
    assert.equal(result.value.tiles[0].type, 'note');
  });

  it('keeps one tile of a singleton type', () => {
    const singleton = Object.keys(TILE_TYPES).find((type) => TILE_TYPES[type].singleton);
    const result = validateConfig({ tiles: [{ type: singleton }, { type: singleton }] });
    assert.equal(result.value.tiles.filter((t) => t.type === singleton).length, 1);
  });

  it('refuses a javascript: shortcut', () => {
    // The reason url() exists: a configuration file must not be able to
    // smuggle script into the page through a shortcut.
    const result = validateConfig({
      links: [{ title: 'Trap', url: 'javascript:alert(1)' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.value.links[0].url, '');
  });

  it('refuses a colour that is not #rrggbb', () => {
    const result = validateConfig({ links: [{ title: 'X', url: 'https://e.org', color: 'red' }] });
    assert.equal(result.ok, false);
    assert.match(result.value.links[0].color, /^#[0-9a-f]{6}$/);
  });

  it('does not nest a folder inside a folder', () => {
    const result = validateConfig({
      links: [{ title: 'Outer', items: [{ title: 'Inner', items: [{ title: 'Deep' }] }] }],
    });
    const inner = result.value.links[0].items[0];
    assert.equal(inner.items, undefined, 'the second level is a shortcut, not a folder');
  });
});

describe('migrateConfig', () => {
  it('throws on a document from a future version', () => {
    assert.throws(() => migrateConfig({ version: CONFIG_VERSION + 1 }));
  });

  it('carries an older document forward', () => {
    const migrated = migrateConfig({ version: 1, site: { title: 'Mine' } });
    assert.equal(migrated.version, CONFIG_VERSION);
  });

  /* Version 2 moved the followed city out of the tiles and into the weather
     settings. The tile type no longer exists, so without the migration the
     city would be dropped as an unknown type — which is the one outcome a
     migration is there to prevent. */
  describe('version 2: the followed city', () => {
    const v1 = () => ({
      version: 1,
      links: [],
      tiles: [
        { id: 'tile-local', type: 'weather-local', span: 1, settings: { label: '' } },
        {
          id: 'tile-city',
          type: 'weather-secondary',
          span: 1,
          settings: { name: 'Barcelona', latitude: 41.39, longitude: 2.16, timezone: 'Europe/Madrid' },
        },
      ],
    });

    it('becomes a city in the weather settings', () => {
      const migrated = migrateConfig(v1());
      assert.deepEqual(
        migrated.integrations.weather.cities.map(({ name, latitude, longitude }) => ({ name, latitude, longitude })),
        [{ name: 'Barcelona', latitude: 41.39, longitude: 2.16 }]
      );
    });

    it('leaves the dashboard with the one weather tile', () => {
      const migrated = migrateConfig(v1());
      assert.deepEqual(migrated.tiles.map((tile) => tile.type), ['weather-local']);
    });

    it('survives validation, city and all', () => {
      const { ok, value } = validateConfig(migrateConfig(v1()));
      assert.ok(ok, 'no error on a migrated document');
      assert.equal(value.integrations.weather.cities[0].name, 'Barcelona');
      assert.equal(value.tiles.length, 1);
    });

    it('does not keep a tile that was never filled in', () => {
      const migrated = migrateConfig({
        version: 1,
        tiles: [{ id: 't', type: 'weather-secondary', settings: { name: '', latitude: 0, longitude: 0 } }],
      });
      assert.deepEqual(migrated.integrations.weather.cities, []);
      assert.deepEqual(migrated.tiles, []);
    });

    it('is idempotent, because it runs on every read', () => {
      const once = migrateConfig(v1());
      const twice = migrateConfig(JSON.parse(JSON.stringify(once)));
      assert.deepEqual(twice.integrations.weather.cities, once.integrations.weather.cities);
    });

    it('leaves a document that never had one alone', () => {
      const migrated = migrateConfig({ version: 1, tiles: [{ id: 'n', type: 'note' }] });
      assert.equal(migrated.integrations, undefined);
    });
  });
});

describe('the weather cities', () => {
  const cities = (raw) => validateConfig({ integrations: { weather: { cities: raw } } }).value.integrations.weather.cities;

  it('defaults to none', () => {
    assert.deepEqual(validateConfig({}).value.integrations.weather.cities, []);
  });

  it('keeps a well-formed entry and gives it an id', () => {
    const [city] = cities([{ name: 'Oslo', latitude: 59.91, longitude: 10.75 }]);
    assert.equal(city.name, 'Oslo');
    assert.ok(city.id, 'an entry without an id is given one');
  });

  it('drops an entry with no name, since nothing could label its button', () => {
    assert.deepEqual(cities([{ latitude: 1, longitude: 2 }]), []);
  });

  it('caps the list rather than storing a hundred forecasts', () => {
    const many = Array.from({ length: 30 }, (unused, i) => ({ name: `City ${i}`, latitude: 1, longitude: 2 }));
    assert.equal(cities(many).length, 8);
  });

  it('refuses a coordinate off the globe', () => {
    const result = validateConfig({ integrations: { weather: { cities: [{ name: 'Nowhere', latitude: 999, longitude: 0 }] } } });
    assert.equal(result.ok, false);
    assert.equal(result.value.integrations.weather.cities[0].latitude, 90, 'clamped, and reported');
  });
});
