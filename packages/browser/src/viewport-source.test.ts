import type { VideoAuxEventDetail } from '@bugsee/capture';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserViewportSource, type ViewportEnv } from './viewport-source';

// A window whose geometry the test drives, and which records its own listeners so a test can fire the
// events the browser would. `environment: 'node'` — the browser tier is tested through injected seams.
class FakeWindow {
  innerWidth = 1280;
  innerHeight = 720;
  devicePixelRatio = 2;
  readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener();
    }
  }

  get listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) {
      total += set.size;
    }
    return total;
  }
}

class FakeVisualViewport extends FakeWindow {
  scale = 1;
  offsetLeft = 0;
  offsetTop = 0;
  width = 1280;
  height = 720;
}

/** A hand-cranked frame scheduler: `flush()` runs what the source queued. */
class FakeScheduler {
  #pending: (() => void) | null = null;
  cancelled = 0;
  scheduled = 0;

  readonly schedule = (cb: () => void): (() => void) => {
    this.scheduled += 1;
    this.#pending = cb;
    return () => {
      this.cancelled += 1;
      this.#pending = null;
    };
  };

  get isPending(): boolean {
    return this.#pending !== null;
  }

  flush(): void {
    const cb = this.#pending;
    this.#pending = null;
    cb?.();
  }
}

interface Harness {
  win: FakeWindow;
  vv: FakeVisualViewport;
  scheduler: FakeScheduler;
  events: VideoAuxEventDetail[];
  stop: () => void;
}

function harness(overrides: Partial<ViewportEnv> = {}): Harness {
  const win = new FakeWindow();
  const vv = new FakeVisualViewport();
  const scheduler = new FakeScheduler();
  const source = createBrowserViewportSource({
    window: win,
    visualViewport: vv,
    schedule: scheduler.schedule,
    ...overrides,
  });
  const events: VideoAuxEventDetail[] = [];
  // Subscribing is what activates the source (subscriber presence drives activation).
  const stop = source.on('viewport', (event) => events.push(event));
  return { win, vv, scheduler, events, stop };
}

