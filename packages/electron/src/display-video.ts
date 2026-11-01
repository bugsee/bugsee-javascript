// Electron adapters for the per-display pixel video: which displays exist, and which windows are on each one. Both take the
// Electron objects as structural arguments (no electron dependency), so they are testable with fakes. The compositor and
// the muxer stay injected (`createDisplayVideoSource`).
import type { DisplayInfo, Rect, WindowLayer } from './video-capture';

/** The slice of Electron's `screen` used. */
export interface ScreenLike {
  getAllDisplays(): Array<{ id: number; bounds: Rect }>;
}

/** The slice of an Electron `BrowserWindow` used. */
export interface WindowLike {
  id: number;
  getBounds(): Rect;
  isVisible(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  isDestroyed?(): boolean;
  webContents: { capturePage(): Promise<{ toJPEG(quality: number): Uint8Array }> };
}

export interface ElectronBrowserWindowLike {
  getAllWindows(): WindowLike[];
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * The displays as the `displays` trace numbers them: id 0 is the display of the focused window (the key window), the others
 * follow in ascending native id. Without a focused window the lowest native id is 0.
 */
export function electronDisplays(
  screen: ScreenLike,
  BrowserWindow: ElectronBrowserWindowLike,
): () => DisplayInfo[] {
  return () => {
    const native = [...screen.getAllDisplays()].sort((a, b) => a.id - b.id);
    const focused = BrowserWindow.getAllWindows().find(
      (window) => window.isDestroyed?.() !== true && window.isFocused(),
    );
    const keyIndex =
      focused === undefined
        ? 0
        : Math.max(
            0,
            native.findIndex((display) => overlaps(display.bounds, focused.getBounds())),
          );
    const ordered = [
      ...native.slice(keyIndex, keyIndex + 1),
      ...native.filter((_, i) => i !== keyIndex),
    ];
    return ordered.map((display, id) => ({ id, key: display.id, bounds: display.bounds }));
  };
}

/**
 * The visible, non-minimized windows that overlap a display, back to front. Electron exposes no z-order, so: windows in
 * creation order (ascending id), the focused one last (on top). A heuristic, and the one stated limit of this adapter.
 */
export function electronWindowLayers(
  BrowserWindow: ElectronBrowserWindowLike,
  quality = 60,
): (display: DisplayInfo) => WindowLayer[] {
  return (display) =>
    BrowserWindow.getAllWindows()
      .filter(
        (window) =>
          window.isDestroyed?.() !== true &&
          window.isVisible() &&
          !window.isMinimized() &&
          overlaps(window.getBounds(), display.bounds),
      )
      .sort((a, b) => Number(a.isFocused()) - Number(b.isFocused()) || a.id - b.id)
      .map((window) => ({
        bounds: window.getBounds(),
        capture: async () => (await window.webContents.capturePage()).toJPEG(quality),
      }));
}
