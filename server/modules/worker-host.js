/* The other side of runInWorker, so a module's worker.js is only its tasks.
 *
 *   import { serve } from '../../server/modules/worker-host.js';
 *   serve({ async sync({ userId }) { ... } });
 *
 * Every task is answered, success or failure: a worker that silently drops a
 * message leaves the main thread waiting for its timeout. */
import { parentPort } from 'node:worker_threads';

export function serve(tasks) {
  parentPort.on('message', async ({ id, task, ...payload }) => {
    try {
      const handler = tasks[task];
      if (!handler) throw new Error(`unknown task "${task}"`);
      parentPort.postMessage({ id, ok: true, result: await handler(payload) });
    } catch (error) {
      parentPort.postMessage({
        id,
        ok: false,
        error: { message: error.message, code: error.code ?? null },
      });
    }
  });
}
