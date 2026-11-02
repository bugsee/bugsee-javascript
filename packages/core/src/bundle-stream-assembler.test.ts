import type { EnvironmentEnvelope, FileType } from '@bugsee/protocol';
import { strFromU8, strToU8, unzipSync } from '@bugsee/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleBundle, type BundleAssemblyContext } from './bundle-assembler';
import { createMemoryBody } from './bundle-body';
import { assembleBundleStream } from './bundle-stream-assembler';
import { CaptureDataEntryBase } from './capture-data-entry';
import { createCaptureExporter } from './capture-exporter';
import { createChunkCaptureStore } from './chunk-capture-store';
import type { CaptureDataEntry } from './contracts';
import type { CrashJson } from './crash';
import { createMemoryChunkBackend } from './memory-chunk-backend';
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

describe('assembleBundleStream — time plan', () => {
  const withRange = (
    entries: CaptureDataEntry[],
    range: { start: number; end: number } | undefined,
  ): AsyncIterable<CaptureDataEntry> & { timeRange?: { start: number; end: number } } =>
    Object.assign(from(entries), range !== undefined ? { timeRange: range } : {});
  const run = async (
    entries: CaptureDataEntry[],
    range: { start: number; end: number } | undefined,
    over: Partial<BundleAssemblyContext> = {},
  ) => {
    const request = createReportingRequest({ source: { type: 'error' }, id: 'r1' });
    const bundle = await assembleBundleStream(request, withRange(entries, range), context(over));
    return members(await bundle.body.bytes());
  };
  const manifestOf = (files: Record<string, Uint8Array>) =>
    JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)) as {
      time: { start: number; end: number };
      files: Array<{ filename: string }>;
    };
  const NOW = 1_700_000_000_000;

  it('takes manifest time.start from the plan, not from the earliest record', async () => {
    const files = await run([entry('log', NOW - 1000, 'a')], { start: NOW - 5000, end: NOW });
    expect(manifestOf(files).time).toEqual({ start: NOW - 5000, end: NOW });
  });

  it('keeps time.start at the plan even when no record was captured', async () => {
    const files = await run([], { start: NOW - 5000, end: NOW });
    expect(manifestOf(files).time).toEqual({ start: NOW - 5000, end: NOW });
  });

  it('ends the manifest time at the trigger moment (the clock), not the snapshot range end', async () => {
    const files = await run([], { start: NOW - 5000, end: NOW - 10 });
    expect(manifestOf(files).time.end).toBe(NOW);
  });

  it('drops non-replay records older than the plan start and keeps those at or after it', async () => {
    const files = await run(
      [
        entry('log', NOW - 6000, 'old'),
        entry('log', NOW - 5001, 'just-before'),
        entry('log', NOW - 5000, 'edge'),
        entry('log', NOW - 10, 'new'),
      ],
      { start: NOW - 5000, end: NOW },
    );
    const logs = JSON.parse(strFromU8(files['logs.json'] as Uint8Array)) as unknown[];
    expect(logs).toEqual(['edge', 'new']);
  });

  it('omits a member (and its manifest entry) whose records were all older than the plan start', async () => {
    const files = await run(
      [entry('log', NOW - 6000, 'old'), entry('events.user', NOW - 10, 'e')],
      {
        start: NOW - 5000,
        end: NOW,
      },
    );
    expect(files['logs.json']).toBeUndefined();
    expect(manifestOf(files).files.map((f) => f.filename)).not.toContain('logs.json');
  });

  it('does not trim a type that has an injected encoder (the encoder owns the clamp)', async () => {
    const seen: unknown[][] = [];
    const files = await run(
      [entry('replay', NOW - 9000, 'r')],
      { start: NOW - 5000, end: NOW },
      {
        fileEncoders: {
          replay: (payloads) => {
            seen.push(payloads);
            return new Uint8Array([1]);
          },
        },
      },
    );
    expect(seen).toEqual([['r']]);
    expect(files['replay.bin']).toBeDefined();
    expect(manifestOf(files).time.start).toBe(NOW - 5000);
  });

  it('falls back to the earliest record when the source states no range', async () => {
    const files = await run(
      [entry('log', NOW - 7000, 'a'), entry('log', NOW - 10, 'b')],
      undefined,
    );
    expect(manifestOf(files).time.start).toBe(NOW - 7000);
    expect(JSON.parse(strFromU8(files['logs.json'] as Uint8Array))).toEqual(['a', 'b']);
  });

  it('does not trim the report-time extras, and they do not move a planned start', async () => {
    const request = createReportingRequest({ source: { type: 'error' }, id: 'r1' });
    const bundle = await assembleBundleStream(
      request,
      withRange([], { start: NOW - 5000, end: NOW }),
      context(),
      new Map([['events.user', [entry('events.user', NOW - 9000, 'x')]]]),
    );
    const files = members(await bundle.body.bytes());
    expect(JSON.parse(strFromU8(files['events.user.json'] as Uint8Array))).toEqual(['x']);
    expect(manifestOf(files).time.start).toBe(NOW - 5000);
  });

  it('end to end: a real chunk store, through the exporter, bounds the manifest and trims old logs', async () => {
    let now = NOW - 20_000;
    const clock = { wallNow: () => now, monotonicNow: () => 0 };
    const store = createChunkCaptureStore(createMemoryChunkBackend(), {
      clock,
      maxRecordingTimeMs: 5000,
    });
    store.add({
      type: 'log',
      timestamp: NOW - 6000,
      serialized: JSON.stringify({ timestamp: NOW - 6000, data: 'old' }),
    });
    store.add({
      type: 'log',
      timestamp: NOW - 100,
      serialized: JSON.stringify({ timestamp: NOW - 100, data: 'new' }),
    });
    now = NOW;
    const bundle = await assembleBundleStream(
      createReportingRequest({ source: { type: 'error' }, id: 'r1' }),
      createCaptureExporter(store).stream(),
      context(),
    );
    const files = members(await bundle.body.bytes());
    expect(manifestOf(files).time).toEqual({ start: NOW - 5000, end: NOW });
    expect(JSON.parse(strFromU8(files['logs.json'] as Uint8Array))).toEqual(['new']);
  });

  describe('stream encoders', () => {
    const NOW2 = 1_700_000_000_000;
    // A recording encoder: emits one chunk per entry, a trailer, and can declare itself empty.
    const recorder = (opts: { silent?: boolean; failOn?: unknown } = {}) => {
      const log: string[] = [];
      const plans: unknown[] = [];
      const encoder = {
        begin: (plan: unknown) => {
          plans.push(plan);
          return {
            write: (e: CaptureDataEntry) => {
              if (e.data === opts.failOn) throw new Error('bad record');
              log.push(`w:${String(e.data)}`);
              return opts.silent === true ? [] : [strToU8(`<${String(e.data)}>`)];
            },
            end: () => {
              log.push('end');
              return opts.silent === true ? [] : [strToU8('|end')];
            },
          };
        },
      };
      return { encoder, log, plans };
    };
    const runEnc = async (
      entries: CaptureDataEntry[],
      range: { start: number; end: number } | undefined,
      over: Partial<BundleAssemblyContext>,
    ) => {
      const src = Object.assign(from(entries), range !== undefined ? { timeRange: range } : {});
      const bundle = await assembleBundleStream(
        createReportingRequest({ source: { type: 'error' }, id: 'r1' }),
        src,
        context(over),
      );
      return members(await bundle.body.bytes());
    };
    const mf = (files: Record<string, Uint8Array>) =>
      JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)) as {
        time: { start: number; end: number };
        files: Array<{ filename: string; type: string }>;
      };

    it('feeds entries in order, writes the chunks into the member and lists it in the manifest', async () => {
      const { encoder, log, plans } = recorder();
      const files = await runEnc(
        [
          entry('replay', NOW2 - 9000, 'a'),
          entry('log', NOW2 - 10, 'l'),
          entry('replay', NOW2 - 8000, 'b'),
        ],
        { start: NOW2 - 5000, end: NOW2 },
        { streamEncoders: { replay: encoder } },
      );
      expect(strFromU8(files['replay.bin'] as Uint8Array)).toBe('<a><b>|end');
      expect(log).toEqual(['w:a', 'w:b', 'end']);
      expect(plans).toEqual([{ start: NOW2 - 5000, end: NOW2 }]);
      expect(mf(files).files.map((f) => f.filename)).toContain('replay.bin');
    });

    it('begins the session with an absent start when the source states no range', async () => {
      const { encoder, plans } = recorder();
      await runEnc([entry('replay', NOW2 - 100, 'a')], undefined, {
        streamEncoders: { replay: encoder },
      });
      expect(plans).toEqual([{ start: undefined, end: NOW2 }]);
    });

    it('omits the member and its manifest entry when the encoder produced no bytes', async () => {
      const { encoder } = recorder({ silent: true });
      const files = await runEnc([entry('replay', NOW2 - 100, 'a')], undefined, {
        streamEncoders: { replay: encoder },
      });
      expect(files['replay.bin']).toBeUndefined();
      expect(mf(files).files.map((f) => f.filename)).not.toContain('replay.bin');
    });

    it('skips a record whose write throws, reports it, and keeps the rest', async () => {
      const { encoder } = recorder({ failOn: 'bad' });
      const errors: unknown[] = [];
      const files = await runEnc(
        [
          entry('replay', NOW2 - 300, 'a'),
          entry('replay', NOW2 - 200, 'bad'),
          entry('replay', NOW2 - 100, 'b'),
        ],
        undefined,
        { streamEncoders: { replay: encoder }, onError: (e) => errors.push(e) },
      );
      expect(strFromU8(files['replay.bin'] as Uint8Array)).toBe('<a><b>|end');
      expect(errors).toHaveLength(1);
    });

    it('prefers the stream encoder over a buffered one for the same type', async () => {
      const { encoder } = recorder();
      const files = await runEnc([entry('replay', NOW2 - 100, 'a')], undefined, {
        streamEncoders: { replay: encoder },
        fileEncoders: { replay: () => new Uint8Array([9]) },
      });
      expect(strFromU8(files['replay.bin'] as Uint8Array)).toBe('<a>|end');
    });

    it('does not trim a streamed type by the plan start (the encoder clamps)', async () => {
      const { encoder, log } = recorder();
      await runEnc(
        [entry('replay', NOW2 - 9000, 'old')],
        { start: NOW2 - 5000, end: NOW2 },
        {
          streamEncoders: { replay: encoder },
        },
      );
      expect(log).toEqual(['w:old', 'end']);
    });

    it('closes cleanly when the stream encoder never saw an entry (no session, no member)', async () => {
      const { encoder, plans } = recorder();
      const files = await runEnc([], undefined, { streamEncoders: { replay: encoder } });
      expect(plans).toEqual([]);
      expect(files['replay.bin']).toBeUndefined();
    });

    it('creates the member in end() when every chunk only appears there (buffering encoders)', async () => {
      const encoder = {
        begin: () => ({
          write: () => [],
          end: () => [strToU8('all-at-end')],
        }),
      };
      const files = await runEnc([entry('replay', NOW2 - 100, 'a')], undefined, {
        streamEncoders: { replay: encoder },
      });
      expect(strFromU8(files['replay.bin'] as Uint8Array)).toBe('all-at-end');
      expect(mf(files).files.map((f) => f.filename)).toContain('replay.bin');
    });

    it('fails the bundle and closes the source when end() throws', async () => {
      const encoder = {
        begin: () => ({
          write: () => [strToU8('x')],
          end: (): Uint8Array[] => {
            throw new Error('end failed');
          },
        }),
      };
      let closed = false;
      const source: AsyncIterable<CaptureDataEntry> = {
        [Symbol.asyncIterator]: () => {
          const it = from([entry('replay', NOW2 - 100, 'a')])[Symbol.asyncIterator]();
          return {
            next: () => it.next(),
            return: async () => {
              closed = true;
              return { done: true as const, value: undefined };
            },
          };
        },
      };
      await expect(
        assembleBundleStream(
          createReportingRequest({ source: { type: 'error' }, id: 'r1' }),
          source,
          context({ streamEncoders: { replay: encoder } }),
        ),
      ).rejects.toThrow('end failed');
      expect(closed).toBe(true);
    });

    it('fails the bundle (not a skipped record) when the member name clashes with another member', async () => {
      const { encoder } = recorder();
      const errors: unknown[] = [];
      const crash: CrashJson = {
        exception_type: 'error',
        ndkCrash: false,
        handled: true,
        exception: { name: 'E', reason: 'r', frames: [] },
      };
      await expect(
        assembleBundleStream(
          createReportingRequest({ source: { type: 'error' }, id: 'r2', crash }),
          from([entry('crash', NOW2 - 100, 'a')]),
          context({ streamEncoders: { crash: encoder }, onError: (e) => errors.push(e) }),
        ),
      ).rejects.toThrow(/duplicate file name: crash.json/);
      expect(errors).toEqual([]);
    });

    it('handles several streamed types and a mix with plain and buffered types, in first-seen order', async () => {
      const a = recorder();
      const b = recorder();
      const files = await runEnc(
        [
          entry('log', NOW2 - 300, 'l1'),
          entry('replay', NOW2 - 250, 'r1'),
          entry('viewtree', NOW2 - 200, 'v1'),
          entry('replay', NOW2 - 150, 'r2'),
          entry('events.user', NOW2 - 100, 'e1'),
        ],
        undefined,
        {
          streamEncoders: { replay: a.encoder, viewtree: b.encoder },
          fileEncoders: { 'events.user': () => strToU8('buffered') },
        },
      );
      expect(strFromU8(files['replay.bin'] as Uint8Array)).toBe('<r1><r2>|end');
      expect(strFromU8(files['viewtree.json'] as Uint8Array)).toBe('<v1>|end');
      expect(JSON.parse(strFromU8(files['logs.json'] as Uint8Array))).toEqual(['l1']);
      expect(strFromU8(files['events.user.json'] as Uint8Array)).toBe('buffered');
      expect(mf(files).files.map((f) => f.type)).toEqual([
        'log',
        'replay',
        'viewtree',
        'events.user',
      ]);
    });

    it('feeds report-time extras of a streamed type through the encoder too', async () => {
      const { encoder, log } = recorder();
      const bundle = await assembleBundleStream(
        createReportingRequest({ source: { type: 'error' }, id: 'r1' }),
        from([entry('replay', NOW2 - 100, 'a')]),
        context({ streamEncoders: { replay: encoder } }),
        new Map([['replay', [entry('replay', NOW2 - 50, 'x')]]]),
      );
      const files = members(await bundle.body.bytes());
      expect(strFromU8(files['replay.bin'] as Uint8Array)).toBe('<a><x>|end');
      expect(log).toEqual(['w:a', 'w:x', 'end']);
    });

    it('closes the source and rethrows the original error when it fails after a member was opened', async () => {
      const { encoder } = recorder();
      let closed = false;
      const source: AsyncIterable<CaptureDataEntry> = {
        [Symbol.asyncIterator]: () => {
          let n = 0;
          return {
            next: async () => {
              if (n++ === 0)
                return { done: false as const, value: entry('replay', NOW2 - 100, 'a') };
              throw new Error('source died');
            },
            return: async () => {
              closed = true;
              return { done: true as const, value: undefined };
            },
          };
        },
      };
      await expect(
        assembleBundleStream(
          createReportingRequest({ source: { type: 'error' }, id: 'r1' }),
          source,
          context({ streamEncoders: { replay: encoder } }),
        ),
      ).rejects.toThrow('source died');
      expect(closed).toBe(true);
    });

    it('passes the clock moment, not the snapshot range end, as plan.end', async () => {
      const { encoder, plans } = recorder();
      await runEnc(
        [entry('replay', NOW2 - 100, 'a')],
        { start: NOW2 - 5000, end: NOW2 - 77 },
        {
          streamEncoders: { replay: encoder },
        },
      );
      expect(plans).toEqual([{ start: NOW2 - 5000, end: NOW2 }]);
    });
  });
});

