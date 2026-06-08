import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { strFromU8, unzipSync } from '@bugsee/util';
import { describe, expect, it, vi } from 'vitest';
import { recoverReports } from './capture-recovery';
import type { ChunkBackend, PartRef } from './chunk-backend';
import { createInMemoryChunkStorage } from './chunk-storage';
import type { StoredEntry } from './contracts';
import { createFileChunkBackend } from './file-chunk-backend';
import type { ReportMarker, ReportMarkerStore } from './report-marker-store';
import { createReportingRequest } from './reporting';
import type { Bundle, UploadResult } from './transport';

const env: EnvironmentEnvelope = {
  platform: { type: 'node', version: '20' },
  sdk: { version: '1.0.0', type: 'javascript' },
};
const clock = { wallNow: () => 1_700_000_000_000, monotonicNow: () => 0 };
const baseContext = () => ({ appToken: 'tok', environment: env, clock, fileName: () => 'b.zip' });

const ref = (generation: number, number: number): PartRef => ({ generation, number });
// A capture log record as the store holds it: serialized = JSON.stringify({timestamp, data}).
const logRecord = (timestamp: number, data: unknown): StoredEntry => ({
  type: 'log',
  timestamp,
  serialized: JSON.stringify({ timestamp, data }),
});

const marker = (id: string, generation: number): ReportMarker => ({
  generation,
  request: createReportingRequest({ source: { type: 'crash' }, id }),
  attributes: { plan: 'pro' },
  userIdentifier: 'u@e.com',
});

// Seed a prior generation's chunk (one closed part) into the shared storage.
function seedGen(
  storage: ReturnType<typeof createInMemoryChunkStorage>,
  gen: number,
  records: StoredEntry[],
): void {
  const b = createFileChunkBackend(storage, { generation: gen, cleanOtherGenerations: false });
  b.openPart(ref(gen, 0), gen);
  for (const r of records) {
    b.appendEntry(ref(gen, 0), r);
  }
  b.closePart(ref(gen, 0), gen + 1000, 0);
}

const readBackend = (storage: ReturnType<typeof createInMemoryChunkStorage>): ChunkBackend =>
  createFileChunkBackend(storage, { generation: 999, cleanOtherGenerations: false });

function fakeMarkers(initial: ReportMarker[]): ReportMarkerStore {
  const map = new Map(initial.map((m) => [m.request.id, m]));
  return {
    put: (m) => map.set(m.request.id, m),
    list: () => [...map.values()],
    remove: (id) => {
      map.delete(id);
    },
  };
}

function fakePipeline(result: UploadResult = { ok: true }) {
  const bundles: Bundle[] = [];
  const enqueue = vi.fn((bundle: Bundle): Promise<UploadResult> => {
    bundles.push(bundle);
    return Promise.resolve(result);
  });
  return { bundles, enqueue };
}

const logsOf = (bundle: Bundle): unknown =>
  JSON.parse(strFromU8(unzipSync(bundle.body)['logs.json'] as Uint8Array));

