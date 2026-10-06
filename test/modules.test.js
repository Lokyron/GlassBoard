/* The registry: what the core composes out of the manifests, and the
   guarantees a module may rely on. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isolate } from './helpers.js';

isolate('modules');
const registry = await import('../server/modules/registry.js');
const { validateConfig } = await import('../server/config-schema.js');

describe('the module list', () => {
  it('gives every module a unique id', () => {
    const ids = registry.MODULES.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('declares at least one tile per module', () => {
    for (const module of registry.MODULES) {
      assert.ok(Object.keys(module.tiles ?? {}).length > 0, `${module.id} declares a tile`);
    }
  });

  it('does not let two modules claim the same tile type', () => {
    const types = registry.MODULES.flatMap((m) => Object.keys(m.tiles ?? {}));
    assert.equal(new Set(types).size, types.length);
  });
});

describe('composed tile types', () => {
  it('carries the label, the singleton rule and the owning module', () => {
    const local = registry.TILE_TYPES['weather-local'];
    assert.equal(local.module, 'weather');
    assert.equal(local.singleton, true);
    assert.ok(local.label);
  });

  it('marks a module without settings as having no integration', () => {
    assert.equal(registry.TILE_TYPES.note.integration, null);
    assert.equal(registry.TILE_TYPES['weather-local'].integration, 'weather');
  });

  it('traces a tile type back to its module', () => {
    assert.equal(registry.moduleOfTile('parcels').id, 'parcels');
    assert.equal(registry.moduleOfTile('nothing-like-this'), null);
  });
});

describe('composed configuration', () => {
  it('gives every module with settings a block of its own', () => {
    const { value } = validateConfig({});
    for (const module of registry.MODULES) {
      if (module.settings) assert.ok(value.integrations[module.id], `${module.id} has a block`);
      else assert.equal(value.integrations[module.id], undefined, `${module.id} contributes none`);
    }
  });

  it('leaves no "enabled" field behind in a module\'s settings', () => {
    /* The switch lives in config.modules.<id>.enabled and nowhere else. A
       leftover integrations.<id>.enabled would be a second answer to the same
       question — and a handler still reading it would see undefined and treat
       a switched-on module as off, which is exactly what happened to the
       GeoRide trips route. */
    const { value } = validateConfig({});
    for (const [moduleId, settings] of Object.entries(value.integrations)) {
      assert.equal(settings.enabled, undefined, `integrations.${moduleId}.enabled must not exist`);
      assert.equal(typeof value.modules[moduleId]?.enabled, 'boolean', `modules.${moduleId}.enabled must`);
    }
  });

  it('lets a module validate its own tile settings', () => {
    const { value } = validateConfig({
      tiles: [{ type: 'note', settings: { heading: 'x'.repeat(500), body: 'kept' } }],
    });
    assert.equal(value.tiles[0].settings.heading.length, 80, 'the module’s own bound applied');
    assert.equal(value.tiles[0].settings.body, 'kept');
  });

  it('drops settings a module does not declare', () => {
    const { value } = validateConfig({
      tiles: [{ type: 'note', settings: { heading: 'A', smuggled: 'should not survive' } }],
    });
    assert.equal(value.tiles[0].settings.smuggled, undefined);
  });
});
