import { CaptureDataEntryBase } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import { createPixelVideoController, encodePixelVideo } from './pixel-video-controller';
import type { VideoCaptureSource } from './video-capture';

function fakeSource(entriesData: Uint8Array[] = [new Uint8Array([1])]) {
  const source: VideoCaptureSource & { started: boolean; stopped: boolean } = {
    started: false,
    stopped: false,
    start() {
      source.started = true;
    },
    stop() {
      source.stopped = true;
    },
    snapshot: vi.fn(async (now: number) =>
      entriesData.map((d) => new CaptureDataEntryBase('video', now, d)),
    ),
  };
  return source;
}

describe('createPixelVideoController', () => {
  it('starts the source and pulls its entries on snapshot when permission is granted', async () => {
    const source = fakeSource([new Uint8Array([0x9])]);
    const controller = createPixelVideoController({ source, hasPermission: () => true });
    await controller.start();
    expect(source.started).toBe(true);

    const entries = await controller.snapshot(7);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe('video');
    expect(entries[0]?.timestamp).toBe(7);
  });

  it('defaults to granted when no permission check is provided', async () => {
    const source = fakeSource();
    const controller = createPixelVideoController({ source });
    await controller.start();
    expect(source.started).toBe(true);
  });

  it('stays inert (source never starts; snapshot []) when permission is denied', async () => {
    const source = fakeSource();
    const controller = createPixelVideoController({ source, hasPermission: async () => false });
    await controller.start();
    expect(source.started).toBe(false);
    expect(await controller.snapshot(1)).toEqual([]);
    expect(source.snapshot).not.toHaveBeenCalled();
  });

  it('start is idempotent (source started once)', async () => {
    const source = fakeSource();
    const startSpy = vi.spyOn(source, 'start');
    const controller = createPixelVideoController({ source, hasPermission: () => true });
    await controller.start();
    await controller.start();
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('stop() stops the source; stop before start is a no-op', async () => {
    const source = fakeSource();
    const controller = createPixelVideoController({ source, hasPermission: () => true });
    controller.stop(); // before start
    expect(source.stopped).toBe(false);
    await controller.start();
    controller.stop();
    expect(source.stopped).toBe(true);
  });

  it('snapshot before start returns [] (never queries the source)', async () => {
    const source = fakeSource();
    const controller = createPixelVideoController({ source, hasPermission: () => true });
    expect(await controller.snapshot(1)).toEqual([]);
    expect(source.snapshot).not.toHaveBeenCalled();
  });

  it('never rejects: a throwing permission check routes to onError and stays inert', async () => {
    const onError = vi.fn();
    const source = fakeSource();
    const controller = createPixelVideoController({
      source,
      hasPermission: async () => {
        throw new Error('TCC query failed');
      },
      onError,
    });
    await expect(controller.start()).resolves.toBeUndefined(); // must NOT reject (no unhandled rejection)
    expect(onError).toHaveBeenCalledTimes(1);
    expect(source.started).toBe(false); // inert
    expect(await controller.snapshot(1)).toEqual([]);
  });

  it('never rejects: a throwing source.start routes to onError and rolls back to inert', async () => {
    const onError = vi.fn();
    const source = fakeSource();
    source.start = () => {
      throw new Error('capturePage init failed');
    };
    const controller = createPixelVideoController({ source, hasPermission: () => true, onError });
    await expect(controller.start()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(await controller.snapshot(1)).toEqual([]); // active rolled back — no half-started state
  });

  it('isolates a failing source: routes to onError and returns [] (never blocks the report)', async () => {
    const onError = vi.fn();
    const source = fakeSource();
    source.snapshot = vi.fn(async () => {
      throw new Error('encode failed');
    });
    const controller = createPixelVideoController({ source, hasPermission: () => true, onError });
    await controller.start();
    expect(await controller.snapshot(1)).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('encodePixelVideo (the video fileEncoder)', () => {
  it('returns the single payload verbatim (the common case — one source, one entry)', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(encodePixelVideo([bytes])).toBe(bytes);
  });

  it('concatenates multiple payloads (defensive — the single video.webm contract)', () => {
    expect(encodePixelVideo([new Uint8Array([1, 2]), new Uint8Array([3])])).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it('returns empty bytes for no payloads', () => {
    expect(encodePixelVideo([])).toEqual(new Uint8Array());
  });
});
