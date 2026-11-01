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

const intersectionArea = (a: Rect, b: Rect): number => {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
};

/**
 * The displays as the `displays` trace numbers them: id 0 is the display that most overlaps the KEY window
 * (`screen.getDisplayMatching`), the others follow in ascending native id. The key window is the focused one, else the one
 * that was focused last, else the first created visible window, else the first created (the application tracker's rule).
 */
const asRect = (value: unknown): Rect | undefined => {
  const r = value as Partial<Record<keyof Rect, unknown>> | null | undefined;
  return typeof r === 'object' &&
    r !== null &&
    typeof r.x === 'number' &&
    typeof r.y === 'number' &&
    typeof r.width === 'number' &&
    typeof r.height === 'number'
    ? (r as Rect)
    : undefined;
};

/**
 * `keyWindowBounds` is the application tracker's key window (the source the `displays` trace reads on every focus event); give
 * it when there is one, so lane 0 and trace id 0 cannot disagree. Without it (or when it says nothing) the adapter applies the
 * same rule over the windows it sees, remembering the last focused one between ticks.
 */
export function electronDisplays(
  screen: ScreenLike,
  BrowserWindow: ElectronBrowserWindowLike,
  keyWindowBounds?: () => unknown,
): () => DisplayInfo[] {
  let lastFocused: WindowLike | undefined;
  const usable = (window: WindowLike): boolean => window.isDestroyed?.() !== true;
  return () => {
    const native = [...screen.getAllDisplays()].sort((a, b) => a.id - b.id);
    const windows = BrowserWindow.getAllWindows().filter(usable);
    const focused = windows.find((window) => window.isFocused());
    if (focused !== undefined) {
      lastFocused = focused;
    }
    const created = [...windows].sort((a, b) => a.id - b.id);
    const key =
      focused ??
      (lastFocused !== undefined && usable(lastFocused) ? lastFocused : undefined) ??
      created.find((window) => window.isVisible()) ??
      created[0];
    let tracked: Rect | undefined;
    try {
      tracked = asRect(keyWindowBounds?.());
    } catch {
      tracked = undefined; // a throwing tracker: use our own rule
    }
    const bounds = tracked ?? key?.getBounds();
    const areas = native.map((display) =>
      bounds === undefined ? 0 : intersectionArea(display.bounds, bounds),
    );
    const keyIndex = Math.max(0, areas.indexOf(Math.max(...areas)));
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
