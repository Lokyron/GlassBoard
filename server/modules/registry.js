/* The module registry.
 *
 * Everything the core used to know about a feature by name — its tile types,
 * the shape of its settings, its routes, its background work — is now declared
 * by the feature itself and composed here. The core knows the contract; it
 * does not know that weather or parcels exist.
 *
 * The list below is explicit rather than a directory scan. These modules ship
 * with Glassboard, so there is nothing to discover at runtime, and a static
 * import list is one that a reader (and the module resolver) can follow. */
import weather from '../../modules/weather/manifest.js';
import georide from '../../modules/georide/manifest.js';
import parcels from '../../modules/parcels/manifest.js';
import note from '../../modules/note/manifest.js';

export const MODULES = [weather, georide, parcels, note];

const byId = new Map(MODULES.map((module) => [module.id, module]));
export const getModule = (id) => byId.get(id) ?? null;

/**
 * Every tile type on the instance, as the renderer and the validator see it.
 * Carries the module id, which is what lets a tile be traced back to the
 * settings and the switch that govern it.
 */
export const TILE_TYPES = Object.fromEntries(
  MODULES.flatMap((module) =>
    Object.entries(module.tiles ?? {}).map(([type, tile]) => [
      type,
      {
        label: tile.label,
        singleton: Boolean(tile.singleton),
        module: module.id,
        // Kept under its old name: this is what the editor reads to decide
        // whether a tile has an integration to configure.
        integration: module.settings ? module.id : null,
      },
    ])
  )
);

/** The module a tile type belongs to, or null for a type nobody declares. */
export const moduleOfTile = (type) => getModule(TILE_TYPES[type]?.module) ?? null;

/**
 * The `integrations` block of the configuration, assembled from each module
 * that has settings. A module with none contributes nothing, rather than an
 * empty object nobody reads.
 */
export function validateIntegrations(v, raw) {
  const integrations = {};
  for (const module of MODULES) {
    if (!module.settings) continue;
    integrations[module.id] = module.settings(v, raw?.[module.id] ?? {}, `integrations.${module.id}`);
  }
  return integrations;
}

/** A tile's own settings, validated by the module that declares the type. */
export function validateTileSettings(v, type, raw, path) {
  const tile = moduleOfTile(type)?.tiles?.[type];
  return tile?.settings ? tile.settings(v, raw ?? {}, path) : {};
}

/* ------------------------------- mounting -------------------------------- */

/**
 * Give every module that has them its own router under /api/m/<id>, and serve
 * its client/ folder at /modules/<id>/.
 *
 * Only client/ is exposed. A module's manifest, routes, jobs and worker sit
 * beside it in the same folder and are never reachable over HTTP.
 */
export async function mountModules(app, { express, requireAuth, modulesDir, path, staticOptions }) {
  for (const module of MODULES) {
    if (module.server) {
      const router = express.Router();
      router.use(requireAuth);
      const loaded = await module.server();
      loaded.routes(router);
      app.use(`/api/m/${module.id}`, router);
    }
    app.use(
      `/modules/${module.id}`,
      express.static(path.join(modulesDir, module.id, 'client'), { ...staticOptions, index: false })
    );
  }
}

/* -------------------------------- jobs ----------------------------------- */

/**
 * Start every module's background work.
 *
 * This is what took the network and the parsing off the request path. A tile
 * no longer triggers the work it needs and then waits for it; the job has
 * already done it, and the route reads the result.
 *
 * A job that throws is reported and skipped. Nothing here may stop the server,
 * and one module's upstream being down is not the other modules' problem.
 */
export async function startModuleJobs() {
  const timers = [];
  for (const module of MODULES) {
    if (!module.jobs) continue;
    const jobs = (await module.jobs()).default;
    for (const job of jobs) {
      const run = async () => {
        try {
          await job.run();
        } catch (error) {
          console.warn(`[glassboard] ${module.id}: job "${job.name}" failed — ${error.message}`);
        }
      };
      const timer = setInterval(run, Math.max(1, job.everyMinutes) * 60_000);
      // Background work must never be the reason the process stays alive.
      timer.unref?.();
      timers.push(timer);
      // Once at start-up too, so a restart does not leave the dashboard on
      // whatever was on disk until the first interval comes round.
      run();
    }
  }
  return timers;
}