describe('assembleBundleStream — sink', () => {
  const NOWS = 1_700_000_000_000;
  const fakeSink = (opts: { failWriteAt?: number; slow?: boolean; failFinish?: boolean } = {}) => {
    const events: string[] = [];
    const written: Uint8Array[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const sink = {
      open: () => {
        events.push('open');
        return {
          write: async (chunk: Uint8Array) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            if (opts.slow === true) for (let i = 0; i < 5; i++) await Promise.resolve();
            if (opts.failWriteAt !== undefined && written.length === opts.failWriteAt) {
              inFlight -= 1;
              throw new Error('disk full');
            }
            written.push(chunk);
            inFlight -= 1;
          },
          finish: async () => {
            events.push('finish');
            if (opts.failFinish === true) throw new Error('finish failed');
            return createMemoryBody(written);
          },
          abort: async () => {
            events.push('abort');
          },
        };
      },
    };
    return { sink, events, written, maxInFlight: () => maxInFlight };
  };
  const request = () => createReportingRequest({ source: { type: 'error' }, id: 'r1' });

  it('writes the zip to the sink and returns the body the sink finished with', async () => {
    const { sink, events, written } = fakeSink();
    const bundle = await assembleBundleStream(
      request(),
      from([entry('log', NOWS - 5, 'a')]),
      context({ sink }),
    );
    expect(events).toEqual(['open', 'finish']);
    expect(written.length).toBeGreaterThan(0);
    const files = members(await bundle.body.bytes());
    expect(JSON.parse(strFromU8(files['logs.json'] as Uint8Array))).toEqual(['a']);
    expect(Array.from(await bundle.body.bytes())).toEqual(
      Array.from(written.flatMap((c) => Array.from(c))),
    );
  });

  it('produces the same archive through a custom sink as through the default one', async () => {
    const entries = [entry('log', NOWS - 5, 'a'), entry('network', NOWS - 4, { u: 1 })];
    const viaDefault = await assembleBundleStream(request(), from(entries), context());
    const { sink } = fakeSink();
    const viaSink = await assembleBundleStream(request(), from(entries), context({ sink }));
    expect(normalized(members(await viaSink.body.bytes()))).toEqual(
      normalized(members(await viaDefault.body.bytes())),
    );
  });

  it('aborts the writer, closes the source and rethrows when the sink fails to write', async () => {
    const { sink, events } = fakeSink({ failWriteAt: 0 });
    let closed = false;
    const source: AsyncIterable<CaptureDataEntry> = {
      [Symbol.asyncIterator]: () => {
        const it = from([entry('log', NOWS - 5, 'a')])[Symbol.asyncIterator]();
        return {
          next: () => it.next(),
          return: async () => {
            closed = true;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    await expect(assembleBundleStream(request(), source, context({ sink }))).rejects.toThrow(
      'disk full',
    );
    expect(events).toContain('abort');
    expect(events).not.toContain('finish');
    expect(closed).toBe(true);
  });

  it('fails the bundle when only the LAST chunks cannot be written (the end-of-build wait)', async () => {
    const probe = fakeSink();
    await assembleBundleStream(
      request(),
      from([entry('log', NOWS - 5, 'a')]),
      context({ sink: probe.sink }),
    );
    const total = probe.written.length;
    const { sink, events } = fakeSink({ failWriteAt: total - 1 });
    await expect(
      assembleBundleStream(request(), from([entry('log', NOWS - 5, 'a')]), context({ sink })),
    ).rejects.toThrow('disk full');
    expect(events).toContain('abort');
    expect(events).not.toContain('finish');
  });

  it('lets an in-flight write finish before it aborts the writer (no write after abort)', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sink = {
      open: () => ({
        write: async () => {
          order.push('write-start');
          await gate;
          order.push('write-end');
        },
        finish: async () => createMemoryBody([]),
        abort: async () => {
          order.push('abort');
        },
      }),
    };
    const crash: CrashJson = {
      exception_type: 'error',
      ndkCrash: false,
      handled: true,
      exception: { name: 'E', reason: 'r', frames: [] },
    };
    const pending = assembleBundleStream(
      createReportingRequest({ source: { type: 'error' }, id: 'r1', crash }),
      from([entry('crash', 1, { x: 1 })]),
      context({ sink }),
    ).catch((e: unknown) => e);
    for (let i = 0; i < 100; i++) await Promise.resolve();
    expect(order).not.toContain('abort'); // still waiting for the blocked write
    release();
    expect(await pending).toBeInstanceOf(Error);
    expect(order.filter((e) => e === 'abort')).toHaveLength(1);
    expect(order[order.length - 1]).toBe('abort'); // nothing is written after the abort
    expect(order.filter((e) => e === 'write-start').length).toBe(
      order.filter((e) => e === 'write-end').length,
    );
  });

  it('aborts the writer when finish() fails', async () => {
    const { sink, events } = fakeSink({ failFinish: true });
    await expect(assembleBundleStream(request(), from([]), context({ sink }))).rejects.toThrow(
      'finish failed',
    );
    expect(events).toEqual(['open', 'finish', 'abort']);
  });

  it('aborts the writer when the build itself fails (a duplicate member name)', async () => {
    const { sink, events } = fakeSink();
    const crash: CrashJson = {
      exception_type: 'error',
      ndkCrash: false,
      handled: true,
      exception: { name: 'E', reason: 'r', frames: [] },
    };
    await expect(
      assembleBundleStream(
        createReportingRequest({ source: { type: 'error' }, id: 'r1', crash }),
        from([entry('crash', 1, { x: 1 })]),
        context({ sink }),
      ),
    ).rejects.toThrow(/duplicate file name/);
    expect(events).toContain('abort');
  });

  it('a failing open() fails the bundle and closes the source', async () => {
    let closed = false;
    const source: AsyncIterable<CaptureDataEntry> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true as const, value: undefined }),
        return: async () => {
          closed = true;
          return { done: true as const, value: undefined };
        },
      }),
    };
    const sink = { open: () => Promise.reject(new Error('no temp dir')) };
    await expect(assembleBundleStream(request(), source, context({ sink }))).rejects.toThrow(
      'no temp dir',
    );
    expect(closed).toBe(true);
  });

  // Incompressible text, so the zip output is as big as the input and a slow sink actually backs up.
  // These tests deflate ~10 MB of incompressible text: ~1 s locally, but the coverage-instrumented CI runner is ~40x slower and
  // the default 30 s limit flaked (this file took 46 s there even when green).
  const SLOW_RUNNER_TIMEOUT_MS = 120_000;
  const noise = (seed: number, length: number): string => {
    let x = seed;
    let out = '';
    for (let i = 0; i < length; i++) {
      x = (x * 1664525 + 1013904223) >>> 0;
      out += String.fromCharCode(33 + ((x >>> 24) % 90));
    }
    return out;
  };

  it(
    'does not read ahead of a slow sink: the backlog stays bounded',
    async () => {
      let pulled = 0;
      async function* source(): AsyncIterable<CaptureDataEntry> {
        for (let i = 0; i < 30; i++) {
          pulled += 1;
          yield entry('log', NOWS - 100 + i, noise(i + 1, 300_000));
        }
      }
      const { sink, written, maxInFlight } = fakeSink({ slow: true });
      const pulledAtWrite: number[] = [];
      const slowSink = {
        open: async () => {
          const writer = await sink.open();
          return {
            ...writer,
            write: async (chunk: Uint8Array) => {
              pulledAtWrite.push(pulled);
              await writer.write(chunk);
            },
          };
        },
      };
      await assembleBundleStream(request(), source(), context({ sink: slowSink }));
      expect(written.length).toBeGreaterThan(1);
      expect(maxInFlight()).toBe(1); // writes are strictly sequential
      // Written chunks lag the reader by at most the backlog bound (a few entries), never the whole export.
      expect(Math.min(...pulledAtWrite.slice(0, 5))).toBeLessThan(30);
      expect(pulledAtWrite[0]).toBeLessThanOrEqual(8);
    },
    SLOW_RUNNER_TIMEOUT_MS,
  );

  it('stops reading entries once the sink has failed', async () => {
    let pulled = 0;
    async function* source(): AsyncIterable<CaptureDataEntry> {
      for (let i = 0; i < 300; i++) {
        pulled += 1;
        yield entry('log', NOWS - 100 + i, noise(i + 1, 2000));
      }
    }
    const { sink } = fakeSink({ failWriteAt: 0 });
    await expect(assembleBundleStream(request(), source(), context({ sink }))).rejects.toThrow(
      'disk full',
    );
    expect(pulled).toBeLessThan(5);
  });

  it(
    'holds the read-ahead to a bounded backlog while the sink is blocked, then completes once it is released',
    async () => {
      let pulled = 0;
      async function* source(): AsyncIterable<CaptureDataEntry> {
        for (let i = 0; i < 40; i++) {
          pulled += 1;
          yield entry('log', NOWS - 100 + i, noise(i + 1, 300_000));
        }
      }
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const written: Uint8Array[] = [];
      const sink = {
        open: () => ({
          write: async (chunk: Uint8Array) => {
            await gate;
            written.push(chunk);
          },
          finish: async () => createMemoryBody(written),
          abort: async () => {},
        }),
      };
      const pending = assembleBundleStream(request(), source(), context({ sink }));
      for (let i = 0; i < 200; i++) await Promise.resolve();
      expect(pulled).toBeLessThan(40); // blocked sink: the reader did not run away with the whole export
      open();
      await pending;
      expect(pulled).toBe(40);
    },
    SLOW_RUNNER_TIMEOUT_MS,
  );

  it('stops writing to a sink after its first failed write', async () => {
    let calls = 0;
    const sink = {
      open: () => ({
        write: async () => {
          calls += 1;
          throw new Error('disk full');
        },
        finish: async () => createMemoryBody([]),
        abort: async () => {},
      }),
    };
    const entries = Array.from({ length: 200 }, (_, i) =>
      entry('log', NOWS - 100 + i, noise(i + 1, 2000)),
    );
    await expect(assembleBundleStream(request(), from(entries), context({ sink }))).rejects.toThrow(
      'disk full',
    );
    expect(calls).toBe(1);
  });
});

