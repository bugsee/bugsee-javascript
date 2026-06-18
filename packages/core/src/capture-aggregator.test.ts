import { describe, expect, it, vi } from 'vitest';
import { createCaptureAggregator } from './capture-aggregator';
import { CaptureDataEntryBase } from './capture-data-entry';
import { createCaptureExporter } from './capture-exporter';
import type { CaptureDataEntry, CaptureStore, StoredEntry } from './contracts';
import { createMemoryCaptureStore } from './memory-capture-store';
import type { RequestContext } from './request-context';

function fakeStore() {
  const added: StoredEntry[] = [];
  const store: CaptureStore = {
    add: (r) => added.push(r),
    tick: vi.fn(),
    snapshot: vi.fn(() => ({
      stream: async function* () {},
      drainAll: async () => new Map(),
      release: () => {},
    })),
    clear: vi.fn(),
  };
  return { store, added };
}

describe('createCaptureAggregator', () => {
  it('serializes an entry and routes the record to the store', () => {
    const { store, added } = fakeStore();
    const e = new CaptureDataEntryBase('network', 1, { url: 'u' });
    createCaptureAggregator(store).addEntry(e);
    expect(added).toEqual([{ type: 'network', timestamp: 1, serialized: e.serialize() }]);
  });

  it("routes the entry's OWN serialize() output", () => {
    const { store, added } = fakeStore();
    const custom: CaptureDataEntry = {
      type: 'log',
      timestamp: 5,
      data: {},
      serialize: () => 'MARKER',
      deserialize: () => {},
    };
    createCaptureAggregator(store).addEntry(custom);
    expect(added[0]).toEqual({ type: 'log', timestamp: 5, serialized: 'MARKER' });
  });

  it('serializes and routes each entry of a batch, in order', () => {
    const { store, added } = fakeStore();
    const a = new CaptureDataEntryBase('log', 1, { a: 1 });
    const b = new CaptureDataEntryBase('network', 2, { b: 2 });
    createCaptureAggregator(store).addEntries([a, b]);
    expect(added).toEqual([
      { type: 'log', timestamp: 1, serialized: a.serialize() },
      { type: 'network', timestamp: 2, serialized: b.serialize() },
    ]);
  });

  it('clear delegates to store.clear', () => {
    const { store } = fakeStore();
    createCaptureAggregator(store).clear();
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  it('an entry whose serialize() throws goes to onError, never thrown into the caller (the interceptor)', () => {
    // The funnel is reached SYNCHRONOUSLY from interceptors (e.g. console.log(circularObj) → serialize →
    // JSON.stringify throws). Capture must NEVER throw into the app — report it + keep the funnel working.
    const { store, added } = fakeStore();
    const errors: unknown[] = [];
    const bad: CaptureDataEntry = {
      type: 'log',
      timestamp: 1,
      data: {},
      serialize: () => {
        throw new Error('circular');
      },
      deserialize: () => {},
    };
    const good = new CaptureDataEntryBase('log', 2, { ok: true });
    const agg = createCaptureAggregator(store, { onError: (e) => errors.push(e) });
    expect(() => agg.addEntry(bad)).not.toThrow();
    expect(errors.map((e) => (e as Error).message)).toEqual(['circular']);
    agg.addEntry(good); // the funnel still works after a bad entry
    expect(added).toEqual([{ type: 'log', timestamp: 2, serialized: good.serialize() }]);
  });

  it('addEntries isolates a throwing entry: the rest of the batch still routes, the error → onError', () => {
    const { store, added } = fakeStore();
    const errors: unknown[] = [];
    const a = new CaptureDataEntryBase('log', 1, { a: 1 });
    const bad: CaptureDataEntry = {
      type: 'log',
      timestamp: 2,
      data: {},
      serialize: () => {
        throw new Error('boom');
      },
      deserialize: () => {},
    };
    const c = new CaptureDataEntryBase('log', 3, { c: 3 });
    createCaptureAggregator(store, { onError: (e) => errors.push(e) }).addEntries([a, bad, c]);
    expect(added.map((r) => r.timestamp)).toEqual([1, 3]); // the bad entry skipped, a + c still routed
    expect(errors).toHaveLength(1);
  });

  it('without an onError, a throwing entry is silently swallowed (still never throws into the caller)', () => {
    const { store } = fakeStore();
    const bad: CaptureDataEntry = {
      type: 'log',
      timestamp: 1,
      data: {},
      serialize: () => {
        throw new Error('x');
      },
      deserialize: () => {},
    };
    expect(() => createCaptureAggregator(store).addEntry(bad)).not.toThrow(); // default no-op sink
  });
});

describe('createCaptureAggregator context stamping', () => {
  const log = (timestamp: number, data: unknown) =>
    new CaptureDataEntryBase('log', timestamp, data);

  it('stamps context_id from the active context into each entry payload (data + serialized record)', () => {
    const { store, added } = fakeStore();
    const ctx: RequestContext = { contextId: 'ctx-1' };
    const e = log(1, { message: 'hi' });
    createCaptureAggregator(store, { getContext: () => ctx }).addEntry(e);
    expect(e.data).toEqual({ message: 'hi', context_id: 'ctx-1' });
    expect(JSON.parse(added[0]?.serialized as string)).toEqual({
      timestamp: 1,
      data: { message: 'hi', context_id: 'ctx-1' },
    });
  });

  it('also stamps trace_id/span_id when the active context carries a trace', () => {
    const { store } = fakeStore();
    const ctx: RequestContext = { contextId: 'ctx-1', trace: { traceId: 't1', spanId: 's1' } };
    const e = log(2, { url: 'u' });
    createCaptureAggregator(store, { getContext: () => ctx }).addEntry(e);
    expect(e.data).toEqual({ url: 'u', context_id: 'ctx-1', trace_id: 't1', span_id: 's1' });
  });

  it('stamps onto a COPY — never mutates the caller’s data object (no leak to a shared source event)', () => {
    const { store } = fakeStore();
    const ctx: RequestContext = { contextId: 'ctx-1', trace: { traceId: 't1', spanId: 's1' } };
    const original = { message: 'hi' };
    const e = log(1, original);
    createCaptureAggregator(store, { getContext: () => ctx }).addEntry(e);
    // The object the provider handed us (which a source emitter may broadcast to other subscribers, or
    // app code may still reference) stays clean — the correlation ids went onto a copy.
    expect(original).toEqual({ message: 'hi' });
    expect(e.data).not.toBe(original);
    expect(e.data).toEqual({ message: 'hi', context_id: 'ctx-1', trace_id: 't1', span_id: 's1' });
  });

  it('does not stamp trace ids when the context has no active trace', () => {
    const { store } = fakeStore();
    const ctx: RequestContext = { contextId: 'ctx-1' };
    const e = log(1, { message: 'hi' });
    createCaptureAggregator(store, { getContext: () => ctx }).addEntry(e);
    expect(Object.keys(e.data as object)).toEqual(['message', 'context_id']);
  });

  it('does not stamp when no context is active (getContext returns undefined)', () => {
    const { store } = fakeStore();
    const e = log(1, { message: 'hi' });
    createCaptureAggregator(store, { getContext: () => undefined }).addEntry(e);
    expect(e.data).toEqual({ message: 'hi' });
  });

  it('does not stamp when no provider is wired (default) — byte-identical to today', () => {
    const { store, added } = fakeStore();
    const e = log(1, { message: 'hi' });
    createCaptureAggregator(store).addEntry(e);
    expect(e.data).toEqual({ message: 'hi' });
    expect(JSON.parse(added[0]?.serialized as string)).toEqual({
      timestamp: 1,
      data: { message: 'hi' },
    });
  });

  it('leaves non-object entry data (array / primitive / null) untouched and never throws', () => {
    const { store } = fakeStore();
    const ctx: RequestContext = { contextId: 'ctx-1' };
    const agg = createCaptureAggregator(store, { getContext: () => ctx });
    const arr = log(1, [1, 2, 3]);
    const prim = log(2, 'raw');
    const nul = log(3, null);
    agg.addEntry(arr);
    agg.addEntry(prim);
    agg.addEntry(nul);
    expect(arr.data).toEqual([1, 2, 3]);
    expect(prim.data).toBe('raw');
    expect(nul.data).toBeNull();
  });

  it('stamps every entry of a batch', () => {
    const { store } = fakeStore();
    const ctx: RequestContext = { contextId: 'ctx-1' };
    const a = log(1, { a: 1 });
    const b = new CaptureDataEntryBase('network', 2, { b: 2 });
    createCaptureAggregator(store, { getContext: () => ctx }).addEntries([a, b]);
    expect((a.data as Record<string, unknown>).context_id).toBe('ctx-1');
    expect((b.data as Record<string, unknown>).context_id).toBe('ctx-1');
  });
});

describe('createCaptureAggregator (exporter round-trip)', () => {
  it('round-trips entries through the in-memory store + exporter', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const aggregator = createCaptureAggregator(store);
    const exporter = createCaptureExporter(store);
    aggregator.addEntry(new CaptureDataEntryBase('log', 1, { m: 'hi' }));
    const out = await exporter.drain();
    expect(
      out.get('log')?.map((e) => ({ type: e.type, timestamp: e.timestamp, data: e.data })),
    ).toEqual([{ type: 'log', timestamp: 1, data: { m: 'hi' } }]);
    // The exporter snapshots (non-destructive): a second drain still sees the live data.
    expect((await exporter.drain()).get('log')).toHaveLength(1);
  });
});
