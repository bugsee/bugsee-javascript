import type { Scheduler } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createCapturePageVideoSource,
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
