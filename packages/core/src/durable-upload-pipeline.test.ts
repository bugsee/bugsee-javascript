import { type EnvironmentEnvelope, type RequestJson, Severity } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  type BundleStore,
  createDurableUploadPipeline,
  deserializeBundle,
  serializeBundle,
} from './durable-upload-pipeline';
import { BugseeError } from './errors';
import type { Bundle, UploadPipeline, UploadResult } from './transport';
import { QUEUE_OVERFLOW_CODE } from './upload-pipeline';

const environment: EnvironmentEnvelope = {
  platform: { type: 'node', version: '1' },
  sdk: { version: '0', type: 'javascript' },
};
const request = (summary: string): RequestJson => ({
  type: 'error',
  summary,
  severity: Severity.High,
  source: { type: 'error', mechanism: 'programmatic' },
  created_on: '2026-05-29T00:00:00Z',
  environment,
});
const bundle = (over: Partial<Bundle> = {}): Bundle => ({
  request: request('boom'),
  body: new Uint8Array([0x50, 0x4b, 1, 2, 3]),
  fileName: 'abc.bundle.zip',
  ...over,
});

// In-memory BundleStore + the live map for assertions.
function memStore() {
  const map = new Map<string, Uint8Array>();
  const store: BundleStore = {
    put: (id, bytes) => {
      map.set(id, bytes);
    },
    list: () => [...map.keys()],
    read: (id) => map.get(id),
    remove: (id) => {
      map.delete(id);
    },
  };
  return { store, map };
}

function fakePipeline(result: UploadResult = { ok: true }) {
  const enqueue = vi.fn<UploadPipeline['enqueue']>(async () => result);
  const flush = vi.fn(async () => true);
  const drop = vi.fn();
  return { pipeline: { enqueue, flush, drop } as UploadPipeline, enqueue, flush, drop };
}

describe('serializeBundle / deserializeBundle', () => {
  it('round-trips request, fileName and body bytes', () => {
    const original = bundle();
    const restored = deserializeBundle(serializeBundle(original));
    expect(restored.request).toEqual(original.request);
    expect(restored.fileName).toBe(original.fileName);
    expect([...restored.body]).toEqual([...original.body]);
  });

  it('round-trips an empty body', () => {
    const restored = deserializeBundle(serializeBundle(bundle({ body: new Uint8Array() })));
    expect(restored.body.length).toBe(0);
    expect(restored.fileName).toBe('abc.bundle.zip');
  });

  it('round-trips a body large enough that the header length field matters', () => {
    const body = new Uint8Array(5000).map((_v, i) => i % 256);
    const restored = deserializeBundle(serializeBundle(bundle({ body })));
    expect([...restored.body]).toEqual([...body]);
  });

  it('deserializes from a frame embedded at a non-zero byteOffset (subarray view)', () => {
    const framed = serializeBundle(bundle());
    const padded = new Uint8Array(framed.length + 8);
    padded.set(framed, 8);
    const restored = deserializeBundle(padded.subarray(8));
    expect(restored.request).toEqual(bundle().request);
    expect([...restored.body]).toEqual([...bundle().body]);
  });
});

