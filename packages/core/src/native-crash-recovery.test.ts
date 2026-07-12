import type { EnvironmentEnvelope, FileType } from '@bugsee/protocol';
import { strFromU8, unzipSync } from '@bugsee/util';
import { describe, expect, it, vi } from 'vitest';
import type { BundleAssemblyContext } from './bundle-assembler';
import type { FrozenPart, PartMeta } from './chunk-backend';
import type { CaptureSnapshot, StoredEntry } from './contracts';
import {
  type CrashpadSessionMarker,
  type HarvestedDump,
  type NativeCrashSource,
  recoverNativeCrashes,
} from './native-crash-recovery';
import type { Bundle } from './transport';

const env: EnvironmentEnvelope = {
  platform: { type: 'electron-main', version: '30' },
  sdk: { version: '1.0.0', type: 'javascript' },
};

const baseContext = (): Omit<BundleAssemblyContext, 'attributes' | 'userIdentifier'> => ({
  appToken: 'tok_123',
  environment: env,
  clock: { wallNow: () => 1_700_000_000_000, monotonicNow: () => 0 },
  fileName: () => 'fixed.bundle.zip',
});

const marker = (over: Partial<CrashpadSessionMarker> = {}): CrashpadSessionMarker => ({
  generation: 42,
  sessionId: 'sess-dead',
  dumpDir: '/crashpad/db',
  attributes: {},
  userIdentifier: null,
  ...over,
});

/** A stored record whose `serialized` carries a real `{timestamp, data}` envelope (base entry codec). */
function stored(type: FileType, data: unknown): StoredEntry {
  return { type, timestamp: 5, serialized: JSON.stringify({ timestamp: 5, data }) } as StoredEntry;
}

/** A fake chunk backend that records snapshot() calls and drains a fixed grouped record set. */
function fakeBackend(grouped: Map<FileType, StoredEntry[]> = new Map()) {
  const snapshotCalls: FrozenPart[][] = [];
  const parts: PartMeta[] = [
    { generation: 0, number: 0, start: 0, end: 1, byteSize: 1 } as PartMeta,
  ];
  return {
    snapshotCalls,
    backend: {
      listParts: (_gen: number): PartMeta[] => parts,
      snapshot(frozen: readonly FrozenPart[]): CaptureSnapshot {
        snapshotCalls.push([...frozen]);
        let released = false;
        return {
          drainAll: () => Promise.resolve(grouped),
          stream: async function* () {},
          release() {
            released = true;
          },
          get released() {
            return released;
          },
        } as unknown as CaptureSnapshot;
      },
    },
  };
}

/** A fake native-crash source over a fixed dump list, recording claims. */
function fakeSource(dumps: HarvestedDump[]): NativeCrashSource & { claims: string[] } {
  const claims: string[] = [];
  return {
    claims,
    harvest: () => dumps,
    claim(_m: CrashpadSessionMarker, name: string) {
      claims.push(name);
    },
  };
}

/** A fake upload pipeline recording every enqueued bundle; `ok` toggles delivery success. */
function fakePipeline(ok = true) {
  const enqueued: Bundle[] = [];
  return {
    enqueued,
    pipeline: {
      enqueue: vi.fn((bundle: Bundle) => {
        enqueued.push(bundle);
        return Promise.resolve({ ok });
      }),
    },
  };
}

function unzip(body: Uint8Array) {
  const files = unzipSync(body);
  const text = (name: string): string => strFromU8(files[name] as Uint8Array);
  return {
    names: Object.keys(files),
    request: JSON.parse(text('request.json')),
    manifest: JSON.parse(text('manifest.json')),
    text,
    bytes: (name: string): Uint8Array => files[name] as Uint8Array,
  };
}

const dump = (name: string, ...bytes: number[]): HarvestedDump => ({
  name,
  data: new Uint8Array(bytes),
});

