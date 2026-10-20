import type { TraceProducer } from '@bugsee/capture';
import { resetStorageTracker, StorageTracker } from '@bugsee/trackers/browser';
import { describe, expect, it, vi } from 'vitest';
import {
  type BrowserTraceEnv,
  createBrowserSystemTraceProducers,
  StorageProducer,
} from './trace-producers';

type Row = { name: string; value: unknown; hold: boolean | undefined };
const MB = 1024 * 1024;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function start(p: TraceProducer) {
  const out: Row[] = [];
  p.start({
    emit: (name: string, value: unknown, _d?: number, o?: { hold?: boolean }) =>
      void out.push({ name, value, hold: o?.hold }),
  });
  return out;
}

const storageOf = (usage: unknown, quota: unknown, persisted: unknown = true) => ({
  estimate: vi.fn(() => Promise.resolve({ usage, quota })),
  persisted: () => Promise.resolve(persisted),
});
const trackerOf = (storage: ReturnType<typeof storageOf> | undefined) =>
  new StorageTracker({
    navigator: { storage },
    scheduler: { setInterval: () => 1, clearInterval: () => {} },
  });

describe('StorageProducer', () => {
  it('emits storage_estimate {usage, quota} in integer MB (floored), held', async () => {
    const out = start(new StorageProducer(trackerOf(storageOf(5 * MB + 999, 3 * MB - 1))));
    await flush();
    expect(out).toEqual([{ name: 'storage_estimate', value: { usage: 5, quota: 2 }, hold: true }]);
  });

  it('omits a key the tracker omitted (never 0), and a persisted-only estimate emits nothing', async () => {
    const a = start(new StorageProducer(trackerOf(storageOf(Number.NaN, 7 * MB))));
    const b = start(new StorageProducer(trackerOf(storageOf(-1, null))));
    const c = start(new StorageProducer(trackerOf(storageOf(2 * MB, undefined))));
    await flush();
    expect(a.map((r) => r.value)).toEqual([{ quota: 7 }]);
    expect(b).toEqual([]);
    expect(c.map((r) => r.value)).toEqual([{ usage: 2 }]);
  });

  it('a genuine 0 usage is a 0, not an omission', async () => {
    const out = start(new StorageProducer(trackerOf(storageOf(0, 10 * MB))));
    await flush();
    expect(out.map((r) => r.value)).toEqual([{ usage: 0, quota: 10 }]);
  });

  it('de-duplicates an unchanged estimate and emits a changed one', async () => {
    let tick: () => void = () => {};
    const storage = storageOf(MB, 9 * MB);
    const tracker = new StorageTracker({
      navigator: { storage },
      scheduler: {
        setInterval: (cb) => {
          tick = cb;
          return 1;
        },
        clearInterval: () => {},
      },
    });
    const out = start(new StorageProducer(tracker));
    await flush();
    tick(); // same numbers again
    await flush();
    expect(out).toHaveLength(1);
    storage.estimate.mockImplementation(() => Promise.resolve({ usage: 2 * MB, quota: 9 * MB }));
    tick();
    await flush();
    expect(out.map((r) => r.value)).toEqual([
      { usage: 1, quota: 9 },
      { usage: 2, quota: 9 },
    ]);
  });

  it('publishes the retained estimate at start when another subscriber already polled', async () => {
    const tracker = trackerOf(storageOf(4 * MB, 8 * MB));
    const offOther = tracker.on('storageEstimate', () => {});
    await flush();
    const out = start(new StorageProducer(tracker));
    expect(out.map((r) => r.value)).toEqual([{ usage: 4, quota: 8 }]);
    offOther();
  });

  it('does NOT seed from a retained estimate older than 2x the poll interval (a held value would age forever)', async () => {
    const clock = { t: 0 };
    const mk = () =>
      new StorageTracker({
        navigator: { storage: storageOf(4 * MB, 8 * MB) },
        scheduler: { setInterval: () => 1, clearInterval: () => {} },
        intervalMs: 1000,
        now: () => clock.t,
      });
    const fresh = mk();
    const offFresh = fresh.on('storageEstimate', () => {});
    await flush();
    offFresh();
    clock.t = 2000; // exactly 2x: still fresh
    expect(start(new StorageProducer(fresh)).map((r) => r.value)).toEqual([{ usage: 4, quota: 8 }]);

    const stale = mk();
    clock.t = 0;
    const offStale = stale.on('storageEstimate', () => {});
    await flush();
    offStale();
    clock.t = 2001;
    const out = start(new StorageProducer(stale));
    expect(out).toEqual([]); // nothing seeded synchronously ...
    await flush();
    expect(out.map((r) => r.value)).toEqual([{ usage: 4, quota: 8 }]); // ... the new poll supplies the value
  });

  it('stop releases the subscription (and the tracker timer), and a late estimate writes nothing', async () => {
    const clear = vi.fn();
    const tracker = new StorageTracker({
      navigator: { storage: storageOf(MB, MB) },
      scheduler: { setInterval: () => 7, clearInterval: clear },
    });
    const p = new StorageProducer(tracker);
    const out = start(p);
    p.stop();
    await flush();
    expect(clear).toHaveBeenCalledWith(7);
    expect(out).toEqual([]);
  });

  it('stop before start is harmless', () => {
    expect(() => new StorageProducer(trackerOf(undefined)).stop()).not.toThrow();
  });
});

