import { describe, expect, it, vi } from 'vitest';
import {
  type BundleStore,
  createDurableUploadPipeline,
  type DurableUploadPipeline,
  serializeBundle,
} from './durable-upload-pipeline';
import { BugseeError } from './errors';
import { runLaunchRecovery } from './launch-recovery';
import type { ReportMarker, ReportMarkerStore } from './report-marker-store';
import type { Bundle, UploadPipeline, UploadResult } from './transport';
import { QUEUE_OVERFLOW_CODE } from './upload-pipeline';

const env = {
  platform: { type: 'node' as const, version: '1' },
  runtime: { type: 'node' as const, version: '' },
  sdk: { version: '0', type: 'javascript' as const },
};

const bundle = (summary: string, reportId?: string): Bundle & { reportId?: string } => ({
  request: {
    type: 'crash',
    summary,
    severity: 3,
    source: { type: 'crash', mechanism: 'uncaught' },
    created_on: '2026-08-31T00:00:00Z',
    environment: env,
  } as never,
  body: new Uint8Array([1, 2, 3]),
  fileName: 'b.zip',
  ...(reportId !== undefined ? { reportId } : {}),
});

/** An in-memory BundleStore whose ops can be made to throw. */
function memStore(): BundleStore & { map: Map<string, Uint8Array>; failList?: boolean } {
  const map = new Map<string, Uint8Array>();
  const store = {
    map,
    failList: false,
    put: (id: string, bytes: Uint8Array) => void map.set(id, bytes),
    list: () => {
      if (store.failList) throw new Error('list exploded');
      return [...map.keys()];
    },
    read: (id: string) => map.get(id),
    remove: (id: string) => void map.delete(id),
  };
  return store;
}

/** A base pipeline recording every bundle it is asked to deliver. */
function recorder(result: UploadResult | (() => UploadResult) = { ok: true }) {
  const seen: string[] = [];
  const pipeline: UploadPipeline = {
    enqueue: vi.fn((b: Bundle) => {
      seen.push(String(b.request.summary));
      return Promise.resolve(typeof result === 'function' ? result() : result);
    }),
    flush: () => Promise.resolve(true),
    drop: vi.fn(),
  };
  return { seen, pipeline };
}

const marker = (id: string): ReportMarker =>
  ({
    generation: 1,
    request: { id, source: { type: 'crash' }, report: { id, type: 'crash', severity: 3 } },
    attributes: {},
    userIdentifier: null,
  }) as unknown as ReportMarker;

function markerStore(ids: string[]): Pick<ReportMarkerStore, 'list' | 'remove'> & {
  removed: string[];
} {
  let live = ids.map(marker);
  const removed: string[] = [];
  return {
    removed,
    list: () => live,
    remove: (id: string) => {
      removed.push(id);
      live = live.filter((m) => m.request.id !== id);
    },
  };
}

// core compiles without the DOM or node libs, so the host timer is reached through globalThis.
const host = globalThis as unknown as { setTimeout(f: () => void, ms: number): unknown };
/** Let every queued microtask AND one macrotask run — the pump fires from a completion handler. */
const settle = (): Promise<void> => new Promise((resolve) => host.setTimeout(() => resolve(), 5));