describe('createDurableUploadPipeline', () => {
  it('persists a bundle BEFORE attempting the upload (durability ordering)', () => {
    const { store, map } = memStore();
    const order: string[] = [];
    // Record the relative order of the durable write vs the upload attempt — the core durability
    // contract is that the bundle is on disk before the upload could fail/crash.
    const recordingStore: BundleStore = {
      ...store,
      put: (id, bytes) => {
        order.push('put');
        store.put(id, bytes);
      },
    };
    const enqueue = vi.fn<UploadPipeline['enqueue']>(async () => {
      order.push('enqueue');
      return { ok: true };
    });
    const pipeline = { enqueue, flush: vi.fn(async () => true), drop: vi.fn() } as UploadPipeline;
    const durable = createDurableUploadPipeline({
      store: recordingStore,
      pipeline,
      newId: () => 'b1',
    });
    void durable.enqueue(bundle());
    expect(order).toEqual(['put', 'enqueue']); // persisted, THEN uploaded — not the reverse
    expect(deserializeBundle(map.get('b1') as Uint8Array).fileName).toBe('abc.bundle.zip');
  });

  it('removes the durable copy after a confirmed upload (resolves after removal)', async () => {
    const { store, map } = memStore();
    const { pipeline } = fakePipeline({ ok: true });
    const durable = createDurableUploadPipeline({ store, pipeline, newId: () => 'b1' });
    const result = await durable.enqueue(bundle());
    expect(result.ok).toBe(true);
    expect(map.has('b1')).toBe(false); // dropped — already removed by the time enqueue resolves
  });

  it('keeps the durable copy when the upload fails (for later recovery)', async () => {
    const { store, map } = memStore();
    const { pipeline } = fakePipeline({ ok: false });
    const durable = createDurableUploadPipeline({ store, pipeline, newId: () => 'b1' });
    await durable.enqueue(bundle());
    expect(map.has('b1')).toBe(true);
  });

  it('recover() re-enqueues every pending bundle and removes each on success', async () => {
    const { store, map } = memStore();
    map.set('b1', serializeBundle(bundle({ fileName: 'one.zip' })));
    map.set('b2', serializeBundle(bundle({ fileName: 'two.zip' })));
    const { pipeline, enqueue } = fakePipeline({ ok: true });
    createDurableUploadPipeline({ store, pipeline }).recover();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    expect(enqueue.mock.calls.map((c) => (c[0] as Bundle).fileName).sort()).toEqual([
      'one.zip',
      'two.zip',
    ]);
    await vi.waitFor(() => expect(map.size).toBe(0)); // all confirmed → removed
  });

  it('recover() keeps a bundle whose re-upload fails', async () => {
    const { store, map } = memStore();
    map.set('b1', serializeBundle(bundle()));
    const { pipeline, enqueue } = fakePipeline({ ok: false });
    createDurableUploadPipeline({ store, pipeline }).recover();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(map.has('b1')).toBe(true);
  });

  it('recover() drops a corrupt bundle (routes to onError) and continues with the rest', async () => {
    const { store, map } = memStore();
    map.set('bad', new Uint8Array([0, 0, 0, 99, 1, 2])); // header length 99 > available → throws
    map.set('good', serializeBundle(bundle({ fileName: 'good.zip' })));
    const onError = vi.fn();
    const { pipeline, enqueue } = fakePipeline({ ok: true });
    createDurableUploadPipeline({ store, pipeline, onError }).recover();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect((enqueue.mock.calls[0]?.[0] as Bundle).fileName).toBe('good.zip');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(map.has('bad')).toBe(false); // corrupt leftover purged so it can't wedge recovery
  });

  it('recover() skips an id removed between list and read', async () => {
    const { store } = memStore();
    const read = vi.fn(() => undefined);
    const racingStore: BundleStore = { ...store, list: () => ['ghost'], read };
    const { pipeline, enqueue } = fakePipeline();
    createDurableUploadPipeline({ store: racingStore, pipeline }).recover();
    expect(read).toHaveBeenCalledWith('ghost');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('still uploads when durable persistence throws (best-effort), routing to onError', () => {
    const { store } = memStore();
    const throwingStore: BundleStore = {
      ...store,
      put: () => {
        throw new Error('disk full');
      },
    };
    const onError = vi.fn();
    const { pipeline, enqueue } = fakePipeline();
    const durable = createDurableUploadPipeline({ store: throwingStore, pipeline, onError });
    void durable.enqueue(bundle());
    expect(onError).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1); // persistence failure must not block the upload
  });

  it('swallows a persistence failure with the default onError (no onError supplied)', () => {
    const { store } = memStore();
    const throwingStore: BundleStore = {
      ...store,
      put: () => {
        throw new Error('disk full');
      },
    };
    const { pipeline, enqueue } = fakePipeline();
    const durable = createDurableUploadPipeline({ store: throwingStore, pipeline }); // default no-op onError
    expect(() => durable.enqueue(bundle())).not.toThrow();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('routes a removal failure to onError after a successful upload', async () => {
    const { store } = memStore();
    const throwingStore: BundleStore = {
      ...store,
      remove: () => {
        throw new Error('unlink failed');
      },
    };
    const onError = vi.fn();
    const { pipeline } = fakePipeline({ ok: true });
    await createDurableUploadPipeline({ store: throwingStore, pipeline, onError }).enqueue(
      bundle(),
    );
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('generates a distinct id per enqueue by default', () => {
    const { map } = memStore();
    const ids: string[] = [];
    const trackingStore: BundleStore = {
      put: (id) => ids.push(id),
      list: () => [...map.keys()],
      read: (id) => map.get(id),
      remove: () => {},
    };
    const { pipeline } = fakePipeline({ ok: false });
    const durable = createDurableUploadPipeline({ store: trackingStore, pipeline });
    void durable.enqueue(bundle());
    void durable.enqueue(bundle());
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('delegates flush and drop to the inner pipeline', async () => {
    const { store } = memStore();
    const { pipeline, flush, drop } = fakePipeline();
    const durable = createDurableUploadPipeline({ store, pipeline });
    await durable.flush(42);
    durable.drop('reason', 'issue');
    expect(flush).toHaveBeenCalledWith(42);
    expect(drop).toHaveBeenCalledWith('reason', 'issue');
  });
});

// WAVE 6.4 — the durable queue had no retention bound of ANY kind: no attempt limit, no size cap, no TTL.
//
// A bundle the collector permanently refuses (400/413) was kept, re-uploaded at the next launch, refused
// again, kept again — forever. That is a self-DoS against our own collector, and on a long-lived server the
// pending directory grows without limit: `sweep-instances` only reaps subtrees whose OWNING PROCESS IS
// DEAD, so a server's own live subtree is never swept. The rate limiter admits 100 reports/minute and
// `maxDataSize` is MB-scale, so a crash storm writes GB/hour that nothing would ever remove.
//
// Android is the parity target and answers the policy question directly (measured, not assumed):
//   · CommunicationErrorClassifier.java:14-33 — 401 → AUTH_EXPIRED, 408/425/429 → TRANSIENT, every OTHER
//     4xx (400 and 413 included) → PERMANENT; 5xx → TRANSIENT.
//   · ReportUploadExecutor.java:182-199 — a PERMANENT result DELETES the bundle immediately.
//   · IssueReportingTaskUpload.java:27 — MAX_RETRIES = 60, then delete.
// Android's report queue has no count/size/TTL cap, but its sibling queues do and that is the idiom to
// follow: NotificationRelayStorage.java:47-49 (1 MB / 500 entries / 72 h), PerformanceUploadStorage.java:35
// (5 MB).
describe('retention (Wave 6.4)', () => {
  const permanent = (status: number): UploadResult => ({
    ok: false,
    permanent: true,
    error: new BugseeError(`bundle upload failed (status ${status})`, status),
  });
  const transient = (status: number): UploadResult => ({
    ok: false,
    error: new BugseeError(`bundle upload failed (status ${status})`, status),
  });

  it('DELETES a permanently-rejected bundle instead of retrying it forever', async () => {
    const { store, map } = memStore();
    const { pipeline } = fakePipeline(permanent(400));
    const durable = createDurableUploadPipeline({ store, pipeline });
    await durable.enqueue(bundle());
    expect(map.size).toBe(0);
  });

  it('KEEPS a transiently-failed bundle so the next launch retries it', async () => {
    // The other half of the rule. Deleting on any failure would throw away exactly the bundles the durable
    // queue exists to protect — the ones that failed because the network was down.
    const { store, map } = memStore();
    const { pipeline } = fakePipeline(transient(503));
    const durable = createDurableUploadPipeline({ store, pipeline });
    await durable.enqueue(bundle());
    expect(map.size).toBe(1);
  });

  it('deletes a recovered bundle that is permanently rejected on replay', async () => {
    // The path that actually loops: recover() re-enqueues, the collector refuses again. Without this the
    // bundle is re-uploaded on every launch for the life of the installation.
    const { store, map } = memStore();
    map.set('old', serializeBundle(bundle()));
    const { pipeline, enqueue } = fakePipeline(permanent(413));
    createDurableUploadPipeline({ store, pipeline }).recover();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalled());
    await vi.waitFor(() => expect(map.size).toBe(0));
  });

  it('drops bundles older than the retention TTL without uploading them', async () => {
    let now = 1_000_000;
    const { store, map } = memStore();
    // A TRANSIENT failure, so the bundle is genuinely still on disk when the TTL is applied. With the
    // default ok:true fake it would have been removed by SUCCESS, and this test would pass against no
    // implementation at all.
    const { pipeline, enqueue } = fakePipeline(transient(503));
    const durable = createDurableUploadPipeline({
      store,
      pipeline,
      now: () => now,
      retention: { maxAgeMs: 1000 },
    });
    await durable.enqueue(bundle());
    now += 1001;
    durable.recover();
    expect(enqueue).toHaveBeenCalledTimes(1); // only the original enqueue — the stale one was not replayed
    expect(map.size).toBe(0);
  });

  it('keeps a bundle that is still inside the TTL', async () => {
    let now = 1_000_000;
    const { store, map } = memStore();
    const { pipeline } = fakePipeline(transient(503));
    const durable = createDurableUploadPipeline({
      store,
      pipeline,
      now: () => now,
      retention: { maxAgeMs: 10_000 },
    });
    await durable.enqueue(bundle());
    now += 5000;
    durable.recover();
    await vi.waitFor(() => expect(map.size).toBe(1));
  });

  it('evicts the OLDEST bundles beyond the count cap', async () => {
    let now = 1000;
    const { store, map } = memStore();
    const { pipeline } = fakePipeline(transient(503));
    const durable = createDurableUploadPipeline({
      store,
      pipeline,
      now: () => now,
      retention: { maxBundles: 2 },
    });
    for (const summary of ['first', 'second', 'third']) {
      await durable.enqueue(bundle({ request: request(summary) }));
      now += 1000;
    }
    durable.recover();
    const kept = [...map.values()].map((b) => deserializeBundle(b).request.summary);
    expect(kept).toEqual(['second', 'third']); // the oldest went; the newest are the ones worth keeping
  });

  it('evicts the oldest beyond the BYTE cap', async () => {
    let now = 1000;
    const { store, map } = memStore();
    const { pipeline } = fakePipeline(transient(503));
    const durable = createDurableUploadPipeline({
      store,
      pipeline,
      now: () => now,
      retention: { maxBytes: 900 },
    });
    for (const summary of ['first', 'second']) {
      await durable.enqueue(bundle({ request: request(summary), body: new Uint8Array(400) }));
      now += 1000;
    }
    durable.recover();
    const kept = [...map.values()].map((b) => deserializeBundle(b).request.summary);
    expect(kept).toEqual(['second']);
  });

  it('reports every retention drop through the pipeline’s outcome channel', async () => {
    // A silently vanishing bundle is indistinguishable from one that was delivered. Wave 4 is about
    // features that quietly do nothing; a retention policy that drops without saying so is the same shape.
    let now = 1_000_000;
    const { store } = memStore();
    const { pipeline, drop } = fakePipeline(transient(503));
    const durable = createDurableUploadPipeline({
      store,
      pipeline,
      now: () => now,
      retention: { maxAgeMs: 1000 },
    });
    await durable.enqueue(bundle());
    now += 5000;
    durable.recover();
    expect(drop).toHaveBeenCalledWith('retention_expired', 'issue');
  });

  it('still replays everything when nothing exceeds the bounds — the canary', async () => {
    const { store, map } = memStore();
    map.set('a', serializeBundle(bundle({ request: request('a') })));
    map.set('b', serializeBundle(bundle({ request: request('b') })));
    const { pipeline, enqueue } = fakePipeline(transient(503));
    createDurableUploadPipeline({ store, pipeline }).recover();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(2));
    expect(map.size).toBe(2); // transient → all kept
  });

  it('gives a legacy blob with no timestamp a fresh TTL rather than evicting it on sight', async () => {
    // Bundles written before this existed have no `firstSeenMs`. Treating "unknown" as "epoch" would
    // delete every pending bundle on the upgrade launch — losing exactly the crash reports a user upgraded
    // to get. They fall under the count and byte caps like anything else.
    const { store, map } = memStore();
    const legacy = serializeBundle(bundle());
    map.set('legacy', legacy);
    const { pipeline, enqueue } = fakePipeline(transient(503));
    createDurableUploadPipeline({
      store,
      pipeline,
      now: () => 9_999_999,
      retention: { maxAgeMs: 1000 },
    }).recover();
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(map.size).toBe(1);
  });
});

describe('createDurableUploadPipeline — draining a burst the pipeline refused', () => {
  /** A pipeline that admits `capacity` uploads at once and REFUSES the rest, like the real one. */
  function boundedPipeline(capacity: number) {
    const delivered: string[] = [];
    let inFlight = 0;
    const release: Array<() => void> = [];
    const pipeline: UploadPipeline = {
      enqueue: (b) => {
        if (inFlight >= capacity) {
          // The real pipeline's `queue_overflow`: a NON-permanent failure, so the durable copy stays.
          return Promise.resolve({
            ok: false,
            error: new BugseeError('upload queue overflow', QUEUE_OVERFLOW_CODE),
          });
        }
        inFlight += 1;
        return new Promise<UploadResult>((resolve) => {
          release.push(() => {
            inFlight -= 1;
            delivered.push(b.request.summary);
            resolve({ ok: true });
          });
        });
      },
      flush: async () => true,
      drop: () => {},
    };
    return { pipeline, delivered, release };
  }

  it('uploads every bundle of a burst as capacity frees, instead of waiting for the next launch', async () => {
    const { store, map } = memStore();
    const { pipeline, delivered, release } = boundedPipeline(2);
    const durable = createDurableUploadPipeline({ pipeline, store });

    const results = ['a', 'b', 'c', 'd', 'e'].map((name) =>
      durable.enqueue(bundle({ request: request(name) })),
    );
    // Only two were admitted; the other three were refused and are staged on disk.
    expect(map.size).toBe(5);

    // Let the in-flight uploads finish, one completion at a time. Each frees a slot, and each
    // completion pumps the next staged bundle.
    for (let i = 0; i < 20 && release.length > 0; i += 1) {
      release.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }
    await Promise.all(results);
    // give the completion-driven pump its microtasks
    for (let i = 0; i < 20 && release.length > 0; i += 1) {
      release.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(delivered.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(map.size).toBe(0); // every durable copy dropped once delivered
  });

  it('purges an unparseable staged blob instead of letting it wedge the pump', async () => {
    // A corrupt leftover must not be handed to the pipeline, and must not be re-read on every
    // completion for the rest of the process either.
    const { store, map } = memStore();
    const { pipeline, release } = boundedPipeline(1);
    const onError = vi.fn();
    const durable = createDurableUploadPipeline({ pipeline, store, onError });

    map.set('corrupt', new Uint8Array([0xff, 0xfe, 0xfd])); // not a serialized frame
    const first = durable.enqueue(bundle({ request: request('good') }));
    release.shift()?.();
    await first;
    await Promise.resolve();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(map.has('corrupt')).toBe(false);
  });

  it('skips a staged id that vanishes between list() and read()', async () => {
    const { store, map } = memStore();
    const { pipeline, release } = boundedPipeline(1);
    // `list` announces an id the store no longer holds — the race the pump has to tolerate.
    const racy = { ...store, list: () => [...map.keys(), 'vanished'] };
    const durable = createDurableUploadPipeline({ pipeline, store: racy });

    const first = durable.enqueue(bundle({ request: request('good') }));
    release.shift()?.();
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it('does not re-attempt anything while the pipeline is still full', async () => {
    // A capacity refusal frees nothing, so it must not trigger another attempt. If it did, the
    // refused bundle would be handed back immediately, refused again, and so on — a spin that lasts
    // exactly as long as the pipeline stays busy.
    const { store } = memStore();
    const { pipeline, release } = boundedPipeline(1);
    const enqueue = vi.fn(pipeline.enqueue);
    const durable = createDurableUploadPipeline({
      pipeline: { enqueue, flush: async () => true, drop: () => {} },
      store,
    });

    void durable.enqueue(bundle({ request: request('held') })); // admitted, never released
    await Promise.resolve();
    for (const name of ['x', 'y', 'z']) {
      await durable.enqueue(bundle({ request: request(name) })); // each refused for capacity
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(enqueue).toHaveBeenCalledTimes(4); // the four calls made, and not one more
    expect(release).toHaveLength(1);
  });

  it('attempts each staged bundle at most once per process, so a failing upload cannot spin', async () => {
    const { store, map } = memStore();
    const enqueue = vi.fn(
      async (): Promise<UploadResult> => ({ ok: false, error: new BugseeError('5xx', 503) }),
    );
    const durable = createDurableUploadPipeline({
      pipeline: { enqueue, flush: async () => true, drop: () => {} },
      store,
    });
    await durable.enqueue(bundle());
    await Promise.resolve();
    await Promise.resolve();
    // One attempt, and the bundle is still staged for the next launch — not retried in a hot loop.
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(map.size).toBe(1);
  });
});