describe('assembleBundleStream — one stream-encoded member per visual source lane', () => {
  const NOW3 = 1_700_000_000_000;
  const laned = (lane: string | undefined, at: number, data: string): CaptureDataEntry => {
    const e = new CaptureDataEntryBase('replay', at, data);
    if (lane !== undefined) e.lane = lane;
    return e;
  };
  const recorder = (silentLane?: string) => {
    const sessions: string[][] = [];
    const encoder = {
      begin: () => {
        const mine: string[] = [];
        sessions.push(mine);
        let silent = false;
        return {
          write: (e: CaptureDataEntry) => {
            mine.push(String(e.data));
            silent = e.lane === silentLane && silentLane !== undefined;
            return silent ? [] : [strToU8(`<${String(e.data)}>`)];
          },
          end: () => (silent ? [] : [strToU8('|end')]),
        };
      },
    };
    return { encoder, sessions };
  };
  const run = async (entries: CaptureDataEntry[], encoder: unknown) => {
    const bundle = await assembleBundleStream(
      createReportingRequest({ source: { type: 'error' }, id: 'r1' }),
      from(entries),
      context({ streamEncoders: { replay: encoder as never } }),
    );
    const files = members(await bundle.body.bytes());
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)) as {
      files: Array<{ filename: string; type: string; attrs?: Record<string, unknown> }>;
    };
    return { files, manifest };
  };

  it('writes each window its own member, the first under the canonical name, with its own encoder session', async () => {
    const { encoder, sessions } = recorder();
    const { files, manifest } = await run(
      [
        laned('3', NOW3 - 300, 'a1'),
        laned('9', NOW3 - 250, 'b1'),
        laned('3', NOW3 - 200, 'a2'),
        laned('9', NOW3 - 100, 'b2'),
      ],
      encoder,
    );
    expect(sessions).toEqual([
      ['a1', 'a2'],
      ['b1', 'b2'],
    ]);
    expect(strFromU8(files['replay.bin'] as Uint8Array)).toBe('<a1><a2>|end');
    expect(strFromU8(files['replay.1.bin'] as Uint8Array)).toBe('<b1><b2>|end');
    const replays = manifest.files.filter((f) => f.type === 'replay');
    expect(replays).toEqual([
      expect.objectContaining({ filename: 'replay.bin', attrs: { window: '3' } }),
      expect.objectContaining({ filename: 'replay.1.bin', attrs: { window: '9' } }),
    ]);
  });

  it('a window that produced nothing leaves no member and does not take the canonical name', async () => {
    const { encoder } = recorder('3');
    const { files, manifest } = await run(
      [laned('3', NOW3 - 300, 'quiet'), laned('9', NOW3 - 100, 'b1')],
      encoder,
    );
    expect(strFromU8(files['replay.bin'] as Uint8Array)).toBe('<b1>|end');
    expect(files['replay.1.bin']).toBeUndefined();
    expect(manifest.files.filter((f) => f.type === 'replay').map((f) => f.filename)).toEqual([
      'replay.bin',
    ]);
  });

  it('keeps unkeyed records in the one canonical member with no window attribute', async () => {
    const { encoder, sessions } = recorder();
    const { manifest } = await run(
      [laned(undefined, NOW3 - 200, 'u1'), laned(undefined, NOW3 - 100, 'u2')],
      encoder,
    );
    expect(sessions).toEqual([['u1', 'u2']]);
    expect(manifest.files.filter((f) => f.type === 'replay')).toEqual([
      { filename: 'replay.bin', type: 'replay' },
    ]);
  });

  it('ignores the lane of a type that has no stream encoder', async () => {
    const log = new CaptureDataEntryBase('log', NOW3 - 100, 'l');
    log.lane = '3';
    const bundle = await assembleBundleStream(
      createReportingRequest({ source: { type: 'error' }, id: 'r1' }),
      from([log, Object.assign(new CaptureDataEntryBase('log', NOW3 - 50, 'm'), { lane: '9' })]),
      context(),
    );
    const files = members(await bundle.body.bytes());
    expect(JSON.parse(strFromU8(files['logs.json'] as Uint8Array))).toEqual(['l', 'm']);
  });

  it("keeps the type's own manifest attrs next to the window (a laned video keeps its format)", async () => {
    const encoder = { begin: () => ({ write: () => [strToU8('v')], end: () => [] }) };
    const video = Object.assign(new CaptureDataEntryBase('video', NOW3 - 100, 'f'), { lane: '1' });
    const bundle = await assembleBundleStream(
      createReportingRequest({ source: { type: 'error' }, id: 'r1' }),
      from([video]),
      context({ streamEncoders: { video: encoder as never } }),
    );
    const files = members(await bundle.body.bytes());
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)) as {
      files: Array<{ type: string; attrs?: Record<string, unknown> }>;
    };
    expect(manifest.files.find((f) => f.type === 'video')?.attrs).toEqual({
      format: 'webm',
      displayId: 1,
    });
  });
});