describe('recoverReports', () => {
  it('rebuilds + enqueues one bundle per marker from its generation’s chunks, then removes it', async () => {
    const storage = createInMemoryChunkStorage();
    seedGen(storage, 100, [logRecord(1, { m: 'hello' })]);
    const markers = fakeMarkers([marker('inc1', 100)]);
    const pipe = fakePipeline();
    const backend = readBackend(storage);

    await recoverReports({
      backend,
      currentGeneration: 999,
      markers,
      context: baseContext,
      uploadPipeline: pipe,
    });

    expect(pipe.enqueue).toHaveBeenCalledTimes(1);
    const bundle = pipe.bundles[0] as Bundle;
    expect(bundle.request.type).toBe('crash');
    expect(logsOf(bundle)).toEqual([{ m: 'hello' }]); // the prior gen's capture made it in
    expect(markers.list()).toEqual([]); // delivered marker removed
    expect(await backend.listGenerations()).not.toContain(100); // recovered gen removed
  });

  it('applies the marker’s incident-time attributes (not next-launch state)', async () => {
    const storage = createInMemoryChunkStorage();
    seedGen(storage, 100, [logRecord(1, { m: 'x' })]);
    const m = {
      ...marker('inc1', 100),
      attributes: { plan: 'enterprise', n: 7 },
      userIdentifier: 'who@x.com',
    };
    const pipe = fakePipeline();
    await recoverReports({
      backend: readBackend(storage),
      currentGeneration: 999,
      markers: fakeMarkers([m]),
      context: baseContext,
      uploadPipeline: pipe,
    });
    const manifest = JSON.parse(
      strFromU8(unzipSync((pipe.bundles[0] as Bundle).body)['manifest.json'] as Uint8Array),
    );
    expect(manifest.attrs).toEqual({ plan: 'enterprise', n: 7 }); // from the marker
    expect((pipe.bundles[0] as Bundle).request.email).toBe('who@x.com'); // userIdentifier → email
  });

  it('drains a generation ONCE for its N markers (N bundles, one snapshot)', async () => {
    const storage = createInMemoryChunkStorage();
    seedGen(storage, 100, [logRecord(1, { m: 'x' })]);
    const backend = readBackend(storage);
    const snapSpy = vi.spyOn(backend, 'snapshot');
    const pipe = fakePipeline();

    await recoverReports({
      backend,
      currentGeneration: 999,
      markers: fakeMarkers([marker('a', 100), marker('b', 100)]),
      context: baseContext,
      uploadPipeline: pipe,
    });

    expect(pipe.enqueue).toHaveBeenCalledTimes(2); // one bundle per marker
    expect(snapSpy).toHaveBeenCalledTimes(1); // but the gen's chunks were read once
  });

  it('never recovers the CURRENT generation', async () => {
    const storage = createInMemoryChunkStorage();
    seedGen(storage, 999, [logRecord(1, { m: 'live' })]); // the current gen has data + a marker
    const markers = fakeMarkers([marker('x', 999)]);
    const pipe = fakePipeline();
    await recoverReports({
      backend: readBackend(storage),
      currentGeneration: 999,
      markers,
      context: baseContext,
      uploadPipeline: pipe,
    });
    expect(pipe.enqueue).not.toHaveBeenCalled();
    expect(markers.list()).toHaveLength(1); // current-gen marker untouched
    expect(await readBackend(storage).listGenerations()).toContain(999); // and its data kept
  });

  it('never sweeps the current generation, even with no marker (the live store owns it)', async () => {
    const storage = createInMemoryChunkStorage();
    seedGen(storage, 999, [logRecord(1, { m: 'live' })]); // current gen has data, NO marker
    const backend = readBackend(storage);
    await recoverReports({
      backend,
      currentGeneration: 999,
      markers: fakeMarkers([]),
      context: baseContext,
      uploadPipeline: fakePipeline(),
    });
    expect(await backend.listGenerations()).toContain(999); // the live generation survives the sweep
  });

  it('assembles a metadata-only bundle for a marker whose generation has no chunks', async () => {
    const storage = createInMemoryChunkStorage();
    const markers = fakeMarkers([marker('e', 200)]); // generation 200 was never seeded
    const pipe = fakePipeline();
    await recoverReports({
      backend: readBackend(storage),
      currentGeneration: 999,
      markers,
      context: baseContext,
      uploadPipeline: pipe,
    });
    expect(pipe.enqueue).toHaveBeenCalledTimes(1);
    expect((pipe.bundles[0] as Bundle).request.type).toBe('crash');
    expect(markers.list()).toEqual([]); // a detected crash with no capture is still delivered
  });

  it('keeps the marker AND the chunks when delivery fails (retry next launch)', async () => {
    const storage = createInMemoryChunkStorage();
    seedGen(storage, 100, [logRecord(1, { m: 'x' })]);
    const markers = fakeMarkers([marker('a', 100)]);
    const backend = readBackend(storage);
    await recoverReports({
      backend,
      currentGeneration: 999,
      markers,
      context: baseContext,
      uploadPipeline: fakePipeline({ ok: false }),
    });
    expect(markers.list()).toHaveLength(1); // not removed
    expect(await backend.listGenerations()).toContain(100); // chunks kept for retry
  });

  it('sweeps no-incident prior generations (preserved but never recovered)', async () => {
    const storage = createInMemoryChunkStorage();
    seedGen(storage, 100, [logRecord(1, { m: 'incident' })]); // has a marker
    seedGen(storage, 50, [logRecord(1, { m: 'no-incident' })]); // NO marker
    const markers = fakeMarkers([marker('a', 100)]);
    const pipe = fakePipeline();
    const backend = readBackend(storage);

    await recoverReports({
      backend,
      currentGeneration: 999,
      markers,
      context: baseContext,
      uploadPipeline: pipe,
    });

    expect(pipe.enqueue).toHaveBeenCalledTimes(1); // only the incident gen
    const gens = await backend.listGenerations();
    expect(gens).not.toContain(100); // recovered + removed
    expect(gens).not.toContain(50); // no-incident → swept
  });

  it('isolates a per-generation failure: onError fires and other generations still recover', async () => {
    const storage = createInMemoryChunkStorage();
    seedGen(storage, 200, [logRecord(1, { m: 'ok' })]);
    const backend = readBackend(storage);
    const boom = new Error('listParts boom');
    const wrapped: ChunkBackend = {
      ...backend,
      listParts: (gen: number) => (gen === 100 ? Promise.reject(boom) : backend.listParts(gen)),
    };
    const onError = vi.fn();
    const pipe = fakePipeline();

    await recoverReports({
      backend: wrapped,
      currentGeneration: 999,
      markers: fakeMarkers([marker('bad', 100), marker('good', 200)]),
      context: baseContext,
      uploadPipeline: pipe,
      onError,
    });

    expect(onError).toHaveBeenCalledWith(boom);
    expect(pipe.enqueue).toHaveBeenCalledTimes(1); // generation 200 still recovered
    expect((pipe.bundles[0] as Bundle).request).toBeDefined();
  });

  it('swallows a failure with the default (no-op) onError: it does not throw, others recover', async () => {
    const storage = createInMemoryChunkStorage();
    seedGen(storage, 200, [logRecord(1, { m: 'ok' })]);
    const backend = readBackend(storage);
    const wrapped: ChunkBackend = {
      ...backend,
      listParts: (gen: number) =>
        gen === 100 ? Promise.reject(new Error('boom')) : backend.listParts(gen),
    };
    const pipe = fakePipeline();

    // No onError → the default no-op sink. The failing generation is swallowed (no throw).
    await expect(
      recoverReports({
        backend: wrapped,
        currentGeneration: 999,
        markers: fakeMarkers([marker('bad', 100), marker('good', 200)]),
        context: baseContext,
        uploadPipeline: pipe,
      }),
    ).resolves.toBeUndefined();
    expect(pipe.enqueue).toHaveBeenCalledTimes(1); // generation 200 still recovered
  });

  it('routes a per-marker assembly/enqueue THROW to onError and keeps that generation', async () => {
    const storage = createInMemoryChunkStorage();
    seedGen(storage, 100, [logRecord(1, { m: 'x' })]);
    const backend = readBackend(storage);
    const boom = new Error('enqueue boom');
    const onError = vi.fn();
    await recoverReports({
      backend,
      currentGeneration: 999,
      markers: fakeMarkers([marker('a', 100)]),
      context: baseContext,
      uploadPipeline: { enqueue: () => Promise.reject(boom) },
      onError,
    });
    expect(onError).toHaveBeenCalledWith(boom);
    expect(await backend.listGenerations()).toContain(100); // not delivered → generation kept
  });

  it('isolates a per-marker failure WITHIN a generation: a later marker still delivers', async () => {
    const storage = createInMemoryChunkStorage();
    seedGen(storage, 100, [logRecord(1, { m: 'x' })]);
    const markers = fakeMarkers([marker('first', 100), marker('second', 100)]);
    const onError = vi.fn();
    let call = 0;
    const enqueue = vi.fn((): Promise<UploadResult> => {
      call += 1;
      return call === 1 ? Promise.reject(new Error('first boom')) : Promise.resolve({ ok: true });
    });
    await recoverReports({
      backend: readBackend(storage),
      currentGeneration: 999,
      markers,
      context: baseContext,
      uploadPipeline: { enqueue },
      onError,
    });
    expect(enqueue).toHaveBeenCalledTimes(2); // the first throw did NOT abort the second
    expect(onError).toHaveBeenCalledTimes(1);
    expect(markers.list().map((m) => m.request.id)).toEqual(['first']); // 'second' delivered + removed
  });

  it('routes a top-level failure (the sweep’s listGenerations throws) to onError, never rejects', async () => {
    const storage = createInMemoryChunkStorage();
    const backend = readBackend(storage);
    const boom = new Error('listGenerations boom');
    const onError = vi.fn();
    const wrapped: ChunkBackend = { ...backend, listGenerations: () => Promise.reject(boom) };
    await expect(
      recoverReports({
        backend: wrapped,
        currentGeneration: 999,
        markers: fakeMarkers([]),
        context: baseContext,
        uploadPipeline: fakePipeline(),
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('does nothing (no throw) when there are no markers and no prior generations', async () => {
    const storage = createInMemoryChunkStorage();
    const pipe = fakePipeline();
    await expect(
      recoverReports({
        backend: readBackend(storage),
        currentGeneration: 999,
        markers: fakeMarkers([]),
        context: baseContext,
        uploadPipeline: pipe,
      }),
    ).resolves.toBeUndefined();
    expect(pipe.enqueue).not.toHaveBeenCalled();
  });
});
