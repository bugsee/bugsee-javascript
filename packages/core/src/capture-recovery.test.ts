import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { strFromU8, unzipSync } from '@bugsee/util';
import { describe, expect, it, vi } from 'vitest';
import { createMarkerAwareBundleReplay, recoverReports } from './capture-recovery';
import type { ChunkBackend, PartRef } from './chunk-backend';
import { createInMemoryChunkStorage } from './chunk-storage';
import type { StoredEntry } from './contracts';
import type { IdentifiedBundle } from './durable-upload-pipeline';
import { createFileChunkBackend } from './file-chunk-backend';
import type { ReportMarker, ReportMarkerStore } from './report-marker-store';
import { createReportingRequest } from './reporting';
import type { Bundle, UploadPipeline, UploadResult } from './transport';

const env: EnvironmentEnvelope = {
  platform: { type: 'node', version: '20' },
  runtime: { type: 'node', version: '' },
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

// A marker whose store KEY (`request.id`) deliberately differs from the co-located `request.report.id`.
// `createReportingRequest` always makes the two equal, which is exactly why a test built on it cannot see
// the difference — this one can.
const skewedMarker = (id: string, reportId: string, generation: number): ReportMarker => {
  const request = createReportingRequest({ source: { type: 'crash' }, id });
  return {
    generation,
    request: { ...request, report: { ...request.report, id: reportId } },
    attributes: {},
    userIdentifier: null,
  };
};

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
    put: (m) => {
      map.set(m.request.id, m);
    },
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

  it('does NOT sweep a generation listed in keepGenerations (a still-pending native crash retry)', async () => {
    const storage = createInMemoryChunkStorage();
    seedGen(storage, 77, [logRecord(1, { m: 'native-capture' })]); // NO report marker
    seedGen(storage, 50, [logRecord(1, { m: 'no-incident' })]); // NO marker, not kept
    const backend = readBackend(storage);

    await recoverReports({
      backend,
      currentGeneration: 999,
      markers: fakeMarkers([]),
      context: baseContext,
      uploadPipeline: fakePipeline(),
      keepGenerations: new Set([77]),
    });

    const gens = await backend.listGenerations();
    expect(gens).toContain(77); // protected for the native retry
    expect(gens).not.toContain(50); // still swept (not kept)
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

  it('skips a single torn/un-deserializable record, recovering the rest (a crash leaves a torn trailing frame)', async () => {
    const storage = createInMemoryChunkStorage();
    // A good record + a TORN trailing frame (truncated JSON — exactly what a crash/SIGKILL mid-write
    // leaves on disk). The snapshot parser accepts it (it has a tab + a finite timestamp), so it reaches
    // reify, where JSON.parse throws. It must NOT poison the whole generation (keep marker+chunks forever).
    seedGen(storage, 100, [
      logRecord(1, { m: 'survivor' }),
      { type: 'log', timestamp: 2, serialized: '{"timestamp":2,"data":"trunc' },
    ]);
    const markers = fakeMarkers([marker('inc1', 100)]);
    const pipe = fakePipeline();
    const onError = vi.fn();
    const backend = readBackend(storage);

    await recoverReports({
      backend,
      currentGeneration: 999,
      markers,
      context: baseContext,
      uploadPipeline: pipe,
      onError,
    });

    expect(pipe.enqueue).toHaveBeenCalledTimes(1); // the generation still recovered…
    expect(logsOf(pipe.bundles[0] as Bundle)).toEqual([{ m: 'survivor' }]); // …with the intact record only
    expect(onError).toHaveBeenCalledTimes(1); // the torn record routed to onError, not swallowed silently
    expect(markers.list()).toEqual([]); // delivered → marker removed (no poison pill)
    expect(await backend.listGenerations()).not.toContain(100); // gen swept, not kept forever
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

  // SEV1 (recovery double-upload): a bundle that already reached the durable queue was staged only AFTER
  // its incident's marker was written (client.ts submitReport) and cleared only once that upload SETTLED,
  // so a process dying inside that window leaves BOTH traces of the SAME incident. `skipReportIds` is how
  // the bundle-queue leg tells this pass which incidents it already settled with.
  describe('skipReportIds', () => {
    it('does not rebuild a marker whose incident the bundle-queue leg already settled', async () => {
      const storage = createInMemoryChunkStorage();
      seedGen(storage, 100, [logRecord(1, { m: 'x' })]);
      const markers = fakeMarkers([marker('inc1', 100)]);
      const pipe = fakePipeline();

      await recoverReports({
        backend: readBackend(storage),
        currentGeneration: 999,
        markers,
        context: baseContext,
        uploadPipeline: pipe,
        skipReportIds: new Set(['inc1']),
      });

      expect(pipe.enqueue).not.toHaveBeenCalled(); // the queue leg delivered it — not twice
      expect(markers.list().map((m) => m.request.id)).toEqual(['inc1']); // left for the retry
      // and its capture generation survives the sweep, so a later launch can still rebuild it
      expect(await readBackend(storage).listGenerations()).toEqual([100]);
    });

    it('still rebuilds the markers it was NOT told to skip', async () => {
      const storage = createInMemoryChunkStorage();
      seedGen(storage, 100, [logRecord(1, { m: 'x' })]);
      seedGen(storage, 200, [logRecord(2, { m: 'y' })]);
      const markers = fakeMarkers([marker('inc1', 100), marker('inc2', 200)]);
      const pipe = fakePipeline();

      await recoverReports({
        backend: readBackend(storage),
        currentGeneration: 999,
        markers,
        context: baseContext,
        uploadPipeline: pipe,
        skipReportIds: new Set(['inc1']),
      });

      expect(pipe.enqueue).toHaveBeenCalledTimes(1);
      expect(logsOf(pipe.bundles[0] as Bundle)).toEqual([{ m: 'y' }]); // inc2's generation, not inc1's
      expect(markers.list().map((m) => m.request.id)).toEqual(['inc1']);
    });

    // The stamp must be the MARKER KEY — `request.id`, what `markers.remove()` and the durable frame's
    // `reportId` are both keyed on — and not the co-located `request.report.id`. `createReportingRequest`
    // makes the two identical, so only a deliberately skewed marker can tell them apart; without this the
    // mutation `marker.request.id` → `marker.request.report.id` is invisible in every package.
    it('stamps the recovered bundle with the marker KEY, not the co-located report id', async () => {
      const storage = createInMemoryChunkStorage();
      seedGen(storage, 100, [logRecord(1, { m: 'x' })]);
      const pipe = fakePipeline();
      const markers = fakeMarkers([skewedMarker('key-1', 'report-1', 100)]);

      await recoverReports({
        backend: readBackend(storage),
        currentGeneration: 999,
        markers,
        context: baseContext,
        uploadPipeline: pipe,
      });

      expect((pipe.bundles[0] as IdentifiedBundle).reportId).toBe('key-1');
      expect(markers.list()).toEqual([]); // …and the SAME key retired it on delivery
    });

    // A collector refusal is settled, exactly as the live durable pipeline treats it: rebuilding the same
    // bundle every launch would be a self-DoS, and the marker (plus the generation it pins) would never be
    // freed — and on browser/worker nothing bounded that until `recoverSiblingBundleQueue` gained an age bound.
    it('retires a permanently-refused incident instead of rebuilding it forever', async () => {
      const storage = createInMemoryChunkStorage();
      seedGen(storage, 100, [logRecord(1, { m: 'x' })]);
      const pipe = fakePipeline({ ok: false, permanent: true });
      const markers = fakeMarkers([marker('inc1', 100)]);

      await recoverReports({
        backend: readBackend(storage),
        currentGeneration: 999,
        markers,
        context: baseContext,
        uploadPipeline: pipe,
      });

      expect(pipe.enqueue).toHaveBeenCalledTimes(1);
      expect(markers.list()).toEqual([]); // settled ⇒ retired
      expect(await readBackend(storage).listGenerations()).toEqual([]); // …and its generation swept
    });

    // The sibling of the above: a RETRYABLE failure is not settled, so both the marker and its capture
    // survive for the next launch.
    it('keeps a retryably-failed incident and its generation for the next launch', async () => {
      const storage = createInMemoryChunkStorage();
      seedGen(storage, 100, [logRecord(1, { m: 'x' })]);
      const pipe = fakePipeline({ ok: false });
      const markers = fakeMarkers([marker('inc1', 100)]);

      await recoverReports({
        backend: readBackend(storage),
        currentGeneration: 999,
        markers,
        context: baseContext,
        uploadPipeline: pipe,
      });

      expect(markers.list().map((m) => m.request.id)).toEqual(['inc1']);
      expect(await readBackend(storage).listGenerations()).toEqual([100]);
    });

    it('stamps the recovered bundle with its incident id so a re-staged copy stays reconcilable', async () => {
      const storage = createInMemoryChunkStorage();
      seedGen(storage, 100, [logRecord(1, { m: 'x' })]);
      const pipe = fakePipeline();

      await recoverReports({
        backend: readBackend(storage),
        currentGeneration: 999,
        markers: fakeMarkers([marker('inc1', 100)]),
        context: baseContext,
        uploadPipeline: pipe,
      });

      expect((pipe.bundles[0] as IdentifiedBundle).reportId).toBe('inc1');
    });
  });
});

// The single definition of the queue-vs-marker reconciliation policy (used by node's `recoverInstances`
// and browser-utils' `Coexistence`): the staged bundle wins, its marker is retired only once that bundle
// really uploaded, and nothing is ever dropped un-uploaded.
describe('createMarkerAwareBundleReplay', () => {
  const staged = (summary: string, reportId?: string): IdentifiedBundle => ({
    request: { summary } as Bundle['request'],
    body: new Uint8Array([1]),
    fileName: 'p.zip',
    ...(reportId !== undefined ? { reportId } : {}),
  });

  function innerPipeline(result: UploadResult = { ok: true }) {
    const seen: Array<[Bundle, unknown]> = [];
    const pipeline: UploadPipeline = {
      enqueue: (bundle, hint) => {
        seen.push([bundle, hint]);
        return Promise.resolve(result);
      },
      flush: vi.fn((timeout?: number) => Promise.resolve(timeout === 5)),
      drop: vi.fn(),
    };
    return { seen, pipeline };
  }

  it('delivers the staged bundle and retires the marker its incident was still holding open', async () => {
    const markers = fakeMarkers([marker('inc1', 100)]);
    const inner = innerPipeline();
    const replay = createMarkerAwareBundleReplay({ markers, pipeline: inner.pipeline });

    const result = await replay.pipeline.enqueue(staged('inc1 bundle', 'inc1'));

    expect(result).toEqual({ ok: true });
    expect(inner.seen.map(([b]) => b.request.summary)).toEqual(['inc1 bundle']); // really uploaded
    expect(markers.list()).toEqual([]); // …and only THEN is the marker retired
    expect([...replay.skipReportIds]).toEqual(['inc1']); // the marker leg must not rebuild it
  });

  it('keeps the marker when the staged bundle fails to upload, and still skips the marker leg this pass', async () => {
    const markers = fakeMarkers([marker('inc1', 100)]);
    const inner = innerPipeline({ ok: false });
    const replay = createMarkerAwareBundleReplay({ markers, pipeline: inner.pipeline });

    const result = await replay.pipeline.enqueue(staged('inc1 bundle', 'inc1'));

    expect(result).toEqual({ ok: false });
    expect(markers.list().map((m) => m.request.id)).toEqual(['inc1']); // nothing delivered ⇒ nothing retired
    expect([...replay.skipReportIds]).toEqual(['inc1']); // but not attempted twice in ONE pass either
  });

  it('leaves an unrelated incident alone — the case the old set-emptiness key silently deleted', async () => {
    const markers = fakeMarkers([marker('inc1', 100)]);
    const inner = innerPipeline();
    const replay = createMarkerAwareBundleReplay({ markers, pipeline: inner.pipeline });

    await replay.pipeline.enqueue(staged('inc2 bundle', 'inc2')); // a DIFFERENT incident's staged bundle

    expect(inner.seen).toHaveLength(1); // uploaded, never dropped
    expect(markers.list().map((m) => m.request.id)).toEqual(['inc1']); // inc1 is untouched
    expect([...replay.skipReportIds]).toEqual([]); // …and still owed by the marker leg
  });

  it('uploads a frame that carries no report id (older SDK) without reconciling anything', async () => {
    const markers = fakeMarkers([marker('inc1', 100)]);
    const inner = innerPipeline();
    const replay = createMarkerAwareBundleReplay({ markers, pipeline: inner.pipeline });

    await replay.pipeline.enqueue(staged('legacy bundle'));

    expect(inner.seen).toHaveLength(1);
    expect(markers.list().map((m) => m.request.id)).toEqual(['inc1']);
    expect([...replay.skipReportIds]).toEqual([]);
  });

  it('reconciles against the markers present when the replay STARTED, not ones written later', async () => {
    const markers = fakeMarkers([]);
    const inner = innerPipeline();
    const replay = createMarkerAwareBundleReplay({ markers, pipeline: inner.pipeline });
    markers.put(marker('inc1', 100)); // appears after the snapshot

    await replay.pipeline.enqueue(staged('inc1 bundle', 'inc1'));

    expect(markers.list().map((m) => m.request.id)).toEqual(['inc1']); // not retired by a blob it never shadowed
    expect([...replay.skipReportIds]).toEqual([]);
  });

  it('passes the hint through and returns the inner result verbatim', async () => {
    const inner = innerPipeline({ ok: false, permanent: true });
    const replay = createMarkerAwareBundleReplay({
      markers: fakeMarkers([]),
      pipeline: inner.pipeline,
    });

    const result = await replay.pipeline.enqueue(staged('b'), { category: 'issue' });

    expect(result).toEqual({ ok: false, permanent: true });
    expect(inner.seen[0]?.[1]).toEqual({ category: 'issue' });
  });

  it('delegates flush and drop to the wrapped pipeline', async () => {
    const inner = innerPipeline();
    const replay = createMarkerAwareBundleReplay({
      markers: fakeMarkers([]),
      pipeline: inner.pipeline,
    });

    await expect(replay.pipeline.flush(5)).resolves.toBe(true);
    expect(inner.pipeline.flush).toHaveBeenCalledWith(5);
    replay.pipeline.drop('retention_count', 'issue');
    expect(inner.pipeline.drop).toHaveBeenCalledWith('retention_count', 'issue');
  });

  it('routes a marker-store failure to onError and still reports the delivery as ok', async () => {
    const boom = new Error('marker remove boom');
    const markers: ReportMarkerStore = {
      put: () => {},
      list: () => [marker('inc1', 100)],
      remove: () => {
        throw boom;
      },
    };
    const onError = vi.fn();
    const replay = createMarkerAwareBundleReplay({
      markers,
      pipeline: innerPipeline().pipeline,
      onError,
    });

    await expect(replay.pipeline.enqueue(staged('inc1 bundle', 'inc1'))).resolves.toEqual({
      ok: true,
    });
    expect(onError).toHaveBeenCalledWith(boom);
    expect([...replay.skipReportIds]).toEqual(['inc1']);
  });

  // A collector refusal is SETTLED — the durable pipeline frees the blob for it (a re-upload would just be
  // refused again, forever). The marker must go with it, or the incident is rebuilt on every later launch
  // and its capture generation is pinned for good (on browser/worker, until the sibling leg's age bound, forever).
  it('retires the marker when the collector permanently refuses the staged bundle', async () => {
    const markers = fakeMarkers([marker('inc1', 100)]);
    const inner = innerPipeline({ ok: false, permanent: true });
    const replay = createMarkerAwareBundleReplay({ markers, pipeline: inner.pipeline });

    const result = await replay.pipeline.enqueue(staged('inc1 bundle', 'inc1'));

    expect(result).toEqual({ ok: false, permanent: true });
    expect(markers.list()).toEqual([]);
    expect([...replay.skipReportIds]).toEqual(['inc1']);
  });

  // The id must be recorded BEFORE the upload is attempted. Both callers wrap the replay in a try/catch, so
  // an id recorded only after the await is LOST when the pipeline throws — and the marker leg then rebuilds
  // and delivers the very incident the blob still holds, which is the duplicate this class exists to stop.
  it('records the skip before the upload, so a throwing pipeline cannot lose it', async () => {
    const markers = fakeMarkers([marker('inc1', 100)]);
    const boom = new Error('transport exploded');
    const pipeline: UploadPipeline = {
      enqueue: () => Promise.reject(boom),
      flush: () => Promise.resolve(true),
      drop: () => {},
    };
    const replay = createMarkerAwareBundleReplay({ markers, pipeline });

    await expect(replay.pipeline.enqueue(staged('inc1 bundle', 'inc1'))).rejects.toBe(boom);

    expect([...replay.skipReportIds]).toEqual(['inc1']); // still withheld from the marker leg
    expect(markers.list().map((m) => m.request.id)).toEqual(['inc1']); // nothing settled ⇒ nothing retired
  });

  // The snapshot the reconciliation keys on, published so a caller draining a SECOND store (an injected
  // `bundleStore`, which is not per-instance) can select exactly the blobs this dead instance still owes.
  it('publishes the pending report ids it reconciles against', () => {
    const replay = createMarkerAwareBundleReplay({
      markers: fakeMarkers([marker('inc1', 100), marker('inc2', 101)]),
      pipeline: innerPipeline().pipeline,
    });

    expect([...replay.pendingReportIds].sort()).toEqual(['inc1', 'inc2']);
  });

  it('swallows a marker-store failure with no onError configured', async () => {
    const markers: ReportMarkerStore = {
      put: () => {},
      list: () => [marker('inc1', 100)],
      remove: () => {
        throw new Error('boom');
      },
    };
    const replay = createMarkerAwareBundleReplay({ markers, pipeline: innerPipeline().pipeline });

    await expect(replay.pipeline.enqueue(staged('inc1 bundle', 'inc1'))).resolves.toEqual({
      ok: true,
    });
  });
});
