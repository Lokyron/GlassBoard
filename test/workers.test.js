/* The worker pool: that work really leaves the main thread, that identical
   tasks are folded into one, and that a failure comes back as a rejection
   rather than a hang. */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolate, removeDir } from './helpers.js';

const dir = isolate('workers');
const { runInWorker, isRunning, stopWorkers } = await import('../server/modules/workers.js');

/* A throwaway module beside the real ones: the pool resolves a worker by
   folder name, so exercising it needs a folder. */
const ROOT = path.resolve(import.meta.dirname, '..');
const fixture = path.join(ROOT, 'modules', '__test__');
fs.mkdirSync(fixture, { recursive: true });
fs.writeFileSync(path.join(fixture, 'worker.js'), `
import { serve } from '../../server/modules/worker-host.js';
import { threadId } from 'node:worker_threads';
serve({
  where: () => ({ threadId }),
  slow: async ({ ms }) => { await new Promise((r) => setTimeout(r, ms)); return { done: true }; },
  boom: () => { const e = new Error('on purpose'); e.code = 'expected'; throw e; },
});
`);

after(async () => {
  await stopWorkers();
  fs.rmSync(fixture, { recursive: true, force: true });
  removeDir(dir);
});

describe('runInWorker', () => {
  it('runs on another thread', async () => {
    const { threadId } = await runInWorker('__test__', { task: 'where' });
    assert.ok(threadId > 0, 'a worker thread, not the main one');
  });

  it('folds identical tasks into one run', async () => {
    const key = 'same';
    const first = runInWorker('__test__', { task: 'slow', ms: 80 }, key);
    const second = runInWorker('__test__', { task: 'slow', ms: 80 }, key);
    assert.equal(first, second, 'the very same promise, not two runs');
    assert.equal(isRunning(key), true);
    await first;
    assert.equal(isRunning(key), false, 'the key is released once it is done');
  });

  it('does not fold tasks that are not the same', async () => {
    const a = runInWorker('__test__', { task: 'slow', ms: 20 }, 'a');
    const b = runInWorker('__test__', { task: 'slow', ms: 20 }, 'b');
    assert.notEqual(a, b);
    await Promise.all([a, b]);
  });

  it('carries a failure back, with its code', async () => {
    await assert.rejects(
      () => runInWorker('__test__', { task: 'boom' }),
      (error) => error.message === 'on purpose' && error.code === 'expected'
    );
  });

  it('refuses an unknown task rather than going quiet', async () => {
    await assert.rejects(() => runInWorker('__test__', { task: 'nothing-like-this' }), /unknown task/);
  });

  it('says so when a module has no worker', () => {
    assert.throws(() => runInWorker('note', { task: 'anything' }), /no worker/);
  });

  /* The shipped workers, started for real. Each one pulls in the database,
     the crypto and its own integration on a thread of its own; anything in
     that graph that cannot load there — a browser-only global, a missing
     environment variable, a top-level await that never settles — shows up
     here and nowhere else until the feature is used in anger. */
  for (const moduleId of ['georide', 'parcels']) {
    it(`starts the ${moduleId} worker`, async () => {
      await assert.rejects(
        () => runInWorker(moduleId, { task: 'no-such-task' }),
        /unknown task/,
        'the worker loaded and answered'
      );
    });
  }

  it('keeps answering after a task failed', async () => {
    await runInWorker('__test__', { task: 'boom' }).catch(() => {});
    const { threadId } = await runInWorker('__test__', { task: 'where' });
    assert.ok(threadId > 0);
  });
});
