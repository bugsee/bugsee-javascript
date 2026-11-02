import type { Scheduler } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createCapturePageVideoSource,
  createDisplayVideoSource,
  createMediaRecorderVideoSource,
  type MediaRecorderLike,
} from './video-capture';

/** A scheduler that captures the interval callback so a test can tick it deterministically. */
function fakeScheduler() {
  let cb: (() => unknown) | undefined;
  let ms: number | undefined;
  let cleared = false;
  const scheduler: Scheduler = {
    setInterval: (callback, interval) => {
      cb = callback;
      ms = interval;
      return 'h1';
    },
    clearInterval: () => {
      cleared = true;
    },
  };
  return {
    scheduler,
    tick: () => (cb as () => Promise<void>)(),
    get ms() {
      return ms;
    },
    get started() {
      return cb !== undefined;
    },
    get cleared() {
      return cleared;
    },
  };
}

describe('createCapturePageVideoSource', () => {
  it('samples frames at the configured fps and, on snapshot, encodes the ring into ONE video entry', async () => {
    const s = fakeScheduler();
    let frame = 0;
    const capturePage = vi.fn(async () => new Uint8Array([frame++]));
    const encode = vi.fn(
      (frames: readonly { timestamp: number; bytes: Uint8Array }[], fps: number) =>
        new Uint8Array([0xff, fps, frames.length]),
    );
    const source = createCapturePageVideoSource({
      capturePage,
      scheduler: s.scheduler,
      encode,
      fps: 2,
      now: () => 1000,
    });
    source.start();
    expect(s.ms).toBe(500); // 1000 / fps(2)

    await s.tick();
    await s.tick();
    const entries = await source.snapshot(9);

    expect(capturePage).toHaveBeenCalledTimes(2);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode.mock.calls[0]?.[0]).toHaveLength(2); // 2 frames in the ring
    expect(encode.mock.calls[0]?.[1]).toBe(2); // fps passed through
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe('video');
    expect(entries[0]?.timestamp).toBe(9); // stamped with the report time
    expect(entries[0]?.data).toEqual(new Uint8Array([0xff, 2, 2]));
  });

  it('defaults fps to 1 (1000ms) and bounds the ring to maxFrames (drop-oldest)', async () => {
    const s = fakeScheduler();
    let n = 0;
    const capturePage = vi.fn(async () => new Uint8Array([n++]));
    const encode = vi.fn(
      (frames: readonly { bytes: Uint8Array }[]) => new Uint8Array([frames.length]),
    );
    const source = createCapturePageVideoSource({
      capturePage,
      scheduler: s.scheduler,
      encode,
      maxFrames: 2,
      now: () => 0,
    });
    source.start();
    expect(s.ms).toBe(1000); // default fps 1
    await s.tick();
    await s.tick();
    await s.tick(); // 3 grabs, ring capped at 2
    await source.snapshot(1);
    const frames = encode.mock.calls[0]?.[0] as { bytes: Uint8Array }[];
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.bytes[0])).toEqual([1, 2]); // oldest (0) dropped
  });

  it('stamps each frame with the wall clock', async () => {
    const s = fakeScheduler();
    const times = [10, 20];
    let i = 0;
    const encode = vi.fn(
      (frames: readonly { timestamp: number }[]) => new Uint8Array(frames.map((f) => f.timestamp)),
    );
    const source = createCapturePageVideoSource({
      capturePage: async () => new Uint8Array([1]),
      scheduler: s.scheduler,
      encode,
      now: () => times[i++] ?? 0,
    });
    source.start();
    await s.tick();
    await s.tick();
    await source.snapshot(0);
    expect((encode.mock.calls[0]?.[0] as { timestamp: number }[]).map((f) => f.timestamp)).toEqual([
      10, 20,
    ]);
  });

  it('snapshot returns [] when no frames were captured (never encodes)', async () => {
    const s = fakeScheduler();
    const encode = vi.fn();
    const source = createCapturePageVideoSource({
      capturePage: async () => new Uint8Array(),
      scheduler: s.scheduler,
      encode,
      now: () => 0,
    });
    source.start();
    expect(await source.snapshot(1)).toEqual([]);
    expect(encode).not.toHaveBeenCalled();
  });

  it('routes a failed grab to onError and keeps sampling (never throws into the timer)', async () => {
    const s = fakeScheduler();
    const onError = vi.fn();
    let call = 0;
    const capturePage = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error('capture failed');
      return new Uint8Array([call]);
    });
    const encode = vi.fn((frames: readonly unknown[]) => new Uint8Array([frames.length]));
    const source = createCapturePageVideoSource({
      capturePage,
      scheduler: s.scheduler,
      encode,
      now: () => 0,
      onError,
    });
    source.start();
    await s.tick(); // throws → onError
    await s.tick(); // succeeds
    expect(onError).toHaveBeenCalledTimes(1);
    await source.snapshot(1);
    expect(encode.mock.calls[0]?.[0]).toHaveLength(1); // only the successful frame
  });

  it('start is idempotent; stop clears the interval', async () => {
    const s = fakeScheduler();
    const setSpy = vi.spyOn(s.scheduler, 'setInterval');
    const source = createCapturePageVideoSource({
      capturePage: async () => new Uint8Array(),
      scheduler: s.scheduler,
      encode: () => new Uint8Array(),
      now: () => 0,
    });
    source.start();
    source.start(); // idempotent — no second interval
    expect(setSpy).toHaveBeenCalledTimes(1);
    source.stop();
    expect(s.cleared).toBe(true);
    source.stop(); // idempotent
  });
});

