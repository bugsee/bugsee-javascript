import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ElectronDisplayTracker,
  electronDisplayTrackerFor,
  mapDisplay,
  resetElectronDisplayTracker,
  type ScreenSource,
} from './display-tracker';

type L = (...a: unknown[]) => void;
const display = (over: Record<string, unknown> = {}) => ({
  id: 1,
  size: { width: 1440, height: 900 },
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  scaleFactor: 2,
  rotation: 0,
  internal: true,
  displayFrequency: 60,
  label: 'Built-in Retina Display',
  ...over,
});

function fakeScreen(list: () => unknown = () => [display()], over: Record<string, unknown> = {}) {
  const table = new Map<string, L[]>();
  const screen = {
    getAllDisplays: vi.fn(list),
    on: vi.fn((e: string, l: L) => {
      table.set(e, [...(table.get(e) ?? []), l]);
    }),
    removeListener: vi.fn((e: string, l: L) => {
      table.set(
        e,
        (table.get(e) ?? []).filter((x) => x !== l),
      );
    }),
    ...over,
  };
  return {
    screen: screen as ScreenSource & typeof screen,
    fire: (e: string, ...a: unknown[]) => {
      for (const l of [...(table.get(e) ?? [])]) l({}, ...a);
    },
    count: (e: string) => table.get(e)?.length ?? 0,
    total: () => [...table.values()].reduce((n, l) => n + l.length, 0),
  };
}

const keys: object[] = [];
afterEach(() => {
  for (const k of keys.splice(0)) resetElectronDisplayTracker(k);
});
const track = (s: ReturnType<typeof fakeScreen>, onError?: (e: unknown) => unknown) => {
  keys.push(s.screen);
  return electronDisplayTrackerFor({ screen: s.screen }, onError);
};

describe('mapDisplay', () => {
  it('keeps id, size, scale, rotation, internal and refresh rate; drops label/bounds/workArea', () => {
    expect(mapDisplay(display({ workArea: { x: 0 } }))).toEqual({
      id: 1,
      width: 1440,
      height: 900,
      scaleFactor: 2,
      rotation: 0,
      internal: true,
      refreshRate: 60,
    });
  });
  it('rounds the real-Electron float refresh rate and scale factor to 2 decimals; a value rounding to 0 is dropped', () => {
    expect(
      mapDisplay(
        display({ displayFrequency: 59.996700286865234, scaleFactor: 1.2000000476837158 }),
      ),
    ).toMatchObject({ refreshRate: 60, scaleFactor: 1.2 });
    expect(mapDisplay(display({ displayFrequency: 59.994, scaleFactor: 1.5 }))).toMatchObject({
      refreshRate: 59.99,
      scaleFactor: 1.5,
    });
    const tiny = mapDisplay(display({ displayFrequency: 0.001, scaleFactor: 0.004 }));
    expect(tiny).not.toHaveProperty('refreshRate');
    expect(tiny).not.toHaveProperty('scaleFactor');
  });
  it('falls back to bounds for the size and omits absent/unusable optional fields', () => {
    expect(
      mapDisplay({
        id: 3,
        bounds: { width: 800, height: 600 },
        scaleFactor: 0,
        rotation: 45,
        internal: 'yes',
        displayFrequency: Number.NaN,
      }),
    ).toEqual({ id: 3, width: 800, height: 600 });
  });
  it('accepts every rotation Electron defines', () => {
    for (const r of [0, 90, 180, 270])
      expect(mapDisplay(display({ rotation: r }))?.rotation).toBe(r);
  });
  it('drops id -1 (invalid / not yet known) but keeps -10 (the virtual unified display)', () => {
    expect(mapDisplay(display({ id: -1 }))).toBeUndefined();
    expect(mapDisplay(display({ id: -10 }))?.id).toBe(-10);
    expect(mapDisplay(display({ id: 0 }))?.id).toBe(0);
  });
  it('is undefined without a finite id or a positive size, and for non-objects', () => {
    expect(mapDisplay(display({ id: undefined }))).toBeUndefined();
    expect(mapDisplay(display({ id: Number.NaN }))).toBeUndefined();
    expect(mapDisplay(display({ size: { width: 0, height: 5 } }))).toBeUndefined();
    expect(mapDisplay(display({ size: { width: 5, height: -1 } }))).toBeUndefined();
    expect(mapDisplay({ id: 1 })).toBeUndefined();
    expect(mapDisplay(null)).toBeUndefined();
    expect(mapDisplay('x')).toBeUndefined();
  });
});

