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

  it('without a focused window the lowest native id is display 0', () => {
    const displays = electronDisplays(screen, windowsOf(win(1, rect(1100, 10, 100, 100))));
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