describe('recoverNativeCrashes', () => {
  it('synthesizes a crash bundle per harvested dump: native crash.json + the .dmp attachment + drained capture', async () => {
    const grouped = new Map<FileType, StoredEntry[]>([
      ['log', [stored('log', { m: 'before-crash' })]],
    ]);
    const { backend } = fakeBackend(grouped);
    const source = fakeSource([dump('main.dmp', 1, 2, 3)]);
    const { pipeline, enqueued } = fakePipeline();

    const result = await recoverNativeCrashes({
      backend,
      marker: marker(),
      source,
      context: baseContext,
      uploadPipeline: pipeline,
      generateId: () => 'nc-1',
    });

    expect(result).toEqual({ harvested: 1, delivered: 1, complete: true });
    expect(enqueued).toHaveLength(1);
    const out = unzip(enqueued[0]!.body);
    // request.json is a native crash.
    expect(out.request.type).toBe('crash');
    expect(out.request.severity).toBe(5); // blocker
    // crash.json is the NATIVE shape referencing the attached dump.
    expect(JSON.parse(out.text('crash.json'))).toEqual({
      exception_type: 'native',
      ndkCrash: true,
      minidumpFile: 'main.dmp',
    });
    // The .dmp rides as a verbatim attachment.
    expect(Array.from(out.bytes('main.dmp'))).toEqual([1, 2, 3]);
    // The crashed session's preserved capture is stitched in.
    expect(JSON.parse(out.text('logs.json'))).toEqual([{ m: 'before-crash' }]);
    // Delivered dump is claimed so it is never re-uploaded.
    expect(source.claims).toEqual(['main.dmp']);
  });

  it('harvests from the crashed generation and drains its capture exactly ONCE across all dumps', async () => {
    const { backend, snapshotCalls } = fakeBackend();
    const source = fakeSource([dump('a.dmp', 1), dump('b.dmp', 2)]);
    const { pipeline, enqueued } = fakePipeline();

    const result = await recoverNativeCrashes({
      backend,
      marker: marker({ generation: 7 }),
      source,
      context: baseContext,
      uploadPipeline: pipeline,
    });

    expect(result).toEqual({ harvested: 2, delivered: 2, complete: true });
    expect(enqueued).toHaveLength(2);
    // ONE snapshot, over generation 7's parts.
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0]?.[0]?.ref).toEqual({ generation: 7, number: 0 });
    expect(source.claims).toEqual(['a.dmp', 'b.dmp']);
  });

  it('does nothing (no drain, no enqueue) when the session harvested no dumps — but is complete (clearable)', async () => {
    const { backend, snapshotCalls } = fakeBackend();
    const source = fakeSource([]);
    const { pipeline, enqueued } = fakePipeline();

    const result = await recoverNativeCrashes({
      backend,
      marker: marker(),
      source,
      context: baseContext,
      uploadPipeline: pipeline,
    });

    expect(result).toEqual({ harvested: 0, delivered: 0, complete: true });
    expect(snapshotCalls).toHaveLength(0); // never drained
    expect(enqueued).toHaveLength(0);
  });

  it('leaves an undelivered dump unclaimed and reports incomplete (marker kept for retry)', async () => {
    const { backend } = fakeBackend();
    const source = fakeSource([dump('main.dmp', 9)]);
    const { pipeline } = fakePipeline(false); // enqueue returns !ok

    const result = await recoverNativeCrashes({
      backend,
      marker: marker(),
      source,
      context: baseContext,
      uploadPipeline: pipeline,
    });

    expect(result).toEqual({ harvested: 1, delivered: 0, complete: false });
    expect(source.claims).toEqual([]); // not claimed → re-harvestable next launch
  });

  it("stamps the marker's snapshot attributes + user identifier onto the recovered bundle", async () => {
    const { backend } = fakeBackend();
    const source = fakeSource([dump('main.dmp', 1)]);
    const { pipeline, enqueued } = fakePipeline();

    await recoverNativeCrashes({
      backend,
      marker: marker({ attributes: { build: '30.1' }, userIdentifier: 'user@x.io' }),
      source,
      context: baseContext,
      uploadPipeline: pipeline,
    });

    const out = unzip(enqueued[0]!.body);
    expect(out.manifest.attrs).toEqual({ build: '30.1' });
    expect(out.request.email).toBe('user@x.io'); // user identifier → request.json email
  });

  it('routes a harvest failure to onError, enqueues nothing, and reports incomplete (marker kept)', async () => {
    const { backend, snapshotCalls } = fakeBackend();
    const boom = new Error('harvest boom');
    const source: NativeCrashSource = {
      harvest: () => {
        throw boom;
      },
      claim: () => {},
    };
    const { pipeline, enqueued } = fakePipeline();
    const onError = vi.fn();

    const result = await recoverNativeCrashes({
      backend,
      marker: marker(),
      source,
      context: baseContext,
      uploadPipeline: pipeline,
      onError,
    });

    expect(result).toEqual({ harvested: 0, delivered: 0, complete: false });
    expect(onError).toHaveBeenCalledWith(boom);
    expect(snapshotCalls).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it('isolates a per-dump enqueue failure: the error routes to onError and the other dumps still upload', async () => {
    const { backend } = fakeBackend();
    const source = fakeSource([dump('bad.dmp', 1), dump('good.dmp', 2)]);
    const enqueued: Bundle[] = [];
    const boom = new Error('enqueue boom');
    const pipeline = {
      enqueue: vi.fn((bundle: Bundle) => {
        if (JSON.parse(strFromU8(unzipSync(bundle.body)['crash.json'] as Uint8Array)).minidumpFile === 'bad.dmp') {
          throw boom;
        }
        enqueued.push(bundle);
        return Promise.resolve({ ok: true });
      }),
    };
    const onError = vi.fn();

    const result = await recoverNativeCrashes({
      backend,
      marker: marker(),
      source,
      context: baseContext,
      uploadPipeline: pipeline,
      onError,
    });

    expect(onError).toHaveBeenCalledWith(boom);
    expect(result).toEqual({ harvested: 2, delivered: 1, complete: false });
    expect(source.claims).toEqual(['good.dmp']); // only the delivered one
  });

  it('swallows a per-dump failure with the default (no-op) onError — never throws into launch', async () => {
    const { backend } = fakeBackend();
    const source = fakeSource([dump('main.dmp', 1)]);
    const pipeline = {
      enqueue: vi.fn(() => {
        throw new Error('enqueue boom');
      }),
    };

    // No onError supplied → the default no-op absorbs the failure; the call resolves, does not reject.
    const result = await recoverNativeCrashes({
      backend,
      marker: marker(),
      source,
      context: baseContext,
      uploadPipeline: pipeline,
    });

    expect(result).toEqual({ harvested: 1, delivered: 0, complete: false });
    expect(source.claims).toEqual([]);
  });

  it('awaits a promise-returning harvest seam (async Crashpad-dir read)', async () => {
    const { backend } = fakeBackend();
    const source: NativeCrashSource & { claims: string[] } = {
      claims: [],
      harvest: () => Promise.resolve([dump('main.dmp', 1)]),
      claim(_m, name) {
        (source.claims as string[]).push(name);
      },
    };
    const { pipeline, enqueued } = fakePipeline();

    const result = await recoverNativeCrashes({
      backend,
      marker: marker(),
      source,
      context: baseContext,
      uploadPipeline: pipeline,
    });

    expect(result).toEqual({ harvested: 1, delivered: 1, complete: true });
    expect(enqueued).toHaveLength(1);
    expect(source.claims).toEqual(['main.dmp']);
  });
});
