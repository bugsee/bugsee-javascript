import { type EnvironmentEnvelope, type RequestJson, Severity } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  type BundleStore,
  createDurableUploadPipeline,
  deserializeBundle,
  serializeBundle,
} from './durable-upload-pipeline';
import type { Bundle, UploadPipeline, UploadResult } from './transport';

const environment: EnvironmentEnvelope = {
  platform: { type: 'node', version: '1' },
  sdk: { version: '0', type: 'javascript' },
};
const request = (summary: string): RequestJson => ({
  type: 'error',
  summary,
  severity: Severity.High,
  source: { mechanism: 'programmatic' },
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
  it('persists a bundle before uploading it', () => {
    const { store, map } = memStore();
    const { pipeline, enqueue } = fakePipeline();
    const durable = createDurableUploadPipeline({ store, pipeline, newId: () => 'b1' });
    void durable.enqueue(bundle());
    // Persisted synchronously, with the serialized frame, before the upload resolves.
    expect(map.has('b1')).toBe(true);
    expect(deserializeBundle(map.get('b1') as Uint8Array).fileName).toBe('abc.bundle.zip');
    expect(enqueue).toHaveBeenCalledTimes(1);
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
