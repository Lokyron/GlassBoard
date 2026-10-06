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
});