describe('createCapturePageVideoSource.clear (blackout: nothing may survive)', () => {
  it('empties the ring, so a later snapshot has no pre-clear frames', async () => {
    const s = fakeScheduler();
    const encode = vi.fn(
      (frames: readonly { bytes: Uint8Array }[]) => new Uint8Array([frames.length]),
    );
    const source = createCapturePageVideoSource({
      capturePage: async () => new Uint8Array([1]),
      scheduler: s.scheduler,
      encode,
      now: () => 0,
    });
    source.start();
    await s.tick();
    await s.tick();
    source.clear();
    expect(await source.snapshot(1)).toEqual([]);
    expect(encode).not.toHaveBeenCalled();
    await s.tick(); // capture resumes into a clean ring
    await source.snapshot(2);
    expect(encode.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it('discards a grab that was IN FLIGHT when clear() ran (it may show the pre-blackout screen)', async () => {
    const s = fakeScheduler();
    let release: ((bytes: Uint8Array) => void) | undefined;
    const encode = vi.fn((frames: readonly unknown[]) => new Uint8Array([frames.length]));
    const source = createCapturePageVideoSource({
      capturePage: () =>
        new Promise<Uint8Array>((resolve) => {
          release = resolve;
        }),
      scheduler: s.scheduler,
      encode,
      now: () => 0,
    });
    source.start();
    const pending = s.tick();
    source.clear(); // blackout begins while the grab is outstanding
    release?.(new Uint8Array([9]));
    await pending;
    expect(await source.snapshot(1)).toEqual([]);
  });
});

/** A fake MediaRecorder that emits queued chunks on start. */
function fakeRecorder(chunks: unknown[]) {
  const rec: MediaRecorderLike & { started: boolean; stopped: boolean } = {
    started: false,
    stopped: false,
    ondataavailable: null,
    start(_timeslice?: number): void {
      rec.started = true;
      for (const c of chunks) {
        rec.ondataavailable?.({ data: c });
      }
    },
    stop(): void {
      rec.stopped = true;
    },
  };
  return rec;
}

describe('createMediaRecorderVideoSource', () => {
  it('records chunks and, on snapshot, encodes them into ONE video entry', async () => {
    const rec = fakeRecorder(['a', 'b']);
    const toBytes = vi.fn(async (chunks: unknown[]) => new Uint8Array([chunks.length, 0x77]));
    const source = createMediaRecorderVideoSource({
      recorderFactory: () => rec,
      toBytes,
      now: () => 0,
    });
    source.start();
    expect(rec.started).toBe(true);

    const entries = await source.snapshot(5);
    expect(toBytes).toHaveBeenCalledWith(['a', 'b']);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe('video');
    expect(entries[0]?.timestamp).toBe(5);
    expect(entries[0]?.data).toEqual(new Uint8Array([2, 0x77]));
  });

  it('passes the timeslice to recorder.start', () => {
    const rec = fakeRecorder([]);
    const startSpy = vi.spyOn(rec, 'start');
    const source = createMediaRecorderVideoSource({
      recorderFactory: () => rec,
      toBytes: async () => new Uint8Array(),
      now: () => 0,
      timeslice: 250,
    });
    source.start();
    expect(startSpy).toHaveBeenCalledWith(250);
  });

  it('snapshot returns [] when nothing was recorded (never encodes)', async () => {
    const rec = fakeRecorder([]);
    const toBytes = vi.fn();
    const source = createMediaRecorderVideoSource({
      recorderFactory: () => rec,
      toBytes,
      now: () => 0,
    });
    source.start();
    expect(await source.snapshot(1)).toEqual([]);
    expect(toBytes).not.toHaveBeenCalled();
  });

  it('stop() stops the recorder; stop before start is a safe no-op', () => {
    const rec = fakeRecorder([]);
    const source = createMediaRecorderVideoSource({
      recorderFactory: () => rec,
      toBytes: async () => new Uint8Array(),
      now: () => 0,
    });
    expect(() => source.stop()).not.toThrow(); // no recorder yet
    source.start();
    source.stop();
    expect(rec.stopped).toBe(true);
  });
});

describe('createMediaRecorderVideoSource.clear (blackout: nothing may survive)', () => {
  it('drops the recorded chunks, so a later snapshot has none of them', async () => {
    const rec = fakeRecorder(['a', 'b']);
    const toBytes = vi.fn(async () => new Uint8Array([1]));
    const source = createMediaRecorderVideoSource({
      recorderFactory: () => rec,
      toBytes,
      now: () => 0,
    });
    source.start();
    source.clear();
    expect(await source.snapshot(1)).toEqual([]);
    expect(toBytes).not.toHaveBeenCalled();
  });

  it('ignores a LATE chunk the stopped recorder flushes after clear() (MediaRecorder emits one on stop)', async () => {
    const rec = fakeRecorder([]);
    const toBytes = vi.fn(async (chunks: unknown[]) => new Uint8Array([chunks.length]));
    const source = createMediaRecorderVideoSource({
      recorderFactory: () => rec,
      toBytes,
      now: () => 0,
    });
    source.start();
    const late = rec.ondataavailable;
    source.stop();
    source.clear();
    late?.({ data: 'pre-blackout-flush' });
    expect(await source.snapshot(1)).toEqual([]);
  });

  it('a restart after clear records into a clean buffer', async () => {
    const rec = fakeRecorder(['x']);
    const toBytes = vi.fn(async (chunks: unknown[]) => new Uint8Array([chunks.length]));
    const source = createMediaRecorderVideoSource({
      recorderFactory: () => rec,
      toBytes,
      now: () => 0,
    });
    source.start();
    source.clear();
    source.start();
    const [entry] = await source.snapshot(1);
    expect(entry?.data).toEqual(new Uint8Array([1])); // only the post-restart chunk
  });
});

describe('createDisplayVideoSource — one composed frame per display', () => {
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  const setup = (over: Partial<Parameters<typeof createDisplayVideoSource>[0]> = {}) => {
    const s = fakeScheduler();
    let time = 1000;
    const displays = [
      { id: 0, bounds: rect(0, 0, 100, 100) },
      { id: 1, bounds: rect(100, 0, 100, 100) },
    ];
    const layersOf = new Map<
      number,
      Array<{ bounds: ReturnType<typeof rect>; capture: () => Promise<Uint8Array> }>
    >([
      [
        0,
        [
          { bounds: rect(0, 0, 50, 50), capture: async () => new Uint8Array([0xa]) },
          { bounds: rect(10, 10, 50, 50), capture: async () => new Uint8Array([0xb]) },
        ],
      ],
      [1, [{ bounds: rect(100, 0, 100, 100), capture: async () => new Uint8Array([0xc]) }]],
    ]);
    const compose = vi.fn(
      async (
        display: { id: number },
        layers: ReadonlyArray<{ bytes: Uint8Array | undefined; bounds: unknown }>,
      ) => new Uint8Array([display.id, ...layers.map((l) => l.bytes?.[0] as number)]),
    );
    const encode = vi.fn((frames: readonly { bytes: Uint8Array }[], fps: number) =>
      Uint8Array.from([fps, ...frames.flatMap((f) => [...f.bytes])]),
    );
    const source = createDisplayVideoSource({
      displays: () => displays,
      layers: (display) => layersOf.get(display.id) ?? [],
      compose,
      encode,
      scheduler: s.scheduler,
      now: () => time,
      ...over,
    });
    return { s, source, compose, encode, displays, layersOf, at: (t: number) => (time = t) };
  };

  it('composes the windows of each display back to front into one frame, and yields one video entry per display with its id as lane', async () => {
    const { s, source, compose } = setup();
    source.start();
    await s.tick();
    expect(compose).toHaveBeenCalledTimes(2);
    expect((compose.mock.calls[0]?.[1] ?? []).map((l) => l.bytes?.[0])).toEqual([0xa, 0xb]); // z order kept
    const entries = await source.snapshot(5);
    expect(entries.map((e) => [e.type, e.lane, [...(e.data as Uint8Array)]])).toEqual([
      ['video', '0', [1, 0, 0xa, 0xb]],
      ['video', '1', [1, 1, 0xc]],
    ]);
  });

  it('orders the entries by display id, whatever order the displays were listed in', async () => {
    const { s, source, displays } = setup();
    displays.reverse();
    source.start();
    await s.tick();
    expect((await source.snapshot(5)).map((e) => e.lane)).toEqual(['0', '1']);
  });

  it('skips a display with no visible window (no frame, no entry)', async () => {
    const { s, source, layersOf } = setup();
    layersOf.set(1, []);
    source.start();
    await s.tick();
    expect((await source.snapshot(5)).map((e) => e.lane)).toEqual(['0']);
  });

  it('drops a window whose grab fails, reports it, and still composes the rest', async () => {
    const errors: unknown[] = [];
    const { s, source, compose, layersOf } = setup({ onError: (e) => errors.push(e) });
    layersOf.set(0, [
      {
        bounds: rect(0, 0, 10, 10),
        capture: async () => {
          throw new Error('grab failed');
        },
      },
      { bounds: rect(0, 0, 10, 10), capture: async () => new Uint8Array([0xb]) },
    ]);
    source.start();
    await s.tick();
    // the failed window keeps its place in the z-order as a bytes-less placeholder, so the window behind it cannot show through
    expect((compose.mock.calls[0]?.[1] ?? []).map((l) => [l.bytes?.[0], l.bounds])).toEqual([
      [undefined, rect(0, 0, 10, 10)],
      [0xb, rect(0, 0, 10, 10)],
    ]);
    expect(errors).toHaveLength(1);
  });

  it('records no frame for a display whose every window failed to grab (nothing real to show)', async () => {
    const { s, source, compose, layersOf } = setup({ onError: () => {} });
    layersOf.set(0, [
      {
        bounds: rect(0, 0, 10, 10),
        capture: async () => {
          throw new Error('grab failed');
        },
      },
    ]);
    source.start();
    await s.tick();
    expect(compose.mock.calls.map((c) => (c[0] as { id: number }).id)).toEqual([1]);
    expect((await source.snapshot(5)).map((e) => e.lane)).toEqual(['1']);
  });

  it.each([
    ['stuckMs', { stuckMs: 0 }],
    ['stuckMs', { stuckMs: Number.NaN }],
    ['stuckMs', { stuckMs: 2_147_483_648 }],
    ['layerTimeoutMs', { layerTimeoutMs: 0 }],
    ['layerTimeoutMs', { layerTimeoutMs: Number.POSITIVE_INFINITY }],
    ['layerTimeoutMs', { stuckMs: 1 }], // the derived default (floor(1 / 2) = 0) is checked too
  ])('rejects a %s outside the timer range, as fps is', (name, over) => {
    expect(() => setup(over)).toThrow(new RegExp(`${name} must be`));
  });

  it('an abandoned tick that finishes grabbing after a newer tick started a compose does not start a second one', async () => {
    let time = 1000;
    const s = fakeScheduler();
    let releaseGrab: ((bytes: Uint8Array) => void) | undefined;
    let slow = true;
    let calls = 0;
    const source = createDisplayVideoSource({
      displays: () => [{ id: 0, bounds: rect(0, 0, 10, 10) }],
      layers: () => [
        {
          bounds: rect(0, 0, 10, 10),
          capture: () =>
            slow
              ? new Promise<Uint8Array>((resolve) => {
                  releaseGrab = resolve;
                })
              : Promise.resolve(new Uint8Array([1])),
        },
      ],
      compose: () => {
        calls += 1;
        return new Promise<Uint8Array>(() => {}); // never settles
      },
      encode: (frames) => Uint8Array.from(frames.flatMap((f) => [...f.bytes])),
      scheduler: s.scheduler,
      now: () => time,
      stuckMs: 5000,
      layerTimeoutMs: 100_000,
      after: () => () => {},
      onError: () => {},
    });
    source.start();
    void s.tick(); // tick A: its window grab hangs
    await Promise.resolve();
    time += 5000;
    slow = false;
    void s.tick(); // tick B abandons A, grabs at once and starts a compose that never settles
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(calls).toBe(1);
    releaseGrab?.(new Uint8Array([2])); // A's grab finally answers
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(calls).toBe(1);
  });

  it('does not start another compose for a display while its earlier compose has not settled, and resumes once it does', async () => {
    let time = 1000;
    const s = fakeScheduler();
    let release: ((bytes: Uint8Array) => void) | undefined;
    let calls = 0;
    let grabs = 0;
    const source = createDisplayVideoSource({
      displays: () => [{ id: 0, bounds: rect(0, 0, 10, 10) }],
      layers: () => [
        {
          bounds: rect(0, 0, 10, 10),
          capture: async () => {
            grabs += 1;
            return new Uint8Array([1]);
          },
        },
      ],
      compose: () => {
        calls += 1;
        return new Promise<Uint8Array>((resolve) => {
          release = resolve;
        });
      },
      encode: (frames) => Uint8Array.from(frames.flatMap((f) => [...f.bytes])),
      scheduler: s.scheduler,
      now: () => time,
      stuckMs: 100,
      after: (ms, fn) => {
        const handle = globalThis.setTimeout(fn, 0);
        void ms;
        return () => globalThis.clearTimeout(handle);
      },
      onError: () => {},
    });
    source.start();
    await s.tick(); // compose #1 starts, times out (stuckMs) and is abandoned, still pending
    time += 1000;
    await s.tick();
    time += 1000;
    await s.tick();
    expect(calls).toBe(1); // no pile-up behind a hung compositor
    expect(grabs).toBe(1); // and no window is grabbed (GPU readback + JPEG) for a frame that would be thrown away
    release?.(new Uint8Array([9]));
    await Promise.resolve();
    await Promise.resolve();
    time += 1000;
    await s.tick();
    expect(calls).toBe(2); // it settled, so the display is served again
    expect(grabs).toBe(2);
  });

  it('a display whose compose fails loses that frame only, and the other display still records', async () => {
    const errors: unknown[] = [];
    const base = setup();
    const compose = vi.fn(async (display: { id: number }) => {
      if (display.id === 0) throw new Error('compose failed');
      return new Uint8Array([9]);
    });
    const { s, source } = setup({ compose, onError: (e) => errors.push(e) });
    source.start();
    await s.tick();
    expect((await source.snapshot(5)).map((e) => e.lane)).toEqual(['1']);
    expect(errors).toHaveLength(1);
    void base;
  });

  it('keeps at most maxFrames per display (drop-oldest)', async () => {
    const { s, source, at } = setup({ maxFrames: 2 });
    source.start();
    for (const t of [1000, 1001, 1002]) {
      at(t);
      await s.tick();
    }
    const first = (await source.snapshot(5))[0];
    expect((first?.data as Uint8Array).length).toBe(1 + 2 * 3); // fps byte + 2 frames of [id, a, b]
  });

  it('a tick that starts while the previous one is still grabbing is skipped', async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    const { s, source, compose, layersOf } = setup();
    layersOf.set(0, [
      {
        bounds: rect(0, 0, 1, 1),
        capture: async () => {
          await slow;
          return new Uint8Array([1]);
        },
      },
    ]);
    source.start();
    const first = s.tick();
    await s.tick(); // overlaps: skipped
    release();
    await first;
    expect(compose).toHaveBeenCalledTimes(2); // display 0 and display 1 of the FIRST tick only
  });

  it('clear() forgets every frame, including a grab still in flight', async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    const { s, source, layersOf } = setup();
    layersOf.set(0, [
      {
        bounds: rect(0, 0, 1, 1),
        capture: async () => {
          await slow;
          return new Uint8Array([1]);
        },
      },
    ]);
    source.start();
    const pending = s.tick();
    source.clear();
    release();
    await pending;
    expect(await source.snapshot(5)).toEqual([]);
  });

  it('forgets a display that has been gone for longer than the ring covers', async () => {
    const { s, source, displays, at } = setup({ maxFrames: 2 });
    source.start();
    await s.tick(); // t = 1000: both displays have a frame
    displays.pop(); // display 1 is unplugged
    at(1000 + 2 * 1000 + 1); // ring covers maxFrames / fps = 2 s
    await s.tick();
    expect((await source.snapshot(5)).map((e) => e.lane)).toEqual(['0']);
  });

  it('the ring of a vanished display lasts maxFrames / fps seconds (a faster rate covers less time)', async () => {
    const { s, source, displays, at } = setup({ maxFrames: 2, fps: 2 }); // 2 frames at 2 fps = 1 s
    source.start();
    await s.tick(); // t = 1000
    displays.pop();
    at(1000 + 1500);
    await s.tick();
    expect((await source.snapshot(5)).map((e) => e.lane)).toEqual(['0']);
  });

  it('start is idempotent, stop clears the timer, and the source samples at the configured fps', () => {
    const { s, source } = setup({ fps: 4 });
    source.start();
    source.start();
    expect(s.ms).toBe(250);
    source.stop();
    expect(s.cleared).toBe(true);
  });

  it('returns no entries before anything was captured', async () => {
    expect(await setup().source.snapshot(5)).toEqual([]);
  });

  it('keeps each physical display in its own ring when the ids move (focus changed monitors)', async () => {
    const s = fakeScheduler();
    let displays = [
      { id: 0, key: 'A', bounds: rect(0, 0, 100, 100) },
      { id: 1, key: 'B', bounds: rect(100, 0, 100, 100) },
    ];
    const source = createDisplayVideoSource({
      displays: () => displays,
      layers: (d) => [{ bounds: d.bounds, capture: async () => new Uint8Array([1]) }],
      compose: async (d) => new Uint8Array([(d.key as string).charCodeAt(0)]),
      encode: (frames) => Uint8Array.from(frames.flatMap((f) => [...f.bytes])),
      scheduler: s.scheduler,
      now: () => 1000,
    });
    source.start();
    await s.tick();
    displays = [
      { id: 0, key: 'B', bounds: rect(100, 0, 100, 100) }, // focus moved: B is now display 0
      { id: 1, key: 'A', bounds: rect(0, 0, 100, 100) },
    ];
    await s.tick();
    const out = await source.snapshot(5);
    expect(out.map((e) => [e.lane, String.fromCharCode(...(e.data as Uint8Array))])).toEqual([
      ['0', 'BB'],
      ['1', 'AA'],
    ]);
  });

  it('a grab that never answers is abandoned after stuckMs, so capture resumes', async () => {
    let time = 1000;
    let hang = true;
    const s = fakeScheduler();
    const source = createDisplayVideoSource({
      displays: () => [{ id: 0, bounds: rect(0, 0, 10, 10) }],
      layers: () => [
        {
          bounds: rect(0, 0, 10, 10),
          capture: () =>
            hang ? new Promise<Uint8Array>(() => {}) : Promise.resolve(new Uint8Array([7])),
        },
      ],
      compose: async (_d, layers) => layers[0]?.bytes as Uint8Array,
      encode: (frames) => Uint8Array.from(frames.flatMap((f) => [...f.bytes])),
      scheduler: s.scheduler,
      now: () => time,
      stuckMs: 5000,
    });
    source.start();
    void s.tick(); // hangs
    time = 1000 + 4999;
    hang = false;
    await s.tick(); // still inside stuckMs: skipped
    expect(await source.snapshot(5)).toEqual([]);
    time = 1000 + 5000;
    await s.tick(); // the stuck tick is abandoned and this one captures
    expect((await source.snapshot(5)).map((e) => [...(e.data as Uint8Array)])).toEqual([[7]]);
  });

  it('an abandoned tick neither adds its late frame nor frees the busy flag of the tick that replaced it', async () => {
    let time = 1000;
    const s = fakeScheduler();
    const grabs: Array<(bytes: Uint8Array) => void> = [];
    const source = createDisplayVideoSource({
      displays: () => [{ id: 0, bounds: rect(0, 0, 10, 10) }],
      layers: () => [
        {
          bounds: rect(0, 0, 10, 10),
          capture: () => new Promise<Uint8Array>((resolve) => grabs.push(resolve)),
        },
      ],
      compose: async (_d, layers) => layers[0]?.bytes as Uint8Array,
      encode: (frames) => Uint8Array.from(frames.flatMap((f) => [...f.bytes])),
      scheduler: s.scheduler,
      now: () => time,
      stuckMs: 5000,
    });
    source.start();
    const first = s.tick(); // grab #0 hangs
    time = 6000;
    const second = s.tick(); // abandons the first, grab #1 is pending
    await Promise.resolve();
    grabs[0]?.(new Uint8Array([9])); // the abandoned grab finally answers
    await first;
    time = 6001;
    await s.tick(); // the second tick is still running: this one must be skipped, not start grab #2
    expect(grabs).toHaveLength(2);
    grabs[1]?.(new Uint8Array([7]));
    await second;
    expect((await source.snapshot(5)).map((e) => [...(e.data as Uint8Array)])).toEqual([[7]]);
  });

  it('a displays() that throws is reported and the timer survives (no rejection reaches the scheduler)', async () => {
    const errors: unknown[] = [];
    let broken = true;
    const s = fakeScheduler();
    const source = createDisplayVideoSource({
      displays: () => {
        if (broken) throw new Error('screen not ready');
        return [{ id: 0, bounds: rect(0, 0, 10, 10) }];
      },
      layers: () => [{ bounds: rect(0, 0, 10, 10), capture: async () => new Uint8Array([1]) }],
      compose: async () => new Uint8Array([2]),
      encode: (frames) => Uint8Array.from(frames.flatMap((f) => [...f.bytes])),
      scheduler: s.scheduler,
      now: () => 1000,
      onError: (e) => errors.push(e),
    });
    source.start();
    await expect(s.tick()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    broken = false;
    await s.tick();
    expect((await source.snapshot(5)).map((e) => e.lane)).toEqual(['0']);
  });

  it('a window whose capture never answers is dropped from its display frame after layerTimeoutMs, the others still compose', async () => {
    const errors: unknown[] = [];
    const s = fakeScheduler();
    const timers: Array<() => void> = [];
    const composed: number[][] = [];
    const source = createDisplayVideoSource({
      displays: () => [
        { id: 0, bounds: rect(0, 0, 10, 10) },
        { id: 1, bounds: rect(10, 0, 10, 10) },
      ],
      layers: (display) =>
        display.id === 0
          ? [
              { bounds: rect(0, 0, 10, 10), capture: () => new Promise<Uint8Array>(() => {}) },
              { bounds: rect(0, 0, 5, 5), capture: async () => new Uint8Array([9]) },
            ]
          : [{ bounds: rect(10, 0, 10, 10), capture: async () => new Uint8Array([4]) }],
      compose: async (display, layers) => {
        composed.push([display.id, ...layers.map((l) => l.bytes?.[0] ?? -1)]);
        return new Uint8Array([display.id]);
      },
      encode: (frames) => Uint8Array.from(frames.flatMap((f) => [...f.bytes])),
      scheduler: s.scheduler,
      now: () => 1000,
      layerTimeoutMs: 2500,
      after: (ms, fn) => {
        expect(ms).toBe(2500);
        timers.push(fn);
        return () => {};
      },
      onError: (e) => errors.push(e),
    });
    source.start();
    const ticking = s.tick();
    await Promise.resolve();
    await Promise.resolve();
    for (const fire of timers) fire(); // the hung window's timer fires
    await ticking;
    expect(composed.sort()).toEqual([
      [0, -1, 9],
      [1, 4],
    ]);
    expect(errors).toHaveLength(1);
    expect((await source.snapshot(5)).map((e) => e.lane)).toEqual(['0', '1']);
  });

  it('a compose that never answers is abandoned after stuckMs: that display loses the frame, the other one records', async () => {
    const errors: unknown[] = [];
    const s = fakeScheduler();
    const timers: Array<{ ms: number; fire: () => void }> = [];
    const source = createDisplayVideoSource({
      displays: () => [
        { id: 0, bounds: rect(0, 0, 10, 10) },
        { id: 1, bounds: rect(10, 0, 10, 10) },
      ],
      layers: (display) => [
        { bounds: display.bounds, capture: async () => new Uint8Array([display.id]) },
      ],
      compose: (display) =>
        display.id === 0 ? new Promise<Uint8Array>(() => {}) : Promise.resolve(new Uint8Array([5])),
      encode: (frames) => Uint8Array.from(frames.flatMap((f) => [...f.bytes])),
      scheduler: s.scheduler,
      now: () => 1000,
      stuckMs: 4000,
      after: (ms, fn) => {
        timers.push({ ms, fire: fn });
        return () => {};
      },
      onError: (e) => errors.push(e),
    });
    source.start();
    const ticking = s.tick();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    for (const t of timers.filter((x) => x.ms === 4000)) t.fire(); // the compose timers (the capture timers are layerTimeoutMs)
    await ticking;
    expect(errors).toHaveLength(1);
    expect((await source.snapshot(5)).map((e) => e.lane)).toEqual(['1']);
  });

  it('cancels the capture timer and the compose timer of work that answered in time', async () => {
    const s = fakeScheduler();
    const cancelled: number[] = [];
    let n = 0;
    const source = createDisplayVideoSource({
      displays: () => [{ id: 0, bounds: rect(0, 0, 10, 10) }],
      layers: () => [{ bounds: rect(0, 0, 10, 10), capture: async () => new Uint8Array([1]) }],
      compose: async () => new Uint8Array([2]),
      encode: (frames) => Uint8Array.from(frames.flatMap((f) => [...f.bytes])),
      scheduler: s.scheduler,
      now: () => 1000,
      after: () => {
        const mine = n++;
        return () => cancelled.push(mine);
      },
    });
    source.start();
    await s.tick();
    expect(cancelled).toEqual([0, 1]); // the window capture's timer, then the compose's
  });

  it('a display whose last window left gives up the id another display now holds', async () => {
    let time = 1000;
    const s = fakeScheduler();
    let displays = [
      { id: 0, key: 'A', bounds: rect(0, 0, 10, 10) },
      { id: 1, key: 'B', bounds: rect(10, 0, 10, 10) },
    ];
    let withWindowOnB = true;
    const source = createDisplayVideoSource({
      displays: () => displays,
      layers: (display) =>
        display.key === 'B' && !withWindowOnB
          ? []
          : [{ bounds: display.bounds, capture: async () => new Uint8Array([1]) }],
      compose: async () => new Uint8Array([1]),
      encode: (frames) => Uint8Array.from(frames.flatMap((f) => [...f.bytes])),
      scheduler: s.scheduler,
      now: () => time,
    });
    source.start();
    await s.tick(); // A = 0, B = 1
    // focus moves to B: B is 0 now, A is 1, and B has no visible window any more
    displays = [
      { id: 0, key: 'B', bounds: rect(10, 0, 10, 10) },
      { id: 1, key: 'A', bounds: rect(0, 0, 10, 10) },
    ];
    withWindowOnB = false;
    time = 2000;
    await s.tick();
    expect((await source.snapshot(5)).map((e) => e.lane).sort()).toEqual(['0', '1']);
  });

  it('drops the frames older than the ring covers from a display that shows a window again', async () => {
    let time = 1000;
    const s = fakeScheduler();
    let alive = true;
    const source = createDisplayVideoSource({
      displays: () => [{ id: 0, bounds: rect(0, 0, 10, 10) }],
      layers: () =>
        alive ? [{ bounds: rect(0, 0, 10, 10), capture: async () => new Uint8Array([1]) }] : [],
      compose: async (_d, layers) => layers[0]?.bytes as Uint8Array,
      encode: (frames) => Uint8Array.from(frames.map((f) => f.timestamp / 1000)),
      scheduler: s.scheduler,
      now: () => time,
      maxFrames: 4, // covers 4 s at 1 fps
    });
    source.start();
    await s.tick(); // t = 1000: a frame
    alive = false;
    time = 3000;
    await s.tick(); // nothing visible: no frame, the old one stays (inside the span)
    alive = true;
    time = 6000;
    await s.tick(); // a new frame; the one at 1000 is now older than 6000 - 4000
    expect((await source.snapshot(5)).map((e) => [...(e.data as Uint8Array)])).toEqual([[6]]);
  });

  it('a throwing onError never makes the timer callback reject', async () => {
    const s = fakeScheduler();
    const source = createDisplayVideoSource({
      displays: () => {
        throw new Error('screen not ready');
      },
      layers: () => [],
      compose: async () => new Uint8Array([2]),
      encode: () => new Uint8Array(),
      scheduler: s.scheduler,
      now: () => 1000,
      onError: () => {
        throw new Error('sink broke');
      },
    });
    source.start();
    await expect(s.tick()).resolves.toBeUndefined();
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects an fps of %s at construction', (fps) => {
    expect(() =>
      createDisplayVideoSource({
        displays: () => [],
        layers: () => [],
        compose: async () => new Uint8Array(),
        encode: () => new Uint8Array(),
        scheduler: fakeScheduler().scheduler,
        now: () => 0,
        fps,
      }),
    ).toThrow(RangeError);
  });

  it('an encode that throws for one display costs only that display its video', async () => {
    const errors: unknown[] = [];
    const s = fakeScheduler();
    const source = createDisplayVideoSource({
      displays: () => [
        { id: 0, bounds: rect(0, 0, 10, 10) },
        { id: 1, bounds: rect(10, 0, 10, 10) },
      ],
      layers: (d) => [{ bounds: d.bounds, capture: async () => new Uint8Array([d.id]) }],
      compose: async (d) => new Uint8Array([d.id]),
      encode: (frames) => {
        if (frames[0]?.bytes[0] === 0) throw new Error('mux failed');
        return new Uint8Array([9]);
      },
      scheduler: s.scheduler,
      now: () => 1000,
      onError: (e) => errors.push(e),
    });
    source.start();
    await s.tick();
    expect((await source.snapshot(5)).map((e) => e.lane)).toEqual(['1']);
    expect(errors).toHaveLength(1);
  });
});
