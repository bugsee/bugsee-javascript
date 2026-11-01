import type { EnvironmentEnvelope, FileType } from '@bugsee/protocol';
import { strFromU8, unzipSync } from '@bugsee/util';
import { describe, expect, it, vi } from 'vitest';
import type { BundleAssemblyContext } from './bundle-assembler';
import { createMemoryBody, isBundleBody } from './bundle-body';
import { createMemorySink } from './bundle-sink';
import { defaultEntryFactory } from './capture-data-entry';
import type { CaptureSnapshot, StoredEntry } from './contracts';
import { assembleFromSnapshot, enqueueOwningBody } from './recovered-bundle';
import { createReportingRequest } from './reporting';
import type { Bundle } from './transport';

const env: EnvironmentEnvelope = {
  platform: { type: 'web', version: '1' },
  runtime: { type: 'web', version: '' },
  sdk: { version: '1.0.0', type: 'javascript' },
};
const context = (over: Partial<BundleAssemblyContext> = {}): BundleAssemblyContext => ({
  appToken: 'tok',
  environment: env,
  attributes: {},
  clock: { wallNow: () => 2_000, monotonicNow: () => 0 },
  fileName: () => 'fixed.bundle.zip',
  ...over,
});
const stored = (type: FileType, timestamp: number, data: unknown): StoredEntry =>
  ({ type, timestamp, serialized: JSON.stringify({ timestamp, data }) }) as StoredEntry;
const snapshotOf = (records: StoredEntry[]): CaptureSnapshot & { releases: number } => {
  const snap = {
    releases: 0,
    drainAll: () => Promise.resolve(new Map()),
    stream: async function* () {
      yield* records;
    },
    release() {
      snap.releases += 1;
    },
  } as CaptureSnapshot & { releases: number };
  return snap;
};
const request = () =>
  createReportingRequest({ type: 'error', source: { type: 'error' }, summary: 's' } as never);

describe('assembleFromSnapshot', () => {
  it('builds the bundle from the snapshot as plain bytes and releases the snapshot', async () => {
    const snap = snapshotOf([stored('log', 1_000, { m: 1 }), stored('log', 1_500, { m: 2 })]);
    const bundle = await assembleFromSnapshot(request(), snap, defaultEntryFactory, context());
    expect(bundle.body).toBeInstanceOf(Uint8Array);
    const files = unzipSync(bundle.body as Uint8Array);
    expect(JSON.parse(strFromU8(files['logs.json'] as Uint8Array))).toEqual([{ m: 1 }, { m: 2 }]);
    expect(bundle.fileName).toBe('fixed.bundle.zip');
    expect(snap.releases).toBe(1);
  });

  it('routes a torn record to the context onError and keeps the rest', async () => {
    const onError = vi.fn();
    const snap = snapshotOf([
      stored('log', 1_000, { m: 1 }),
      { type: 'log', timestamp: 1_100, serialized: 'NOT-JSON' } as StoredEntry,
    ]);
    const bundle = await assembleFromSnapshot(
      request(),
      snap,
      defaultEntryFactory,
      context({ onError }),
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const files = unzipSync(bundle.body as Uint8Array);
    expect(JSON.parse(strFromU8(files['logs.json'] as Uint8Array))).toHaveLength(1);
  });

  it('tolerates a torn record when the context has no onError', async () => {
    const snap = snapshotOf([
      stored('log', 1_000, { m: 1 }),
      { type: 'log', timestamp: 1_100, serialized: 'NOT-JSON' } as StoredEntry,
    ]);
    const bundle = await assembleFromSnapshot(request(), snap, defaultEntryFactory, context());
    const files = unzipSync(bundle.body as Uint8Array);
    expect(JSON.parse(strFromU8(files['logs.json'] as Uint8Array))).toEqual([{ m: 1 }]);
  });

  it('hands a non-memory sink body on for the upload to own', async () => {
    const body = createMemoryBody([new Uint8Array([1, 2, 3])]);
    const sink = {
      open: () =>
        Promise.resolve({
          write: () => Promise.resolve(),
          finish: () => Promise.resolve({ ...body, peek: () => undefined }),
          abort: () => Promise.resolve(),
        }),
    };
    const bundle = await assembleFromSnapshot(
      request(),
      snapshotOf([]),
      defaultEntryFactory,
      context({ sink }),
    );
    expect(isBundleBody(bundle.body)).toBe(true);
  });

  it('releases the snapshot and rethrows when the build fails', async () => {
    const snap = snapshotOf([stored('log', 1_000, { m: 1 })]);
    const failing = {
      open: () =>
        Promise.resolve({
          write: () => Promise.reject(new Error('disk full')),
          finish: () => Promise.reject(new Error('unused')),
          abort: () => Promise.resolve(),
        }),
    };
    await expect(
      assembleFromSnapshot(request(), snap, defaultEntryFactory, context({ sink: failing })),
    ).rejects.toThrow('disk full');
    expect(snap.releases).toBe(1);
  });

  it('exposes nothing about the sink default: the same sink instance is reusable', async () => {
    const sink = createMemorySink();
    const one = await assembleFromSnapshot(
      request(),
      snapshotOf([]),
      defaultEntryFactory,
      context({ sink }),
    );
    const two = await assembleFromSnapshot(
      request(),
      snapshotOf([]),
      defaultEntryFactory,
      context({ sink }),
    );
    expect(one.body).toBeInstanceOf(Uint8Array);
    expect(two.body).toBeInstanceOf(Uint8Array);
  });
});

describe('enqueueOwningBody', () => {
  const bundleWith = (dispose: () => void): Bundle =>
    ({
      request: {} as never,
      fileName: 'f',
      body: { ...createMemoryBody([new Uint8Array(1)]), dispose },
    }) as Bundle;

  it('returns the pipeline result and leaves disposal to the pipeline', async () => {
    const dispose = vi.fn();
    const result = { ok: true } as never;
    const out = await enqueueOwningBody(
      { enqueue: () => Promise.resolve(result) },
      bundleWith(dispose),
    );
    expect(out).toBe(result);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('disposes the body and rethrows when the pipeline throws', async () => {
    const dispose = vi.fn();
    await expect(
      enqueueOwningBody({ enqueue: () => Promise.reject(new Error('boom')) }, bundleWith(dispose)),
    ).rejects.toThrow('boom');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not let a failing dispose replace the original failure', async () => {
    await expect(
      enqueueOwningBody(
        { enqueue: () => Promise.reject(new Error('boom')) },
        bundleWith(() => {
          throw new Error('dispose failed');
        }),
      ),
    ).rejects.toThrow('boom');
  });

  it('does not let a rejecting dispose surface as an unhandled rejection', async () => {
    const dispose = vi.fn(() => Promise.reject(new Error('dispose rejected')));
    await expect(
      enqueueOwningBody({ enqueue: () => Promise.reject(new Error('boom')) }, bundleWith(dispose)),
    ).rejects.toThrow('boom');
    await Promise.resolve();
    await Promise.resolve();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('is fine with a plain-bytes body', async () => {
    const bundle = { request: {} as never, fileName: 'f', body: new Uint8Array(1) } as Bundle;
    await expect(
      enqueueOwningBody({ enqueue: () => Promise.reject(new Error('boom')) }, bundle),
    ).rejects.toThrow('boom');
  });
});