describe('ElectronDisplayTracker', () => {
  it('attaches nothing until a stage has a listener', () => {
    const s = fakeScreen();
    track(s);
    expect(s.screen.on).not.toHaveBeenCalled();
  });

  it('displayAdded: maps the new display and attaches only display-added', () => {
    const s = fakeScreen();
    const t = track(s);
    const seen = vi.fn();
    const off = t.on('displayAdded', seen);
    expect(s.total()).toBe(1);
    s.fire('display-added', display({ id: 2, label: 'secret' }));
    expect(seen).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 2, width: 1440, height: 900 }),
    );
    expect(seen.mock.calls[0]?.[0]).not.toHaveProperty('label');
    off();
    expect(s.total()).toBe(0);
  });

  it('displayRemoved: maps the removed display', () => {
    const s = fakeScreen();
    const t = track(s);
    const seen = vi.fn();
    t.on('displayRemoved', seen);
    expect(s.count('display-removed')).toBe(1);
    s.fire('display-removed', display({ id: 9 }));
    expect(seen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 9 }));
  });

  it('displayMetricsChanged: carries the display and the changed metrics (strings only)', () => {
    const s = fakeScreen();
    const t = track(s);
    const seen = vi.fn();
    t.on('displayMetricsChanged', seen);
    s.fire('display-metrics-changed', display({ id: 4 }), ['bounds', 7, 'scaleFactor']);
    s.fire('display-metrics-changed', display({ id: 4 }), 'not-an-array');
    expect(seen.mock.calls.map((c) => c[0].changed)).toEqual([['bounds', 'scaleFactor'], []]);
    expect(seen.mock.calls[0]?.[0].display.id).toBe(4);
  });

  it('an unmappable display argument is ignored, not emitted', () => {
    const s = fakeScreen();
    const t = track(s);
    const seen = vi.fn();
    t.on('displayAdded', seen);
    s.fire('display-added', { id: 'x' });
    s.fire('display-added');
    expect(seen).not.toHaveBeenCalled();
  });

  it('displays: re-reads the fresh list after each of the three changes', () => {
    let list: unknown[] = [display()];
    const s = fakeScreen(() => list);
    const t = track(s);
    const seen = vi.fn();
    const off = t.on('displays', seen);
    expect(s.total()).toBe(3);
    list = [display(), display({ id: 2 })];
    s.fire('display-added', display({ id: 2 }));
    expect(seen.mock.calls[0]?.[0].displays.map((d: { id: number }) => d.id)).toEqual([1, 2]);
    list = [display()];
    s.fire('display-removed', display({ id: 2 }));
    s.fire('display-metrics-changed', display(), ['bounds']);
    expect(seen).toHaveBeenCalledTimes(3);
    expect(seen.mock.calls[2]?.[0].displays).toHaveLength(1);
    off();
    expect(s.total()).toBe(0);
  });

  it('displays: emits nothing when the list cannot be read (omit, never an empty list)', () => {
    let list: unknown = [display()];
    const s = fakeScreen(() => list);
    const t = track(s);
    const seen = vi.fn();
    t.on('displays', seen);
    list = [];
    s.fire('display-added', display());
    list = 'nope';
    s.fire('display-added', display());
    expect(seen).not.toHaveBeenCalled();
  });

  it('stages sharing an Electron event each keep their own listener (releasing one leaves the other)', () => {
    const s = fakeScreen();
    const t = track(s);
    const off = t.on('displayAdded', () => {});
    t.on('displays', () => {});
    expect(s.count('display-added')).toBe(2);
    off();
    expect(s.count('display-added')).toBe(1);
  });

  describe("current('displays')", () => {
    it('is the live mapped list, dropping unusable entries', () => {
      const s = fakeScreen(() => [display(), { id: 2 }, display({ id: 3 })]);
      expect(
        track(s)
          .current('displays')
          ?.displays.map((d) => d.id),
      ).toEqual([1, 3]);
    });
    it('is undefined for an empty list, a non-array, no getAllDisplays, or an unknown stage', () => {
      expect(track(fakeScreen(() => [])).current('displays')).toBeUndefined();
      expect(track(fakeScreen(() => ({}))).current('displays')).toBeUndefined();
      const quiet = vi.fn();
      expect(
        track(fakeScreen(undefined, { getAllDisplays: undefined }), quiet).current('displays'),
      ).toBeUndefined();
      expect(quiet).not.toHaveBeenCalled(); // a missing method is absence, not an error
      expect(track(fakeScreen()).current('x' as 'displays')).toBeUndefined();
      expect(new ElectronDisplayTracker().current('displays')).toBeUndefined();
    });
    it('reports a throwing read and answers undefined', () => {
      const onError = vi.fn();
      const s = fakeScreen(() => {
        throw new Error('read');
      });
      expect(track(s, onError).current('displays')).toBeUndefined();
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'read' }));
    });
  });

  it('a screen that cannot be released, or has no `on`, is never attached to', () => {
    const noRelease = fakeScreen(undefined, { removeListener: undefined });
    track(noRelease).on('displayAdded', () => {});
    expect(noRelease.screen.on).not.toHaveBeenCalled();
    const noOn = fakeScreen(undefined, { on: undefined });
    expect(() => track(noOn).on('displays', () => {})).not.toThrow();
  });

  it('a tracker with no screen attaches nothing', () => {
    new ElectronDisplayTracker().on('displayAdded', () => {});
  });

  describe('a screen whose property reads throw (Electron before app ready)', () => {
    const hostile = (message: string) =>
      new Proxy(
        {},
        {
          get() {
            throw new Error(message);
          },
        },
      ) as ScreenSource;

    it('subscribing never throws, nothing attaches, one report per stage attempt', () => {
      const onError = vi.fn();
      const screen = hostile('screen');
      keys.push(screen);
      const t = electronDisplayTrackerFor({ screen }, onError);
      expect(() => t.on('displayAdded', () => {})).not.toThrow();
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: 'screen' }),
      );
    });

    it("current('displays') is undefined and reported: the getAllDisplays read is inside the guard", () => {
      const onError = vi.fn();
      const screen = hostile('read');
      keys.push(screen);
      const t = electronDisplayTrackerFor({ screen }, onError);
      expect(t.current('displays')).toBeUndefined();
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'read' }));
    });
  });

  it('a list that is not an array (null, undefined, an object) is simply no list: undefined and NOT reported', () => {
    for (const value of [null, undefined, {}, 'x']) {
      const onError = vi.fn();
      const s = fakeScreen(() => value);
      expect(track(s, onError).current('displays')).toBeUndefined();
      expect(onError).not.toHaveBeenCalled();
    }
  });

  describe('registry', () => {
    it('is a singleton per screen; throws without one; relaunch rebinds onError; reset releases', () => {
      const s = fakeScreen();
      const first = vi.fn();
      const second = vi.fn();
      const t = track(s, first);
      expect(track(s, second)).toBe(t);
      track(s);
      expect(() => electronDisplayTrackerFor({})).toThrow(TypeError);
      t.on('displayAdded', () => {
        throw new Error('sub');
      });
      s.fire('display-added', display());
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
      resetElectronDisplayTracker(s.screen);
      expect(s.total()).toBe(0);
      expect(track(s)).not.toBe(t);
    });
  });
});
