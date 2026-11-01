import { describe, expect, it, vi } from 'vitest';
import { electronDisplays, electronWindowLayers, type WindowLike } from './display-video';

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const win = (
  id: number,
  bounds: ReturnType<typeof rect>,
  over: Partial<WindowLike> = {},
): WindowLike => ({
  id,
  getBounds: () => bounds,
  isVisible: () => true,
  isMinimized: () => false,
  isFocused: () => false,
  webContents: { capturePage: async () => ({ toJPEG: (q: number) => new Uint8Array([id, q]) }) },
  ...over,
});
const screenOf = (...displays: Array<{ id: number; bounds: ReturnType<typeof rect> }>) => ({
  getAllDisplays: () => displays,
});
const windowsOf = (...windows: WindowLike[]) => ({ getAllWindows: () => windows });

describe('electronDisplays', () => {
  const screen = screenOf(
    { id: 70, bounds: rect(1000, 0, 800, 600) },
    { id: 30, bounds: rect(0, 0, 1000, 600) },
  );

  it('numbers the display of the focused window 0 and the others by ascending native id', () => {
    const displays = electronDisplays(
      screen,
      windowsOf(win(1, rect(1100, 10, 100, 100), { isFocused: () => true })),
    );
    expect(displays().map((d) => [d.id, d.bounds.x])).toEqual([
      [0, 1000],
      [1, 0],
    ]);
  });

  it('gives every display a key that is its native id, whichever number it has now', () => {
    const focusOn = (x: number) =>
      electronDisplays(
        screen,
        windowsOf(win(1, rect(x, 10, 100, 100), { isFocused: () => true })),
      )();
    const keyOf = (list: ReturnType<ReturnType<typeof electronDisplays>>, id: number) =>
      list.find((d) => d.id === id)?.key;
    expect(keyOf(focusOn(1100), 0)).toBe(70);
    expect(keyOf(focusOn(10), 0)).toBe(30);
    expect(keyOf(focusOn(1100), 1)).toBe(30);
  });

  it('numbers the display that most overlaps a window straddling two displays (as getDisplayMatching does)', () => {
    const displays = electronDisplays(
      screen,
      windowsOf(win(1, rect(900, 10, 400, 100), { isFocused: () => true })), // 100 px on the left display, 300 on the right
    );
    expect(displays().map((d) => d.key)).toEqual([70, 30]);
  });

  it('falls back to the first created visible window when none is focused and none was', () => {
    const displays = electronDisplays(
      screen,
      windowsOf(
        win(3, rect(0, 10, 100, 100)),
        win(2, rect(1100, 10, 100, 100)),
        win(1, rect(0, 10, 100, 100), { isVisible: () => false }),
      ),
    );
    expect(displays().map((d) => d.key)).toEqual([70, 30]); // window 2: the lowest id that is visible
  });

  it('falls back to the first created window when none is visible', () => {
    const displays = electronDisplays(
      screen,
      windowsOf(
        win(5, rect(0, 10, 100, 100), { isVisible: () => false }),
        win(4, rect(1100, 10, 100, 100), { isVisible: () => false }),
      ),
    );
    expect(displays().map((d) => d.key)).toEqual([70, 30]);
  });

  it('keeps the display of the window that was focused last while nothing is focused now', () => {
    let focusedId: number | undefined = 2;
    const windows = [
      win(1, rect(0, 10, 100, 100), { isFocused: () => focusedId === 1 }),
      win(2, rect(1100, 10, 100, 100), { isFocused: () => focusedId === 2 }),
    ];
    const displays = electronDisplays(screen, windowsOf(...windows));
    expect(displays().map((d) => d.key)).toEqual([70, 30]);
    focusedId = undefined; // the app lost focus: window 2 is still the key window
    expect(displays().map((d) => d.key)).toEqual([70, 30]);
  });

  it('forgets a last-focused window that was destroyed', () => {
    let destroyed = false;
    let focused = true;
    const windows = [
      win(1, rect(0, 10, 100, 100)),
      win(2, rect(1100, 10, 100, 100), {
        isFocused: () => focused,
        isDestroyed: () => destroyed,
      }),
    ];
    const displays = electronDisplays(screen, windowsOf(...windows));
    expect(displays().map((d) => d.key)).toEqual([70, 30]);
    focused = false;
    destroyed = true;
    expect(displays().map((d) => d.key)).toEqual([30, 70]); // window 1 now
  });

  it('without any window the lowest native id is display 0', () => {
    const displays = electronDisplays(screen, windowsOf());
    expect(displays().map((d) => [d.id, d.bounds.x])).toEqual([
      [0, 0],
      [1, 1000],
    ]);
  });

  it('ignores a destroyed focused window, and falls back to the first display when the focused window is on none', () => {
    const destroyed = win(1, rect(1100, 10, 1, 1), {
      isFocused: () => true,
      isDestroyed: () => true,
    });
    expect(electronDisplays(screen, windowsOf(destroyed))()[0]?.bounds.x).toBe(0);
    const off = win(2, rect(9000, 9000, 10, 10), { isFocused: () => true });
    expect(electronDisplays(screen, windowsOf(off))()[0]?.bounds.x).toBe(0);
  });
});

