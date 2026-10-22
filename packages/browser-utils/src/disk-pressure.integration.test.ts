import 'fake-indexeddb/auto';
import { createDiskPressure, type PartRef, withDiskPressure } from '@bugsee/core';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { type AsyncKeyedStore, createIdbKeyedStore } from './idb';
import { createIdbChunkBackend } from './idb-chunk-backend';

// The pressure-aware wrapper over the REAL IndexedDB backend (fake-indexeddb): what the unit tests prove with mocks, end to end.
const ref = (n: number): PartRef => ({ generation: 1, number: n });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function rig(readTimeoutMs = 200) {
  const inner = createIdbKeyedStore({ indexedDB: new IDBFactory() });
  const hang = { on: false };
  const store: AsyncKeyedStore = {
    ...inner,
    readPrefix: (p) => (hang.on ? new Promise(() => {}) : inner.readPrefix(p)),
  };
  const errors: unknown[] = [];
  const idb = createIdbChunkBackend(store, { generation: 1, cleanOtherGenerations: false });
  const backend = withDiskPressure(idb, createDiskPressure(), {
    readTimeoutMs,
    onReadError: (e) => errors.push(e),
  });
  return { inner, hang, errors, backend };
}

describe('wrapper + real IndexedDB backend: a read left to finish in the background', () => {
  it('unpin() leaves the READ running: four reports against a hung store are one streak, and the next one waits 2 s, not the backstop', async () => {
    const r = rig();
    r.backend.openPart(ref(0), 0);
    r.backend.appendEntry(ref(0), { type: 'log', timestamp: 0, serialized: 'x' });
    await r.backend.flush?.();
    r.hang.on = true;
    for (let i = 0; i < 4; i++) {
      const s = r.backend.snapshot([{ ref: ref(0), count: 1 }]);
      await s.drainAll();
      s.release();
      await sleep(20);
    }
    expect(r.errors.length).toBe(1); // a cancelled read is not an answer: the streak is not ended and re-reported
  }, 20_000);

  it('eviction while a read is backgrounded deletes the part at once (the wrapper calls unpin on the backend snapshot)', async () => {
    const r = rig();
    r.backend.openPart(ref(0), 0);
    r.backend.appendEntry(ref(0), { type: 'log', timestamp: 0, serialized: 'x' });
    await r.backend.flush?.();
    r.hang.on = true;
    const s = r.backend.snapshot([{ ref: ref(0), count: 1 }]);
    await s.drainAll(); // overruns at 200 ms: backgrounded, the report is answered from memory
    r.backend.removePart(ref(0));
    await r.backend.flush?.();
    expect((await r.inner.readPrefix('d/')).length).toBe(0); // deleted although the hung read is still alive
    s.release();
  }, 20_000);
});
