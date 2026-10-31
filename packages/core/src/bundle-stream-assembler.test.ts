import type { EnvironmentEnvelope, FileType } from '@bugsee/protocol';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleBundle, type BundleAssemblyContext } from './bundle-assembler';
import { assembleBundleStream } from './bundle-stream-assembler';
import { CaptureDataEntryBase } from './capture-data-entry';
import type { CaptureDataEntry } from './contracts';
import type { CrashJson } from './crash';
import { createReportingRequest } from './reporting';

// The streaming assembler must produce a bundle that unzips to EXACTLY what the buffered one does (member names,
// bytes, manifest), for the same captured data — that is what makes it a drop-in. Member ORDER inside the zip and the
// order of the manifest's `files` are not part of the contract (the worker reads the central directory), so both are
// compared as sets.

const env: EnvironmentEnvelope = {
  platform: { type: 'web', version: '124' },
  runtime: { type: 'web', version: '' },
  sdk: { version: '1.0.0', type: 'javascript' },
};
const context = (over: Partial<BundleAssemblyContext> = {}): BundleAssemblyContext => ({
  appToken: 'tok_123',
  environment: env,
  attributes: { a: 'b' },
  clock: { wallNow: () => 1_700_000_000_000, monotonicNow: () => 0 },
  fileName: () => 'fixed.bundle.zip',
  ...over,
});
const entry = (type: FileType, timestamp: number, data: unknown): CaptureDataEntry =>
  new CaptureDataEntryBase(type, timestamp, data);

async function* from(entries: CaptureDataEntry[]): AsyncIterable<CaptureDataEntry> {
  for (const e of entries) yield e;
}
const group = (entries: CaptureDataEntry[]): Map<FileType, CaptureDataEntry[]> => {
  const map = new Map<FileType, CaptureDataEntry[]>();
  for (const e of entries) map.set(e.type, [...(map.get(e.type) ?? []), e]);
  return map;
};

// Both assemblers draw random names (user attachments, the default file name): feed them the same sequence.
function seedRandom(): void {
  let n = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => ((n++ * 0.137) % 1) as number);
}
afterEach(() => vi.restoreAllMocks());

const members = (body: Uint8Array) => unzipSync(body) as Record<string, Uint8Array>;
const normalized = (files: Record<string, Uint8Array>) => {
  const out: Record<string, unknown> = {};
  for (const [name, bytes] of Object.entries(files)) {
    if (name === 'manifest.json') {
      const manifest = JSON.parse(strFromU8(bytes)) as { files: Array<{ filename: string }> };
      manifest.files.sort((a, b) => a.filename.localeCompare(b.filename));
      out[name] = manifest;
    } else {
      out[name] = Array.from(bytes);
    }
  }
  return out;
};

async function bothWays(
  entries: CaptureDataEntry[],
  request = createReportingRequest({ source: { type: 'error' }, id: 'r1' }),
  over: Partial<BundleAssemblyContext> = {},
) {
  seedRandom();
  const buffered = assembleBundle(request, group(entries), context(over));
  vi.restoreAllMocks();
  seedRandom();
  const streamed = await assembleBundleStream(request, from(entries), context(over));
  const streamedBytes = await streamed.body.bytes();
  return {
    buffered,
    streamed,
    a: normalized(members(buffered.body)),
    b: normalized(members(streamedBytes)),
  };
}