describe('assembleBundleStream — one member per display for a buffered-encoder type (pixel video)', () => {
  const NOW4 = 1_700_000_000_000;
  const video = (lane: string | undefined, bytes: number[]): CaptureDataEntry => {
    const e = new CaptureDataEntryBase('video', NOW4 - 100, new Uint8Array(bytes));
    if (lane !== undefined) e.lane = lane;
    return e;
  };
  // The real pixel-video encoder concatenates every payload: a bundle with two displays must NOT reach it as one list.
  const encodeVideo = (payloads: unknown[]): Uint8Array =>
    Uint8Array.from((payloads as Uint8Array[]).flatMap((p) => [...p]));
  const run = async (entries: CaptureDataEntry[]) => {
    const bundle = await assembleBundleStream(
      createReportingRequest({ source: { type: 'error' }, id: 'r1' }),
      from(entries),
      context({ fileEncoders: { video: encodeVideo } }),
    );
    const files = members(await bundle.body.bytes());
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)) as {
      files: Array<{ filename: string; type: string; attrs?: Record<string, unknown> }>;
    };
    return { files, manifest };
  };

  it('writes each display its own video member, encoded on its own, with attrs.displayId', async () => {
    const { files, manifest } = await run([video('0', [1, 2]), video('1', [3, 4])]);
    expect([...(files['video.webm'] as Uint8Array)]).toEqual([1, 2]);
    expect([...(files['video.1.webm'] as Uint8Array)]).toEqual([3, 4]);
    expect(manifest.files.filter((f) => f.type === 'video')).toEqual([
      expect.objectContaining({ filename: 'video.webm', attrs: { format: 'webm', displayId: 0 } }),
      expect.objectContaining({
        filename: 'video.1.webm',
        attrs: { format: 'webm', displayId: 1 },
      }),
    ]);
  });

  it('an unkeyed video stays the one canonical member with no displayId', async () => {
    const { files, manifest } = await run([video(undefined, [9])]);
    expect([...(files['video.webm'] as Uint8Array)]).toEqual([9]);
    expect(manifest.files.find((f) => f.type === 'video')?.attrs).toEqual({ format: 'webm' });
  });

  it('a lane that is not a number is recorded as a window, not a display', async () => {
    const { manifest } = await run([video('win-a', [1])]);
    expect(manifest.files.find((f) => f.type === 'video')?.attrs).toEqual({
      format: 'webm',
      window: 'win-a',
    });
  });
});