describe('createBrowserViewportSource', () => {
  it('emits the frame once on activation, before any input can be recorded', () => {
    // The spec requires the first event unconditionally, not only on a change: a recording whose
    // geometry never changed used to carry an empty file, leaving a consumer with no frame at all
    // (specs video-aux.md, gap B6). This also pins that a subscriber receives the event the very act
    // of subscribing produced — the emitter registers the listener before it reports activation.
    const { events } = harness();

    expect(events).toStrictEqual([{ frameW: 1280, frameH: 720, density: 2 }]);
  });

  it('names the layout viewport as the frame, never the monitor', () => {
    const { win, events } = harness();

    // innerWidth/innerHeight, in CSS px — the same space clientX/clientY and
    // getBoundingClientRect() live in, so input and the view tree agree at any zoom.
    expect(events[0]?.frameW).toBe(win.innerWidth);
    expect(events[0]?.frameH).toBe(win.innerHeight);
  });

  it('omits scale, the offsets and the visible size when the page is not pinched', () => {
    const { events } = harness();

    // Absent `scale` is what tells a consumer the whole frame was visible.
    expect(events[0]).not.toHaveProperty('scale');
    expect(events[0]).not.toHaveProperty('offsetX');
    expect(events[0]).not.toHaveProperty('visibleW');
  });

  it('never writes displayId or the video paddings, which a page does not have', () => {
    const { events } = harness();

    // A page has one viewport, and its replay is a DOM stream with no encoded video. The spec writes
    // displayId only when non-zero, so a consumer must read its absence as "the only surface".
    expect(events[0]).not.toHaveProperty('displayId');
    expect(events[0]).not.toHaveProperty('paddingH');
    expect(events[0]).not.toHaveProperty('paddingV');
  });

  it('emits a resize on the next frame, not synchronously', () => {
    const { win, scheduler, events } = harness();
    win.innerWidth = 800;
    win.innerHeight = 600;

    win.fire('resize');
    // A window drag is a continuous stream of resize events; the spec caps a producer at one event per
    // animation frame.
    expect(events).toHaveLength(1);

    scheduler.flush();
    expect(events).toHaveLength(2);
    expect(events[1]).toStrictEqual({ frameW: 800, frameH: 600, density: 2 });
  });

  it('coalesces a burst of events into a single emit', () => {
    const { win, scheduler, events } = harness();
    win.innerWidth = 800;

    win.fire('resize');
    win.fire('resize');
    win.fire('resize');
    expect(scheduler.scheduled).toBe(1);

    scheduler.flush();
    expect(events).toHaveLength(2);
  });

  it('drops a frame identical to the one before it', () => {
    const { win, scheduler, events } = harness();

    win.fire('resize');
    scheduler.flush();

    // Nothing moved — a `visualViewport` scroll fires on an ordinary page scroll too, and page scroll
    // does not move the layout viewport that clientX is relative to.
    expect(events).toHaveLength(1);
  });

  it('follows a page zoom, which moves the density and the frame together', () => {
    const { win, scheduler, events } = harness();
    win.innerWidth = 1600;
    win.innerHeight = 900;
    win.devicePixelRatio = 1.6;

    win.fire('resize');
    scheduler.flush();

    expect(events[1]).toStrictEqual({ frameW: 1600, frameH: 900, density: 1.6 });
  });

  it('records a pinch from the visual viewport', () => {
    const { vv, scheduler, events } = harness();
    vv.scale = 2.5;
    vv.offsetLeft = 240;
    vv.offsetTop = 100;
    vv.width = 512;
    vv.height = 288;

    vv.fire('resize');
    scheduler.flush();

    expect(events[1]).toStrictEqual({
      frameW: 1280,
      frameH: 720,
      density: 2,
      scale: 2.5,
      offsetX: 240,
      offsetY: 100,
      visibleW: 512,
      visibleH: 288,
    });
  });

  it('records a pan of a pinched page from the visual viewport scroll', () => {
    const { vv, scheduler, events } = harness();
    vv.scale = 2.5;
    vv.width = 512;
    vv.height = 288;
    vv.fire('resize');
    scheduler.flush();

    vv.offsetLeft = 300;
    vv.fire('scroll');
    scheduler.flush();

    expect(events[2]?.offsetX).toBe(300);
  });

  it('keeps an offset that is non-zero while the page is not pinched', () => {
    // Safari can report an offset at scale 1 (a focused input scrolling the visual viewport). It still
    // describes what the person could see, so it is recorded; the visible size is not, because it is
    // the whole frame.
    const { vv, scheduler, events } = harness();
    vv.offsetLeft = 12;
    vv.offsetTop = 40;

    vv.fire('scroll');
    scheduler.flush();

    // BOTH axes: they are two independent branches, and a test that exercises only one lets the other
    // be gated on `scale` without anything going red.
    expect(events[1]).toStrictEqual({
      frameW: 1280,
      frameH: 720,
      density: 2,
      offsetX: 12,
      offsetY: 40,
    });
  });

  it('ignores a visual viewport whose readings are not numbers', () => {
    const { vv, scheduler, events } = harness();
    vv.scale = Number.NaN;
    vv.offsetLeft = Number.POSITIVE_INFINITY;
    vv.width = Number.NaN;
    vv.innerWidth = 999; // forces a change so the event is not deduped away

    vv.fire('resize');
    scheduler.flush();

    // The frame still stands on its own; a garbled visible region is omitted rather than written.
    expect(events).toStrictEqual([{ frameW: 1280, frameH: 720, density: 2 }]);
  });

  it('records a pinch whose visible size is unreadable, without inventing one', () => {
    // `scale` alone still answers "was the whole frame visible?" — it was not. The visible region is
    // derivable from `frameW / scale`, so omitting it loses only the engine's own rounding.
    const { vv, scheduler, events } = harness();
    vv.scale = 2.5;
    vv.width = Number.NaN;
    vv.height = 288;

    vv.fire('resize');
    scheduler.flush();

    expect(events[1]).toStrictEqual({ frameW: 1280, frameH: 720, density: 2, scale: 2.5 });
  });

  it('works with no visual viewport at all', () => {
    const { win, scheduler, events } = harness({ visualViewport: undefined });
    win.innerWidth = 800;

    win.fire('resize');
    scheduler.flush();

    expect(events).toStrictEqual([
      { frameW: 1280, frameH: 720, density: 2 },
      { frameW: 800, frameH: 720, density: 2 },
    ]);
  });

  it('emits nothing at all with no window (SSR, a worker)', () => {
    const { events, win } = harness({ window: undefined });

    expect(events).toStrictEqual([]);
    expect(win.listenerCount).toBe(0);
  });

  it('refuses to write a frame it cannot measure', () => {
    // A zero frame would make every placement a division by zero, and a consumer cannot tell a
    // fabricated frame from a real one. Writing nothing at least falls back to a known-wrong answer.
    const { events } = harness({ window: Object.assign(new FakeWindow(), { innerWidth: 0 }) });

    expect(events).toStrictEqual([]);
  });

  it('refuses a frame whose dimensions are not finite', () => {
    const { events } = harness({
      window: Object.assign(new FakeWindow(), { innerHeight: Number.NaN }),
    });

    expect(events).toStrictEqual([]);
  });

  it('falls back to a density of 1 when the ratio is unreadable', () => {
    // 1 is the identity — CSS px are device px — and nothing in the placement path divides by density,
    // so this cannot move a coordinate. The field is declared always-present, so it is not omitted.
    const { events } = harness({
      window: Object.assign(new FakeWindow(), { devicePixelRatio: 0 }),
    });

    expect(events[0]).toStrictEqual({ frameW: 1280, frameH: 720, density: 1 });
  });

  it('starts measuring again after the last subscriber leaves and a new one arrives', () => {
    const win = new FakeWindow();
    const vv = new FakeVisualViewport();
    const scheduler = new FakeScheduler();
    const source = createBrowserViewportSource({
      window: win,
      visualViewport: vv,
      schedule: scheduler.schedule,
    });

    const first: VideoAuxEventDetail[] = [];
    const stopFirst = source.on('viewport', (e) => first.push(e));
    expect(win.listenerCount).toBe(1);
    stopFirst();
    expect(win.listenerCount).toBe(0);

    const second: VideoAuxEventDetail[] = [];
    source.on('viewport', (e) => second.push(e));

    // The unconditional first event again: the previous recording's entries are gone, so a consumer
    // reading the new one needs its own geometry rather than inheriting the last emit's.
    expect(second).toStrictEqual([{ frameW: 1280, frameH: 720, density: 2 }]);
  });

  it('cancels a pending frame when it is deactivated mid-burst', () => {
    const { win, scheduler, stop, events } = harness();
    win.innerWidth = 800;
    win.fire('resize');
    expect(scheduler.isPending).toBe(true);

    stop();

    expect(scheduler.cancelled).toBe(1);
    expect(scheduler.isPending).toBe(false);
    expect(events).toHaveLength(1);
  });

  it('removes every listener it added when it is deactivated', () => {
    const { win, vv, stop } = harness();
    expect(win.listenerCount).toBeGreaterThan(0);
    expect(vv.listenerCount).toBeGreaterThan(0);

    stop();

    expect(win.listenerCount).toBe(0);
    expect(vv.listenerCount).toBe(0);
  });

  it('survives a geometry read that throws', () => {
    // Observe-only: an interceptor must never alter application behaviour, and these reads run from a
    // listener the application also uses.
    const hostile = new FakeWindow();
    Object.defineProperty(hostile, 'innerWidth', {
      get() {
        throw new Error('hostile');
      },
    });

    expect(() => harness({ window: hostile })).not.toThrow();
  });

  it('survives a listener registration that throws', () => {
    const hostile = new FakeWindow();
    hostile.addEventListener = () => {
      throw new Error('hostile');
    };

    expect(() => harness({ window: hostile })).not.toThrow();
  });

  it('defaults to the real animation frame when no scheduler is injected', () => {
    const raf = vi.fn((cb: () => void) => {
      cb();
      return 7;
    });
    const cancel = vi.fn();
    const g = globalThis as unknown as {
      requestAnimationFrame?: unknown;
      cancelAnimationFrame?: unknown;
    };
    const savedRaf = g.requestAnimationFrame;
    const savedCancel = g.cancelAnimationFrame;
    g.requestAnimationFrame = raf;
    g.cancelAnimationFrame = cancel;
    try {
      const win = new FakeWindow();
      const source = createBrowserViewportSource({ window: win, visualViewport: undefined });
      const events: VideoAuxEventDetail[] = [];
      source.on('viewport', (e) => events.push(e));

      win.innerWidth = 640;
      win.fire('resize');

      expect(raf).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(2);
    } finally {
      g.requestAnimationFrame = savedRaf;
      g.cancelAnimationFrame = savedCancel;
    }
  });

  it('cancels a pending animation frame on deactivation', () => {
    // A page that hides mid-pinch leaves a frame queued; firing it after the source is gone would
    // emit into a drained recording.
    const raf = vi.fn(() => 7);
    const cancel = vi.fn();
    const g = globalThis as unknown as {
      requestAnimationFrame?: unknown;
      cancelAnimationFrame?: unknown;
    };
    const savedRaf = g.requestAnimationFrame;
    const savedCancel = g.cancelAnimationFrame;
    g.requestAnimationFrame = raf;
    g.cancelAnimationFrame = cancel;
    try {
      const win = new FakeWindow();
      const source = createBrowserViewportSource({ window: win, visualViewport: undefined });
      const stop = source.on('viewport', () => {});

      win.innerWidth = 640;
      win.fire('resize');
      stop();

      expect(cancel).toHaveBeenCalledWith(7);
    } finally {
      g.requestAnimationFrame = savedRaf;
      g.cancelAnimationFrame = savedCancel;
    }
  });

  it('falls back to a timer when the runtime has no animation frame', () => {
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    const saved = g.requestAnimationFrame;
    g.requestAnimationFrame = undefined;
    vi.useFakeTimers();
    try {
      const win = new FakeWindow();
      const source = createBrowserViewportSource({ window: win, visualViewport: undefined });
      const events: VideoAuxEventDetail[] = [];
      source.on('viewport', (e) => events.push(e));

      win.innerWidth = 640;
      win.fire('resize');
      expect(events).toHaveLength(1);

      vi.runAllTimers();
      expect(events).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      g.requestAnimationFrame = saved;
    }
  });

  it('cancels a pending timer on deactivation when there is no animation frame', () => {
    const g = globalThis as unknown as { requestAnimationFrame?: unknown };
    const saved = g.requestAnimationFrame;
    g.requestAnimationFrame = undefined;
    vi.useFakeTimers();
    try {
      const win = new FakeWindow();
      const source = createBrowserViewportSource({ window: win, visualViewport: undefined });
      const events: VideoAuxEventDetail[] = [];
      const stop = source.on('viewport', (e) => events.push(e));

      win.innerWidth = 640;
      win.fire('resize');
      stop();
      vi.runAllTimers();

      expect(events).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      g.requestAnimationFrame = saved;
    }
  });

  it('reads the real globals when no window is injected', () => {
    const g = globalThis as unknown as { window?: unknown };
    const saved = g.window;
    const win = new FakeWindow();
    g.window = win;
    try {
      const source = createBrowserViewportSource();
      const events: VideoAuxEventDetail[] = [];
      source.on('viewport', (e) => events.push(e));

      expect(events).toStrictEqual([{ frameW: 1280, frameH: 720, density: 2 }]);
    } finally {
      g.window = saved;
    }
  });

  it("reads the window's own visualViewport when none is injected", () => {
    const g = globalThis as unknown as { window?: unknown };
    const saved = g.window;
    const win = new FakeWindow();
    const vv = new FakeVisualViewport();
    vv.scale = 3;
    vv.width = 400;
    vv.height = 240;
    g.window = Object.assign(win, { visualViewport: vv });
    try {
      const source = createBrowserViewportSource();
      const events: VideoAuxEventDetail[] = [];
      source.on('viewport', (e) => events.push(e));

      expect(events[0]?.scale).toBe(3);
      expect(events[0]?.visibleW).toBe(400);
    } finally {
      g.window = saved;
    }
  });
});