describe('runLaunchRecovery', () => {
  it('recovers a PER-INSTANCE queue up front, synchronously, before the scan starts', () => {
    // Node's store is synchronous fs, and `launch()` has always drained the own queue before
    // returning. Deferring it to a microtask would change when a crash bundle leaves the process.
    const store = memStore();
    store.put('b1', serializeBundle(bundle('own')));
    const { seen, pipeline } = recorder();
    const queue = createDurableUploadPipeline({ store, pipeline });
    let seenAtScanEntry: string[] | undefined;

    void runLaunchRecovery({
      queue,
      shared: false,
      pipeline,
      scan: () => {
        seenAtScanEntry = [...seen];
        return Promise.resolve();
      },
    });

    // Sampled INSIDE the scan, which `runLaunchRecovery` calls with no intervening await: the own
    // queue must already have been handed over. Moving that recover() after the scan, or behind an
    // await, empties this snapshot.
    expect(seenAtScanEntry).toEqual(['own']);
    expect(seen).toEqual(['own']);
    expect(store.map.size).toBe(1); // still staged until the attempt settles
  });

  it('does NOT recover a per-instance queue twice — the scan gets no reconciler', async () => {
    const store = memStore();
    store.put('b1', serializeBundle(bundle('own')));
    const { seen, pipeline } = recorder();
    const queue = createDurableUploadPipeline({ store, pipeline });
    const scan = vi.fn(() => Promise.resolve());

    await runLaunchRecovery({ queue, shared: false, pipeline, scan });
    await settle();

    expect(scan).toHaveBeenCalledWith(undefined); // nothing outside the layout to reconcile
    expect(seen).toEqual(['own']); // …and exactly one hand-over
  });

  it('holds a SHARED queue back until the scan has had first refusal, then releases the rest', async () => {
    const store = memStore();
    store.put('mine', serializeBundle(bundle('sibling-blob', 'inc1')));
    store.put('other', serializeBundle(bundle('unclaimed-blob', 'inc9')));
    const { seen, pipeline } = recorder();
    const queue = createDurableUploadPipeline({ store, pipeline });
    const markers = markerStore(['inc1']);
    let duringScan: string[] = [];

    await runLaunchRecovery({
      queue,
      shared: true,
      pipeline,
      scan: async (reconcile) => {
        expect(reconcile).toBeTypeOf('function');
        const skip = await reconcile?.(markers);
        duringScan = [...seen];
        expect([...(skip ?? [])]).toEqual(['inc1']); // the sibling's incident is now the blob's
      },
    });
    await settle();

    // Only the sibling's OWN blob went out during the scan; the unclaimed one waited for the release.
    expect(duringScan).toEqual(['sibling-blob']);
    expect(seen).toEqual(['sibling-blob', 'unclaimed-blob']);
    expect(markers.removed).toEqual(['inc1']); // its now-redundant marker retired
    expect(store.map.size).toBe(0); // both delivered → both freed
  });

  it('delivers recovered blobs through the BASE pipeline, NEVER back through the durable queue', async () => {
    // Routing a blob read out of this very store back through it re-stages a SECOND copy of the same
    // incident (`durable-upload-pipeline.ts` puts before it attempts), so a retryable failure leaves
    // two blobs on disk for one incident and the next launch uploads it twice. Documented in three
    // comments and, until now, in zero tests: `pipeline: base` → `pipeline: queue` survived every suite.
    const store = memStore();
    store.put('mine', serializeBundle(bundle('sibling-blob', 'inc1')));
    const { seen, pipeline } = recorder({ ok: false, error: new BugseeError('5xx', 503) });
    const queue = createDurableUploadPipeline({ store, pipeline, newId: () => 'RESTAGED' });
    const markers = markerStore(['inc1']);

    await runLaunchRecovery({
      queue,
      shared: true,
      pipeline,
      scan: async (reconcile) => void (await reconcile?.(markers)),
    });
    await settle();

    expect(seen).toEqual(['sibling-blob']); // attempted once…
    expect([...store.map.keys()]).toEqual(['mine']); // …and NOT re-staged under a new id
    expect(store.map.has('RESTAGED')).toBe(false);
    expect(markers.removed).toEqual([]); // retryable ⇒ both traces kept for the next launch
  });

  it('runs the release pass even when the scan REJECTS — the permanent-non-delivery bug', async () => {
    // `recoverInstances` is not throw-safe (an unreadable `owner.json` re-throws out of the loop), and
    // the release pass used to sit in a bare `.then()`. Because the trigger is persistent on-disk
    // state, the held-back blob was then never delivered on ANY launch.
    const store = memStore();
    store.put('other', serializeBundle(bundle('unclaimed-blob', 'inc9')));
    const { seen, pipeline } = recorder();
    const queue = createDurableUploadPipeline({ store, pipeline });
    const errors: unknown[] = [];

    await runLaunchRecovery({
      queue,
      shared: true,
      pipeline,
      onError: (e) => errors.push(e),
      scan: () => Promise.reject(new Error('EACCES owner.json')),
    });
    await settle();

    expect(seen).toEqual(['unclaimed-blob']); // released anyway
    expect(store.map.size).toBe(0);
    expect(String(errors[0])).toContain('EACCES');
  });

  it('never rejects when the scan rejects, so launch() cannot see an unhandled rejection', async () => {
    const { pipeline } = recorder();
    await expect(
      runLaunchRecovery({
        shared: false,
        pipeline,
        scan: () => Promise.reject(new Error('boom')),
      }),
    ).resolves.toBeUndefined();
  });

  it('awaits `whenReady` before reading a SHARED queue, in the reconciler and the release pass', async () => {
    const store = memStore();
    store.put('mine', serializeBundle(bundle('sibling-blob', 'inc1')));
    store.put('other', serializeBundle(bundle('unclaimed-blob')));
    const { seen, pipeline } = recorder();
    let hydrate = (): void => {};
    const whenReady = new Promise<void>((r) => {
      hydrate = r;
    });
    // A store that is EMPTY until its mirror hydrates — exactly what an IndexedDB-backed store does.
    let ready = false;
    const gated: BundleStore = {
      put: store.put,
      list: () => (ready ? store.list() : []),
      read: (id) => (ready ? store.read(id) : undefined),
      remove: store.remove,
    };
    const queue = createDurableUploadPipeline({ store: gated, pipeline });
    void whenReady.then(() => {
      ready = true;
    });

    const done = runLaunchRecovery({
      queue,
      shared: true,
      pipeline,
      whenReady,
      scan: async (reconcile) => void (await reconcile?.(markerStore(['inc1']))),
    });
    expect(seen).toEqual([]);
    hydrate();
    await done;
    await settle();

    expect(seen).toEqual(['sibling-blob', 'unclaimed-blob']);
  });

  it('awaits `whenReady` before recovering a PER-INSTANCE queue', async () => {
    const store = memStore();
    store.put('b1', serializeBundle(bundle('own')));
    const { seen, pipeline } = recorder();
    let hydrate = (): void => {};
    const whenReady = new Promise<void>((r) => {
      hydrate = r;
    });
    const queue = createDurableUploadPipeline({ store, pipeline });

    void runLaunchRecovery({
      queue,
      shared: false,
      pipeline,
      whenReady,
      scan: () => Promise.resolve(),
    });
    await settle();
    expect(seen).toEqual([]); // not read before the mirror hydrated

    hydrate();
    await settle();
    expect(seen).toEqual(['own']);
  });

  it('survives a REJECTING `whenReady` on every leg — an IndexedDB open failure is not an app error', async () => {
    // The browser SDK installs its own `unhandledrejection` listener, so an unguarded rejection here
    // is reported to the collector as the host application's crash.
    const { pipeline } = recorder();
    const store = memStore();
    const queue = createDurableUploadPipeline({ store, pipeline });
    const errors: unknown[] = [];
    const whenReady = Promise.reject(new Error('IDB open failed'));

    await expect(
      runLaunchRecovery({
        queue,
        shared: true,
        pipeline,
        whenReady,
        onError: (e) => errors.push(e),
        scan: async (reconcile) => void (await reconcile?.(markerStore([]))),
      }),
    ).resolves.toBeUndefined();
    await expect(
      runLaunchRecovery({
        queue,
        shared: false,
        pipeline,
        whenReady,
        onError: (e) => errors.push(e),
        scan: () => Promise.resolve(),
      }),
    ).resolves.toBeUndefined();
    await settle();

    expect(errors.map(String).filter((e) => e.includes('IDB open failed')).length).toBe(3);
  });

  it('does nothing but run the scan when the launch has no durable queue at all', async () => {
    const { pipeline } = recorder();
    const scan = vi.fn(() => Promise.resolve());
    await runLaunchRecovery({ shared: true, pipeline, scan });
    expect(scan).toHaveBeenCalledWith(undefined); // `shared` is meaningless without a queue
  });

  it('routes a throwing store to onError instead of out of the reconciler', async () => {
    const store = memStore();
    store.failList = true;
    const { pipeline } = recorder();
    const queue = createDurableUploadPipeline({ store, pipeline, onError: () => {} });
    let skip: ReadonlySet<string> | undefined;

    await runLaunchRecovery({
      queue,
      shared: true,
      pipeline,
      scan: async (reconcile) => {
        skip = await reconcile?.(markerStore(['inc1']));
      },
    });

    expect(skip).toEqual(new Set()); // the reconciler still answers, so the marker leg still runs
  });

  it('hands a blob DEFERRED by a selective pass to the pump after a capacity refusal', async () => {
    // The starvation fix: a selective pass holds another sibling's blob back from the pump so it
    // cannot go out unreconciled mid-scan. If the release pass then hands it over and the pipeline is
    // momentarily FULL (`queue_overflow`), the blob is neither `attempted` nor in flight — and while
    // it stayed marked deferred the pump skipped it for the rest of the launch, so it was delivered on
    // no launch at all until a restart.
    const store = memStore();
    store.put('mine', serializeBundle(bundle('sibling-blob', 'inc1')));
    store.put('other', serializeBundle(bundle('deferred-blob', 'inc9')));
    const seen: string[] = [];
    let full = true;
    const gate: Array<() => void> = [];
    const pipeline: UploadPipeline = {
      enqueue: (b: Bundle) => {
        const summary = String(b.request.summary);
        if (full && summary === 'deferred-blob') {
          full = false; // refuse it ONCE for capacity, then accept
          return Promise.resolve({
            ok: false,
            error: new BugseeError('upload queue overflow', QUEUE_OVERFLOW_CODE),
          });
        }
        seen.push(summary);
        return new Promise<UploadResult>((resolve) => {
          gate.push(() => resolve({ ok: true }));
        });
      },
      flush: () => Promise.resolve(true),
      drop: vi.fn(),
    };
    const queue = createDurableUploadPipeline({ store, pipeline });

    await runLaunchRecovery({
      queue,
      shared: true,
      pipeline,
      scan: async (reconcile) => void (await reconcile?.(markerStore(['inc1']))),
    });
    // Release the sibling blob's upload: its completion is what drives the pump.
    while (gate.length > 0) {
      gate.shift()?.();
      await settle();
    }

    expect(seen).toEqual(['sibling-blob', 'deferred-blob']);
    expect(store.map.size).toBe(0);
  });

  it('survives a queue whose own recover() THROWS, on every leg', async () => {
    // `createDurableUploadPipeline().recover()` guards itself, but the queue reaching here is an object
    // a PLATFORM constructed; recovery must not take `launch()` down because one of them did not.
    const hostile = {
      recover: () => {
        throw new Error('hostile queue');
      },
      enqueue: () => Promise.resolve({ ok: true }),
      flush: () => Promise.resolve(true),
      drop: () => {},
    } as unknown as DurableUploadPipeline;
    const { pipeline } = recorder();
    const errors: unknown[] = [];

    await expect(
      runLaunchRecovery({
        queue: hostile,
        shared: true,
        pipeline,
        onError: (e) => errors.push(e),
        scan: async (reconcile) => void (await reconcile?.(markerStore([]))),
      }),
    ).resolves.toBeUndefined();
    await expect(
      runLaunchRecovery({
        queue: hostile,
        shared: false,
        pipeline,
        onError: (e) => errors.push(e),
        scan: () => Promise.resolve(),
      }),
    ).resolves.toBeUndefined();

    // the reconciler's selective pass, the release pass, and the own-queue pass
    expect(errors.map(String).filter((e) => e.includes('hostile queue'))).toHaveLength(3);
  });

  it('exposes the reconciler as a plain callback the platform passes straight to its scan', async () => {
    // The seam the three launches used to each re-derive: they now receive it and forward it verbatim.
    const store = memStore();
    store.put('mine', serializeBundle(bundle('sibling-blob', 'inc1')));
    const { pipeline } = recorder();
    const queue: DurableUploadPipeline = createDurableUploadPipeline({ store, pipeline });
    let received: unknown;
    await runLaunchRecovery({
      queue,
      shared: true,
      pipeline,
      scan: (reconcile) => {
        received = reconcile;
        return Promise.resolve();
      },
    });
    expect(typeof received).toBe('function');
  });
});