describe('assembleBundleStream — equals the buffered assembler', () => {
  it('for plain JSON types, interleaved in time order', async () => {
    const r = await bothWays([
      entry('log', 1, { m: 'a' }),
      entry('network', 2, { url: 'u' }),
      entry('log', 3, { m: 'b' }),
      entry('events.user', 4, { name: 'e' }),
    ]);
    expect(r.b).toEqual(r.a);
    expect(Object.keys(r.b)).toEqual(
      expect.arrayContaining(['logs.json', 'request.json', 'apptoken']),
    );
  });

  it('for every wrapped shape: performance, input, video.aux, and the single-object profile', async () => {
    const r = await bothWays([
      entry('performance', 1, { n: 1 }),
      entry('performance', 2, { n: 2 }),
      entry('input', 3, { k: 1 }),
      entry('input', 4, { k: 2 }),
      entry('video.aux', 5, { f: 1 }),
      entry('video.aux', 6, { f: 2 }),
      entry('profile', 7, { nodes: [1] }),
    ]);
    expect(r.b).toEqual(r.a);
  });

  it('keeps only the FIRST profile, as the buffered assembler does', async () => {
    const r = await bothWays([
      entry('profile', 1, { first: true }),
      entry('profile', 2, { second: true }),
    ]);
    expect(r.b).toEqual(r.a);
    expect(strFromU8(unzipSync(await r.streamed.body.bytes())['profile.json'] as Uint8Array)).toBe(
      '{"first":true}',
    );
  });

  it('for an entry whose data is undefined (it must read null inside the array, not break the JSON)', async () => {
    const r = await bothWays([entry('log', 1, undefined), entry('log', 2, { a: 1 })]);
    expect(r.b).toEqual(r.a);
    expect(strFromU8(unzipSync(await r.streamed.body.bytes())['logs.json'] as Uint8Array)).toBe(
      '[null,{"a":1}]',
    );
  });

  it('with nothing captured: request.json, manifest.json and apptoken only', async () => {
    const r = await bothWays([]);
    expect(r.b).toEqual(r.a);
    expect(Object.keys(r.b).sort()).toEqual(['apptoken', 'manifest.json', 'request.json']);
  });

  it('for a binary type routed through its injected encoder (replay -> bytes)', async () => {
    const fileEncoders = { replay: (payloads: unknown[]) => Uint8Array.from([7, payloads.length]) };
    const r = await bothWays(
      [entry('replay', 1, { e: 1 }), entry('log', 2, {}), entry('replay', 3, { e: 2 })],
      undefined,
      { fileEncoders },
    );
    expect(r.b).toEqual(r.a);
    expect(
      Array.from(unzipSync(await r.streamed.body.bytes())['replay.bin'] as Uint8Array),
    ).toEqual([7, 2]);
  });

  it('for a video entry (its container format rides in the manifest)', async () => {
    const r = await bothWays([entry('video', 1, { x: 1 })]);
    expect(r.b).toEqual(r.a);
  });

  it('with a crash, report attachments and user attachments', async () => {
    const crash: CrashJson = {
      exception_type: 'error',
      ndkCrash: false,
      handled: true,
      exception: { name: 'TypeError', reason: 'boom', frames: [] },
    };
    const request = createReportingRequest({
      source: { type: 'error' },
      id: 'r1',
      crash,
      attachments: [{ name: 'dump-1.dmp', data: new Uint8Array([1, 2, 3]) }],
      userAttachments: [{ name: 'note', data: 'héllo' }],
    });
    const r = await bothWays([entry('log', 1, { m: 1 })], request);
    expect(r.b).toEqual(r.a);
    expect(Object.keys(r.b)).toEqual(expect.arrayContaining(['crash.json', 'dump-1.dmp']));
  });

  it('skips an attachment whose name clashes with a captured data member, and reports it', async () => {
    const request = createReportingRequest({
      source: { type: 'error' },
      id: 'r1',
      attachments: [{ name: 'logs.json', data: new Uint8Array([1]) }],
    });
    const errors: unknown[] = [];
    const r = await bothWays([entry('log', 1, {})], request, { onError: (e) => errors.push(e) });
    expect(r.b).toEqual(r.a);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('with the request context user and attributes (manifest attrs and request.json)', async () => {
    const r = await bothWays([entry('log', 1, {})], undefined, {
      requestContext: { contextId: 'c1', user: 'u@x.y', attributes: { k: 'v' } },
    });
    expect(r.b).toEqual(r.a);
  });

  it('returns the same request and file name', async () => {
    const r = await bothWays([entry('log', 1, {})]);
    expect(r.streamed.request).toEqual(r.buffered.request);
    expect(r.streamed.fileName).toBe('fixed.bundle.zip');
  });

  it('defaults the file name like the buffered assembler (<random20>.bundle.zip)', async () => {
    const request = createReportingRequest({ source: { type: 'error' }, id: 'r1' });
    const streamed = await assembleBundleStream(
      request,
      from([]),
      context({ fileName: undefined }),
    );
    expect(streamed.fileName).toMatch(/^[a-z0-9]{20}\.bundle\.zip$/);
  });
});

describe('assembleBundleStream — time bounds and merging', () => {
  it('sets time.start to the earliest timestamp across the stream, the encoder types and the extra entries', async () => {
    const request = createReportingRequest({ source: { type: 'error' }, id: 'r1' });
    const fileEncoders = { replay: (p: unknown[]) => Uint8Array.from([p.length]) };
    const streamed = await assembleBundleStream(
      request,
      from([entry('log', 500, {}), entry('replay', 300, {})]),
      context({ fileEncoders }),
      new Map([['viewtree', [entry('viewtree', 100, {})]]]),
    );
    const manifest = JSON.parse(
      strFromU8(unzipSync(await streamed.body.bytes())['manifest.json'] as Uint8Array),
    );
    expect(manifest.time).toEqual({ start: 100, end: 1_700_000_000_000 });
  });

  it('merges report-time snapshot entries into the same member as the streamed ones, after them', async () => {
    const request = createReportingRequest({ source: { type: 'error' }, id: 'r1' });
    const streamed = await assembleBundleStream(
      request,
      from([entry('log', 1, { s: 1 })]),
      context(),
      new Map([
        ['log', [entry('log', 9, { x: 1 })]],
        ['viewtree', [entry('viewtree', 9, { v: 1 })]],
      ]),
    );
    const files = unzipSync(await streamed.body.bytes());
    expect(strFromU8(files['logs.json'] as Uint8Array)).toBe('[{"s":1},{"x":1}]');
    expect(Object.keys(files)).toContain('viewtree.json');
  });
});

describe('assembleBundleStream — failure', () => {
  it('refuses a duplicate member name exactly as the buffered assembler does (never writes two crash.json)', async () => {
    const crash: CrashJson = {
      exception_type: 'error',
      ndkCrash: false,
      handled: true,
      exception: { name: 'E', reason: 'r', frames: [] },
    };
    const request = createReportingRequest({ source: { type: 'error' }, id: 'r1', crash });
    const entries = [entry('crash', 1, { x: 1 })];
    expect(() => assembleBundle(request, group(entries), context())).toThrow(
      /duplicate file name: crash.json/,
    );
    await expect(assembleBundleStream(request, from(entries), context())).rejects.toThrow(
      /duplicate file name: crash.json/,
    );
  });

  it('closes the source even when the failure comes BEFORE its first entry is read (the snapshot is never leaked)', async () => {
    let closed = 0;
    const source: AsyncIterableIterator<CaptureDataEntry> = {
      next: async () => ({ done: true, value: undefined }),
      return: async () => {
        closed += 1;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    // A signature that cannot be serialized makes request.json throw before the data pass starts.
    const request = createReportingRequest({
      source: { type: 'error' },
      id: 'r1',
      signatures: [{ n: 1n } as never],
    });
    await expect(assembleBundleStream(request, source, context())).rejects.toThrow();
    expect(closed).toBe(1);
  });

  it('closes the source when the failure comes from building request.json itself (a bad clock)', async () => {
    let acquired = 0;
    let closed = 0;
    const source: AsyncIterableIterator<CaptureDataEntry> = {
      next: async () => ({ done: true, value: undefined }),
      return: async () => {
        closed += 1;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        acquired += 1;
        return this;
      },
    };
    const request = createReportingRequest({ source: { type: 'error' }, id: 'r1' });
    await expect(
      assembleBundleStream(
        request,
        source,
        context({ clock: { wallNow: () => Number.NaN, monotonicNow: () => 0 } }),
      ),
    ).rejects.toThrow(RangeError);
    expect([acquired, closed]).toEqual([1, 1]);
  });

  it('copes with a source iterator that has no return()', async () => {
    const source: AsyncIterable<CaptureDataEntry> = {
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
    };
    const request = createReportingRequest({
      source: { type: 'error' },
      id: 'r1',
      signatures: [{ n: 1n } as never],
    });
    await expect(assembleBundleStream(request, source, context())).rejects.toThrow(/BigInt/);
  });

  it('reports the ORIGINAL failure when closing the source fails too', async () => {
    const source: AsyncIterableIterator<CaptureDataEntry> = {
      next: async () => ({ done: true, value: undefined }),
      return: async () => {
        throw new Error('release failed');
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const request = createReportingRequest({
      source: { type: 'error' },
      id: 'r1',
      signatures: [{ n: 1n } as never],
    });
    await expect(assembleBundleStream(request, source, context())).rejects.toThrow(/BigInt/);
  });

  it('closes the source when a mid-pass failure ends the loop (closing is idempotent, so a second call is harmless)', async () => {
    let closed = 0;
    let served = false;
    const source: AsyncIterableIterator<CaptureDataEntry> = {
      next: async () => {
        if (served) return { done: true, value: undefined };
        served = true;
        return { done: false, value: entry('log', 1, { n: 10n }) }; // serializing it throws
      },
      return: async () => {
        closed += 1;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const request = createReportingRequest({ source: { type: 'error' }, id: 'r1' });
    await expect(assembleBundleStream(request, source, context())).rejects.toThrow();
    expect(closed).toBeGreaterThanOrEqual(1);
  });

  it('closes the source exactly once when reading it fails (only the outer cleanup can do that)', async () => {
    let closed = 0;
    const source: AsyncIterableIterator<CaptureDataEntry> = {
      next: async () => {
        throw new Error('read failed');
      },
      return: async () => {
        closed += 1;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    const request = createReportingRequest({ source: { type: 'error' }, id: 'r1' });
    await expect(assembleBundleStream(request, source, context())).rejects.toThrow('read failed');
    expect(closed).toBe(1);
  });

  it('rejects, like the buffered assembler throws, when an entry cannot be serialized (BigInt)', async () => {
    const request = createReportingRequest({ source: { type: 'error' }, id: 'r1' });
    const entries = [entry('log', 1, { n: 10n })];
    expect(() => assembleBundle(request, group(entries), context())).toThrow();
    await expect(assembleBundleStream(request, from(entries), context())).rejects.toThrow();
  });

  it('rejects when the source fails mid-stream, instead of returning a truncated bundle', async () => {
    const request = createReportingRequest({ source: { type: 'error' }, id: 'r1' });
    async function* broken(): AsyncIterable<CaptureDataEntry> {
      yield entry('log', 1, {});
      throw new Error('read failed');
    }
    await expect(assembleBundleStream(request, broken(), context())).rejects.toThrow('read failed');
  });
});
