import { type CaptureDataEntry, CaptureDataEntryBase, createBlackoutState } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import { createPixelVideoController, encodePixelVideo } from './pixel-video-controller';
import type { VideoCaptureSource } from './video-capture';

function fakeSource(entriesData: Uint8Array[] = [new Uint8Array([1])]) {
  const source: VideoCaptureSource & { started: boolean; stopped: boolean; cleared: number } = {
    started: false,
    stopped: false,
    cleared: 0,
    start() {
      source.started = true;
    },
    stop() {
      source.stopped = true;
    },
    clear() {
      source.cleared += 1;
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

  it('a stop() while the permission check is pending means the source never starts', async () => {
    const source = fakeSource();
    let grant: (v: boolean) => void = () => {};
    const controller = createPixelVideoController({
      source,
      hasPermission: () => new Promise<boolean>((resolve) => (grant = resolve)),
    });
    const started = controller.start();
    controller.stop(); // client shutting down while macOS is still asking
    grant(true);
    await started;
    expect(source.started).toBe(false);
    expect(await controller.snapshot(1)).toEqual([]);
  });

  it('a start() that was overtaken by a newer start does not start the source twice', async () => {
    const source = fakeSource();
    const startSpy = vi.spyOn(source, 'start');
    const grants: Array<(v: boolean) => void> = [];
    const controller = createPixelVideoController({
      source,
      hasPermission: () => new Promise<boolean>((resolve) => grants.push(resolve)),
    });
    const first = controller.start();
    const second = controller.start();
    for (const g of grants) g(true);
    await Promise.all([first, second]);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('stop() then start() again works (the new start is not cancelled by the old stop)', async () => {
    const source = fakeSource();
    const controller = createPixelVideoController({ source });
    controller.stop();
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

  it('stop() never throws even if source.stop throws (routes to onError) — keeps shutdown robust', async () => {
    const onError = vi.fn();
    const source = fakeSource();
    source.stop = () => {
      throw new Error('recorder stop failed');
    };
    const controller = createPixelVideoController({ source, hasPermission: () => true, onError });
    await controller.start();
    expect(() => controller.stop()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
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

describe('createPixelVideoController - blackout (privacy: fail closed)', () => {
  const sequence = () => {
    const calls: string[] = [];
    const source = fakeSource();
    source.start = () => {
      source.started = true;
      calls.push('start');
    };
    source.stop = () => {
      source.stopped = true;
      calls.push('stop');
    };
    source.clear = () => {
      calls.push('clear');
    };
    return { source, calls };
  };

  it('on blackout start: stops the source, then CLEARS its ring (pre-blackout frames are not kept either)', async () => {
    const gate = createBlackoutState();
    const { source, calls } = sequence();
    const controller = createPixelVideoController({ source, blackout: gate });
    await controller.start();
    expect(calls).toEqual(['start']);
    gate.start();
    expect(calls).toEqual(['start', 'stop', 'clear']);
  });

  it('snapshot() yields nothing for the whole span and never queries the source', async () => {
    const gate = createBlackoutState();
    const source = fakeSource();
    const controller = createPixelVideoController({ source, blackout: gate });
    await controller.start();
    gate.start();
    expect(await controller.snapshot(1)).toEqual([]);
    expect(source.snapshot).not.toHaveBeenCalled();
  });

  it('a snapshot already IN FLIGHT when the blackout begins is discarded', async () => {
    const gate = createBlackoutState();
    const source = fakeSource();
    let release: (() => void) | undefined;
    source.snapshot = vi.fn(
      () =>
        new Promise<CaptureDataEntry[]>((resolve) => {
          release = () => resolve([new CaptureDataEntryBase('video', 1, new Uint8Array([7]))]);
        }),
    );
    const controller = createPixelVideoController({ source, blackout: gate });
    await controller.start();
    const pending = controller.snapshot(1);
    gate.start();
    release?.();
    expect(await pending).toEqual([]);
  });

  it('on blackout end: restarts the source into a clean ring and snapshots work again', async () => {
    const gate = createBlackoutState();
    const { source, calls } = sequence();
    const controller = createPixelVideoController({ source, blackout: gate });
    await controller.start();
    gate.start();
    gate.end();
    expect(calls).toEqual(['start', 'stop', 'clear', 'start']);
    expect(await controller.snapshot(3)).toHaveLength(1);
  });

  it('never starts the source when a blackout is in force at start (and starts it when it ends)', async () => {
    const gate = createBlackoutState();
    gate.start();
    const { source, calls } = sequence();
    const controller = createPixelVideoController({ source, blackout: gate });
    await controller.start();
    expect(calls).toEqual([]);
    expect(await controller.snapshot(1)).toEqual([]);
    gate.end();
    expect(calls).toEqual(['start']);
  });

  it('a blackout that begins DURING the async permission check still wins', async () => {
    const gate = createBlackoutState();
    const { source, calls } = sequence();
    let grant: ((v: boolean) => void) | undefined;
    const controller = createPixelVideoController({
      source,
      blackout: gate,
      hasPermission: () =>
        new Promise<boolean>((resolve) => {
          grant = resolve;
        }),
    });
    const starting = controller.start();
    gate.start();
    grant?.(true);
    await starting;
    expect(calls).toEqual([]);
  });

  it('is inert on blackout when permission was denied (nothing to stop or clear)', async () => {
    const gate = createBlackoutState();
    const { source, calls } = sequence();
    const controller = createPixelVideoController({
      source,
      blackout: gate,
      hasPermission: () => false,
    });
    await controller.start();
    gate.start();
    gate.end();
    expect(calls).toEqual([]);
  });

  it('a throwing source.stop still clears the ring (routes to onError)', async () => {
    const gate = createBlackoutState();
    const onError = vi.fn();
    const { source, calls } = sequence();
    source.stop = () => {
      throw new Error('stop failed');
    };
    const controller = createPixelVideoController({ source, blackout: gate, onError });
    await controller.start();
    gate.start();
    expect(calls).toEqual(['start', 'clear']);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  // R4V-8: the HOST's onError sink is arbitrary code. When it throws while reporting a failing `source.stop`, the
  // `clear` must STILL run (otherwise the pre-blackout frames, which may show the sensitive screen, stay buffered)
  // and nothing may escape into the blackout gate's dispatch.
  it('a throwing onError sink cannot keep pre-blackout frames: stop fails AND the sink throws, clear still runs', async () => {
    const gate = createBlackoutState();
    const { source, calls } = sequence();
    source.stop = () => {
      throw new Error('stop failed');
    };
    const onError = vi.fn(() => {
      throw new Error('sink failed');
    });
    const controller = createPixelVideoController({ source, blackout: gate, onError });
    await controller.start();
    expect(() => gate.start()).not.toThrow();
    expect(calls).toEqual(['start', 'clear']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(await controller.snapshot(1)).toEqual([]);
  });

  it('a throwing sink does not break the restart on blackout end either', async () => {
    const gate = createBlackoutState();
    const { source, calls } = sequence();
    const onError = vi.fn(() => {
      throw new Error('sink failed');
    });
    const controller = createPixelVideoController({ source, blackout: gate, onError });
    await controller.start();
    gate.start();
    source.start = () => {
      throw new Error('restart failed');
    };
    expect(() => gate.end()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['start', 'stop', 'clear']);
  });

  it('a throwing sink never rejects start() / stop() / snapshot()', async () => {
    const onError = vi.fn(() => {
      throw new Error('sink failed');
    });
    const failing = fakeSource();
    failing.start = () => {
      throw new Error('start failed');
    };
    await expect(createPixelVideoController({ source: failing, onError }).start()).resolves.toBe(
      undefined,
    );
    const stopFails = fakeSource();
    stopFails.stop = () => {
      throw new Error('stop failed');
    };
    const running = createPixelVideoController({ source: stopFails, onError });
    await running.start();
    expect(() => running.stop()).not.toThrow();
    const snapFails = fakeSource();
    snapFails.snapshot = () => Promise.reject(new Error('snap failed'));
    const snapping = createPixelVideoController({ source: snapFails, onError });
    await snapping.start();
    await expect(snapping.snapshot(1)).resolves.toEqual([]);
  });

  it('a throwing source.clear routes to onError and the snapshot stays suppressed', async () => {
    const gate = createBlackoutState();
    const onError = vi.fn();
    const source = fakeSource();
    source.clear = () => {
      throw new Error('clear failed');
    };
    const controller = createPixelVideoController({ source, blackout: gate, onError });
    await controller.start();
    expect(() => gate.start()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(await controller.snapshot(1)).toEqual([]);
  });

  it('a throwing source.start on blackout end routes to onError (never breaks the gate dispatch)', async () => {
    const gate = createBlackoutState();
    const onError = vi.fn();
    const source = fakeSource();
    const controller = createPixelVideoController({ source, blackout: gate, onError });
    await controller.start();
    gate.start();
    source.start = () => {
      throw new Error('restart failed');
    };
    gate.end();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a snapshot that spans a WHOLE blackout (start then end) is still discarded', async () => {
    const gate = createBlackoutState();
    const source = fakeSource();
    let release: (() => void) | undefined;
    source.snapshot = vi.fn(
      () =>
        new Promise<CaptureDataEntry[]>((resolve) => {
          release = () => resolve([new CaptureDataEntryBase('video', 1, new Uint8Array([7]))]);
        }),
    );
    const controller = createPixelVideoController({ source, blackout: gate });
    await controller.start();
    const pending = controller.snapshot(1);
    gate.start();
    gate.end(); // the gate reads inactive again by the time the source answers
    release?.();
    expect(await pending).toEqual([]);
  });

  it('a failed start() rolls back the gate subscription too (no ghost controller reacting to blackouts)', async () => {
    const gate = createBlackoutState();
    const { source, calls } = sequence();
    source.start = () => {
      throw new Error('init failed');
    };
    const controller = createPixelVideoController({ source, blackout: gate, onError: vi.fn() });
    await controller.start();
    gate.start();
    gate.end();
    expect(calls).toEqual([]);
  });

  it('stop() really unsubscribes (the gate is told, not merely ignored)', async () => {
    const real = createBlackoutState();
    const unsubscribed = vi.fn();
    const gate = {
      isActive: () => real.isActive(),
      onChange: (l: (a: boolean) => void) => {
        const off = real.onChange(l);
        return () => {
          unsubscribed();
          off();
        };
      },
    };
    const controller = createPixelVideoController({ source: fakeSource(), blackout: gate });
    await controller.start();
    controller.stop();
    expect(unsubscribed).toHaveBeenCalledTimes(1);
  });

  it('stop() unsubscribes from the gate (a stopped controller must not restart capture)', async () => {
    const gate = createBlackoutState();
    const { source, calls } = sequence();
    const controller = createPixelVideoController({ source, blackout: gate });
    await controller.start();
    controller.stop();
    gate.start();
    gate.end();
    expect(calls).toEqual(['start', 'stop']);
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