describe('createBrowserSystemTraceProducers storage wiring', () => {
  const env = (navigator: object | undefined, extra: Partial<BrowserTraceEnv> = {}) => {
    const window = { addEventListener() {}, removeEventListener() {} };
    return {
      window,
      env: {
        window,
        ...(navigator !== undefined ? { navigator } : {}),
        ...extra,
      } as BrowserTraceEnv,
    };
  };

  it('builds a storage producer from the env navigator, over the per-window singleton', async () => {
    const { window, env: e } = env({ storage: storageOf(3 * MB, 6 * MB) });
    const producers = createBrowserSystemTraceProducers(e);
    const p = producers.find((x) => x.name === 'storage');
    expect(p).toBeInstanceOf(StorageProducer);
    const out = start(p as TraceProducer);
    await flush();
    expect(out.map((r) => r.value)).toEqual([{ usage: 3, quota: 6 }]);
    // a second build for the same WINDOW shares the tracker (and its retained estimate), whatever navigator it is given
    const again = createBrowserSystemTraceProducers({
      ...e,
      navigator: { storage: storageOf(99 * MB, 99 * MB) },
    }).find((x) => x.name === 'storage');
    expect(start(again as TraceProducer).map((r) => r.value)).toEqual([{ usage: 3, quota: 6 }]);
    // a different window with the SAME navigator is a different tracker: nothing retained to seed from
    const other = { addEventListener() {}, removeEventListener() {} };
    const elsewhere = createBrowserSystemTraceProducers({ ...e, window: other }).find(
      (x) => x.name === 'storage',
    );
    expect(start(elsewhere as TraceProducer)).toEqual([]);
    resetStorageTracker({ window: other });
    resetStorageTracker({ window });
  });

  it('is not built when sensors are replaced by a systemMetricsSampler (sensors:false)', () => {
    const { window, env: e } = env({ storage: storageOf(1, 1) }, { sensors: false });
    expect(createBrowserSystemTraceProducers(e).map((x) => x.name)).toEqual(['battery']);
    resetStorageTracker({ window });
  });

  it('passes the document and scheduler through and reports failures to onError', async () => {
    const boom = new Error('denied');
    const added: string[] = [];
    const document = {
      visibilityState: 'visible',
      addEventListener: (t: string) => void added.push(t),
      removeEventListener: () => {},
    };
    const periods: number[] = [];
    const scheduler = {
      setInterval: (_cb: () => void, ms: number) => {
        periods.push(ms);
        return 1;
      },
      clearInterval: () => {},
    };
    const onError = vi.fn();
    const { window, env: e } = env(
      { storage: { estimate: () => Promise.reject(boom) } },
      { document, scheduler },
    );
    const p = createBrowserSystemTraceProducers(e, onError).find((x) => x.name === 'storage');
    start(p as TraceProducer);
    await flush();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(added).toContain('visibilitychange');
    expect(periods).toContain(300_000);
    resetStorageTracker({ window });
  });

  it('without a navigator nothing is sampled and nothing throws', async () => {
    const { window, env: e } = env(undefined);
    const p = createBrowserSystemTraceProducers(e).find((x) => x.name === 'storage');
    const out = start(p as TraceProducer);
    await flush();
    expect(out).toEqual([]);
    resetStorageTracker({ window });
  });
});