describe('electronWindowLayers', () => {
  const display = { id: 0, bounds: rect(0, 0, 1000, 600) };

  it('lists visible overlapping windows back to front: creation order, the focused one on top', async () => {
    const layers = electronWindowLayers(
      windowsOf(
        win(3, rect(0, 0, 10, 10)),
        win(1, rect(0, 0, 10, 10), { isFocused: () => true }),
        win(2, rect(0, 0, 10, 10)),
      ),
    )(display);
    const grabbed = await Promise.all(layers.map((layer) => layer.capture()));
    expect(grabbed.map((bytes) => bytes[0])).toEqual([2, 3, 1]);
  });

  it('skips hidden, minimized, destroyed and off-display windows', () => {
    const layers = electronWindowLayers(
      windowsOf(
        win(1, rect(0, 0, 10, 10), { isVisible: () => false }),
        win(2, rect(0, 0, 10, 10), { isMinimized: () => true }),
        win(3, rect(0, 0, 10, 10), { isDestroyed: () => true }),
        win(4, rect(2000, 0, 10, 10)),
        win(5, rect(990, 590, 100, 100)),
      ),
    )(display);
    expect(layers).toHaveLength(1);
    expect(layers[0]?.bounds).toEqual(rect(990, 590, 100, 100));
  });

  it('overlap is checked on both axes and a window that only touches the display edge is not on it', () => {
    const layers = electronWindowLayers(
      windowsOf(
        win(1, rect(10, 700, 10, 10)), // same columns, below the display
        win(6, rect(10, 600, 10, 10)), // starts exactly at the bottom edge
        win(2, rect(1000, 0, 100, 100)), // starts exactly at the right edge
        win(3, rect(-50, 0, 50, 100)), // ends exactly at the left edge
        win(4, rect(10, -10, 10, 10)), // ends exactly at the top edge
        win(5, rect(10, 590, 10, 10)), // inside
      ),
    )(display);
    expect(layers.map((l) => l.bounds.y)).toEqual([590]);
  });

  it('grabs JPEG at the given quality (60 by default)', async () => {
    const w = win(1, rect(0, 0, 10, 10));
    const spy = vi.spyOn(w.webContents, 'capturePage');
    expect([
      ...(await (electronWindowLayers(windowsOf(w))(display)[0]?.capture() ??
        Promise.resolve(new Uint8Array()))),
    ]).toEqual([1, 60]);
    expect([
      ...(await (electronWindowLayers(windowsOf(w), 90)(display)[0]?.capture() ??
        Promise.resolve(new Uint8Array()))),
    ]).toEqual([1, 90]);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
