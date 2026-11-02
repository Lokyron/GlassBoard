/* Running a module's heavy work off the event loop.
 *
 * Node serves every request on one thread. A month of GPS positions is a
 * JSON.parse of several megabytes followed by a filter per ride over the whole
 * array; a mailbox scan is a hundred and fifty messages decoded and searched.
 * While either of those runs, nothing else on the instance is answered — not
 * another account's dashboard, not a configuration save, not the clock on the
 * page. That is the latency this exists to remove.
 *
 * One worker per module, started the first time that module has work and kept
 * afterwards: starting a thread costs more than most of these tasks do. The
 * worker opens its own SQLite connection, which is safe because the database
 * runs in WAL mode — readers are not blocked by the writer.
 *
 * Identical tasks are folded into one. Without that, a page load asking for
 * the tile and for the month at the same instant backfills the month twice. */
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MODULES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'modules');

/** A task that has not answered in this long is not going to. */
const TASK_TIMEOUT_MS = 120_000;

const workers = new Map();   // module id -> { worker, pending }
const inFlight = new Map();  // dedupe key -> promise

function spawn(moduleId) {
  const file = path.join(MODULES_DIR, moduleId, 'worker.js');
  if (!fs.existsSync(file)) throw new Error(`module "${moduleId}" has no worker`);

  const worker = new Worker(file);
  const pending = new Map();
  const entry = { worker, pending, nextId: 1 };

  worker.on('message', ({ id, ok, result, error }) => {
    const task = pending.get(id);
    if (!task) return;
    pending.delete(id);
    clearTimeout(task.timer);
    if (ok) task.resolve(result);
    else task.reject(Object.assign(new Error(error.message), { code: error.code ?? null }));
  });

  /* A worker that dies takes its outstanding tasks with it. They are rejected
     rather than left hanging, and the next task starts a fresh one. */
  const die = (reason) => {
    workers.delete(moduleId);
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error(reason));
    }
    pending.clear();
  };
  worker.on('error', (error) => die(`the ${moduleId} worker failed: ${error.message}`));
  worker.on('exit', (code) => { if (code !== 0) die(`the ${moduleId} worker exited with ${code}`); });

  // The worker must never be the reason the process stays alive.
  worker.unref();
  workers.set(moduleId, entry);
  return entry;
}

/**
 * Run a task in a module's worker.
 *
 * @param {string} moduleId
 * @param {object} task         passed to the worker as-is; must be structured-cloneable
 * @param {string} [dedupeKey]  tasks sharing a key share one run
 */
export function runInWorker(moduleId, task, dedupeKey = null) {
  if (dedupeKey && inFlight.has(dedupeKey)) return inFlight.get(dedupeKey);

  const entry = workers.get(moduleId) ?? spawn(moduleId);
  const id = entry.nextId++;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      reject(new Error(`the ${moduleId} worker did not answer in time`));
    }, TASK_TIMEOUT_MS);
    timer.unref?.();
    entry.pending.set(id, { resolve, reject, timer });
    // Referenced only while something is waiting on it, so an idle worker
    // does not hold the process open.
    entry.worker.ref();
    entry.worker.postMessage({ id, ...task });
  }).finally(() => {
    if (entry.pending.size === 0) entry.worker.unref();
    if (dedupeKey) inFlight.delete(dedupeKey);
  });

  if (dedupeKey) inFlight.set(dedupeKey, promise);
  return promise;
}

/** True while a given task is already running, so a caller can skip asking. */
export const isRunning = (dedupeKey) => inFlight.has(dedupeKey);

/** Shut every worker down. Used by the tests; the process exit does the rest. */
export async function stopWorkers() {
  await Promise.all([...workers.values()].map(({ worker }) => worker.terminate()));
  workers.clear();
  inFlight.clear();
}
