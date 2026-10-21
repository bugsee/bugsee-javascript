import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ElectronApplicationTracker,
  electronApplicationTrackerFor,
  resetElectronApplicationTracker,
} from './application-tracker';

type L = (...a: unknown[]) => void;

class FakeEmitter {
  table = new Map<string, L[]>();
  on = vi.fn((e: string, l: L) => {
    this.table.set(e, [...(this.table.get(e) ?? []), l]);
  });
  removeListener = vi.fn((e: string, l: L) => {
    this.table.set(
      e,
      (this.table.get(e) ?? []).filter((x) => x !== l),
    );
  });
  emit(e: string, ...a: unknown[]) {
    for (const l of [...(this.table.get(e) ?? [])]) l({}, ...a);
  }
  count(e: string) {
    return this.table.get(e)?.length ?? 0;
  }
  total() {
    return [...this.table.values()].reduce((n, l) => n + l.length, 0);
  }
}

class FakeWebContents extends FakeEmitter {
  constructor(public id: unknown = 100) {
    super();
  }
  gone = false;
  isDestroyed = () => this.gone;
}

/** A window that, like Electron's, RE-EMITS its webContents' unresponsive/responsive. */
class FakeWindow extends FakeEmitter {
  webContents: FakeWebContents;
  gone = false;
  constructor(public id: unknown = 1) {
    super();
    this.webContents = new FakeWebContents((id as number) + 100);
    this.webContents.on('unresponsive', () => this.emit('unresponsive'));
  }
  isDestroyed = () => this.gone;
  close() {
    this.gone = true;
    this.webContents.gone = true;
    this.emit('closed');
    this.webContents.emit('destroyed');
  }
}

function setup(existing: FakeWindow[] = []) {
  const app = new FakeEmitter();
  const BrowserWindow = { getAllWindows: vi.fn(() => existing) };
  return { app, BrowserWindow };
}

const keys: object[] = [];
afterEach(() => {
  for (const k of keys.splice(0)) resetElectronApplicationTracker(k);
});
const track = (
  s: ReturnType<typeof setup>,
  onError?: (e: unknown) => unknown,
  withBrowserWindow = true,
) => {
  keys.push(s.app);
  return electronApplicationTrackerFor(
    { app: s.app, ...(withBrowserWindow ? { BrowserWindow: s.BrowserWindow } : {}) },
    onError,
  );
};

describe('ElectronApplicationTracker', () => {
  it('attaches nothing until a stage has a listener', () => {
    const s = setup([new FakeWindow()]);
    track(s);
    expect(s.app.on).not.toHaveBeenCalled();
    expect(s.BrowserWindow.getAllWindows).not.toHaveBeenCalled();
  });

  it('windowFocus: a window that ALREADY exists records focus/blur with its id', () => {
    const win = new FakeWindow(7);
    const s = setup([win]);
    const t = track(s);
    const seen = vi.fn();
    t.on('windowFocus', seen);
    win.emit('focus');
    win.emit('blur');
    expect(seen.mock.calls.map((c) => c[0])).toEqual([
      { focused: true, windowId: 7 },
      { focused: false, windowId: 7 },
    ]);
  });

  it('windowFocus: a window created AFTER arming still records focus', () => {
    const s = setup();
    const t = track(s);
    const seen = vi.fn();
    t.on('windowFocus', seen);
    const late = new FakeWindow(3);
    s.app.emit('browser-window-created', late);
    late.emit('focus');
    expect(seen).toHaveBeenCalledExactlyOnceWith({ focused: true, windowId: 3 });
  });

  it('windowVisibility: show/hide', () => {
    const win = new FakeWindow(2);
    const s = setup([win]);
    const t = track(s);
    const seen = vi.fn();
    t.on('windowVisibility', seen);
    win.emit('show');
    win.emit('hide');
    expect(seen.mock.calls.map((c) => c[0])).toEqual([
      { visible: true, windowId: 2 },
      { visible: false, windowId: 2 },
    ]);
    // focus is a different stage: not listened for here
    expect(win.count('focus')).toBe(0);
  });

  it('a window found both at arm time and via the creation event is bound ONCE', () => {
    const win = new FakeWindow();
    const s = setup([win]);
    const t = track(s);
    const seen = vi.fn();
    t.on('windowFocus', seen);
    s.app.emit('browser-window-created', win);
    win.emit('focus');
    expect(seen).toHaveBeenCalledOnce();
  });

  it('rendererResponsiveness: webContents.emit("unresponsive") records ONCE even though the owning window re-emits it', () => {
    const win = new FakeWindow(1);
    const s = setup([win]);
    const t = track(s);
    const seen = vi.fn();
    t.on('rendererResponsiveness', seen);
    win.webContents.emit('unresponsive'); // the fake window re-emits on itself, as Electron does
    expect(seen).toHaveBeenCalledExactlyOnceWith({ responsive: false, webContentsId: 101 });
    win.webContents.emit('responsive');
    expect(seen).toHaveBeenLastCalledWith({ responsive: true, webContentsId: 101 });
  });

  it('rendererResponsiveness: win.emit("unresponsive") ALONE does not record (nothing listens on the window)', () => {
    const win = new FakeWindow();
    const s = setup([win]);
    const t = track(s);
    const seen = vi.fn();
    t.on('rendererResponsiveness', seen);
    win.emit('unresponsive');
    win.emit('responsive');
    expect(seen).not.toHaveBeenCalled();
    expect(win.count('unresponsive')).toBe(0);
    expect(win.count('responsive')).toBe(0);
  });

  it('rendererResponsiveness: a web contents created later (a BrowserView/webview) is watched through web-contents-created', () => {
    const s = setup();
    const t = track(s);
    const seen = vi.fn();
    t.on('rendererResponsiveness', seen);
    const view = new FakeWebContents(55);
    s.app.emit('web-contents-created', view);
    view.emit('unresponsive');
    expect(seen).toHaveBeenCalledExactlyOnceWith({ responsive: false, webContentsId: 55 });
  });

  it('omits an id that is not a finite number, and survives an id getter that throws', () => {
    const s = setup();
    const t = track(s);
    const seen = vi.fn();
    t.on('windowFocus', seen);
    const noId = new FakeWindow('x');
    s.app.emit('browser-window-created', noId);
    noId.emit('focus');
    const boom = new FakeWindow();
    Object.defineProperty(boom, 'id', {
      get() {
        throw new Error('destroyed');
      },
    });
    s.app.emit('browser-window-created', boom);
    boom.emit('focus');
    expect(seen.mock.calls.map((c) => c[0])).toEqual([{ focused: true }, { focused: true }]);
  });

  it('a non-finite window/webContents id (NaN, Infinity) is omitted, a finite one kept', () => {
    const s = setup();
    const t = track(s);
    const seen = vi.fn();
    t.on('windowFocus', seen);
    for (const id of [Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      const w = new FakeWindow(1);
      w.id = id;
      s.app.emit('browser-window-created', w);
      w.emit('focus');
    }
    expect(seen.mock.calls.map((c) => c[0])).toEqual([
      { focused: true },
      { focused: true },
      { focused: true, windowId: 0 },
    ]);
  });

  it('a BrowserWindow whose property reads throw is reported once; windows created later are still tracked', () => {
    const s = setup();
    const onError = vi.fn();
    keys.push(s.app);
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('not ready');
        },
      },
    );
    const t = electronApplicationTrackerFor({ app: s.app, BrowserWindow: hostile }, onError);
    const seen = vi.fn();
    t.on('windowFocus', seen);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: 'not ready' }),
    );
    const late = new FakeWindow(2);
    s.app.emit('browser-window-created', late);
    late.emit('focus');
    expect(seen).toHaveBeenCalledOnce();
  });

  it('an app whose property reads throw: subscribing never throws, nothing attaches, reported', () => {
    const onError = vi.fn();
    const hostileApp = new Proxy(
      {},
      {
        get() {
          throw new Error('app');
        },
      },
    );
    keys.push(hostileApp);
    const t = electronApplicationTrackerFor({ app: hostileApp }, onError);
    expect(() => t.on('windowFocus', () => {})).not.toThrow();
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'app' }));
  });

  it("release removes EVERY listener: the app creation listener and each object's", () => {
    const w1 = new FakeWindow(1);
    const s = setup([w1]);
    const t = track(s);
    const off1 = t.on('windowFocus', () => {});
    const off2 = t.on('windowVisibility', () => {});
    const off3 = t.on('rendererResponsiveness', () => {});
    const late = new FakeWindow(2);
    s.app.emit('browser-window-created', late);
    expect(s.app.count('browser-window-created')).toBe(2);
    expect(s.app.count('web-contents-created')).toBe(1);
    off1();
    off2();
    off3();
    expect(s.app.total()).toBe(0);
    expect(w1.count('focus') + w1.count('blur') + w1.count('show') + w1.count('hide')).toBe(0);
    expect(w1.count('closed')).toBe(0);
    expect(late.total()).toBe(0);
    // webContents: only the fake's own re-emit hook remains (it is the test's, not ours)
    expect(w1.webContents.count('unresponsive')).toBe(1);
    expect(w1.webContents.count('responsive')).toBe(0);
    expect(w1.webContents.count('destroyed')).toBe(0);
  });

  it('a late creation event after release is ignored', () => {
    const s = setup();
    const t = track(s);
    const off = t.on('windowFocus', () => {});
    const creation = s.app.table.get('browser-window-created')?.[0] as L;
    off();
    const late = new FakeWindow();
    creation({}, late);
    expect(late.total()).toBe(0);
  });

  it('a destroyed window is never bound, forgets itself on closed, does not leak and release does not touch it', () => {
    const dead = new FakeWindow(4);
    dead.gone = true;
    const win = new FakeWindow(5);
    const s = setup([dead, win]);
    const t = track(s);
    const off = t.on('windowFocus', () => {});
    expect(dead.total()).toBe(0);
    expect(win.count('focus')).toBe(1);
    win.close(); // 'closed' -> forgotten
    win.removeListener.mockClear();
    off();
    expect(win.removeListener).not.toHaveBeenCalled(); // destroyed: nothing to remove, nothing thrown
  });

  it('a window/webContents that reports closed/destroyed is forgotten: release never touches it, even if isDestroyed is still false', () => {
    const win = new FakeWindow(5);
    const s = setup([win]);
    const t = track(s);
    const offF = t.on('windowFocus', () => {});
    const offR = t.on('rendererResponsiveness', () => {});
    win.emit('closed');
    win.webContents.emit('destroyed');
    win.removeListener.mockClear();
    win.webContents.removeListener.mockClear();
    offF();
    offR();
    expect(win.removeListener).not.toHaveBeenCalled();
    expect(win.webContents.removeListener).not.toHaveBeenCalled();
  });

  it('release skips an object that became destroyed without ever emitting closed', () => {
    const win = new FakeWindow(5);
    const s = setup([win]);
    const off = track(s).on('windowFocus', () => {});
    win.gone = true;
    win.removeListener.mockClear();
    off();
    expect(win.removeListener).not.toHaveBeenCalled();
  });

  it('a window that throws on isDestroyed is treated as destroyed (not bound)', () => {
    const win = new FakeWindow();
    win.isDestroyed = () => {
      throw new Error('gone');
    };
    const s = setup([win]);
    track(s).on('windowFocus', () => {});
    expect(win.total()).toBe(0);
  });

  it('release is robust when an object throws on removal (reported, others still released)', () => {
    const a = new FakeWindow(1);
    const b = new FakeWindow(2);
    const s = setup([a, b]);
    const onError = vi.fn();
    const t = track(s, onError);
    const off = t.on('windowFocus', () => {});
    a.removeListener.mockImplementation(() => {
      throw new Error('remove');
    });
    off();
    expect(onError).toHaveBeenCalled();
    expect(b.count('focus')).toBe(0);
    expect(s.app.count('browser-window-created')).toBe(0);
  });

  it('a throwing getAllWindows is reported, and windows created later are still tracked', () => {
    const s = setup();
    s.BrowserWindow.getAllWindows.mockImplementation(() => {
      throw new Error('list');
    });
    const onError = vi.fn();
    const t = track(s, onError);
    const seen = vi.fn();
    t.on('windowFocus', seen);
    expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'list' }));
    const late = new FakeWindow();
    s.app.emit('browser-window-created', late);
    late.emit('focus');
    expect(seen).toHaveBeenCalledOnce();
  });

  it('a non-array getAllWindows, a missing BrowserWindow, and a window whose webContents throws are tolerated', () => {
    const s = setup();
    s.BrowserWindow.getAllWindows.mockReturnValue('nope' as never);
    track(s).on('rendererResponsiveness', () => {});
    const s2 = setup();
    track(s2, undefined, false).on('windowFocus', () => {});
    expect(s2.app.count('browser-window-created')).toBe(1);
    const win = new FakeWindow();
    Object.defineProperty(win, 'webContents', {
      get() {
        throw new Error('destroyed');
      },
    });
    const s3 = setup([win]);
    const onError = vi.fn();
    track(s3, onError).on('rendererResponsiveness', () => {});
    expect(onError).not.toHaveBeenCalled();
    expect(s3.app.count('web-contents-created')).toBe(1);
  });

  it('ignores a non-object creation payload', () => {
    const s = setup();
    track(s).on('windowFocus', () => {});
    expect(() => {
      s.app.emit('browser-window-created', null);
      s.app.emit('browser-window-created', 'x');
      s.app.emit('browser-window-created');
    }).not.toThrow();
  });

  it('an object that cannot be listened on is skipped and reported; the rest still work', () => {
    const bad = new FakeWindow(9);
    bad.on = vi.fn(() => {
      throw new Error('on');
    });
    const good = new FakeWindow(8);
    const s = setup([bad, good]);
    const onError = vi.fn();
    const seen = vi.fn();
    track(s, onError).on('windowFocus', seen);
    good.emit('focus');
    expect(seen).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('an app that cannot be released (or has no `on`) is never attached to', () => {
    const s = setup([new FakeWindow()]);
    (s.app as unknown as { removeListener?: unknown }).removeListener = undefined;
    track(s).on('windowFocus', () => {});
    expect(s.app.on).not.toHaveBeenCalled();
    expect(s.BrowserWindow.getAllWindows).not.toHaveBeenCalled();
  });

  it('a tracker with no app attaches nothing', () => {
    new ElectronApplicationTracker().on('windowFocus', () => {});
  });

  it('windowMoved: records the end-of-drag `moved` event with the window id, released with the stage', () => {
    const win = new FakeWindow(4);
    const s = setup([win]);
    const t = track(s);
    const seen = vi.fn();
    const off = t.on('windowMoved', seen);
    win.emit('moved');
    win.emit('move'); // continuous `move` is not subscribed
    expect(seen.mock.calls).toEqual([[{ windowId: 4 }]]);
    expect(win.count('moved')).toBe(1);
    off();
    expect(win.count('moved')).toBe(0);
    expect(s.app.total()).toBe(0);
  });

  describe('keyWindowBounds', () => {
    class BoundsWindow extends FakeWindow {
      bounds: unknown;
      constructor(id: number, bounds: unknown = { x: id * 100, y: 0, width: 10, height: 10 }) {
        super(id);
        this.bounds = bounds;
      }
      getBounds = vi.fn(() => this.bounds);
    }
    const keyOf = (
      wins: BoundsWindow[],
      focused?: () => unknown,
      onError?: (e: unknown) => unknown,
    ) => {
      const s = setup(wins);
      const BW = {
        getAllWindows: vi.fn(() => wins),
        ...(focused !== undefined ? { getFocusedWindow: vi.fn(focused) } : {}),
      };
      keys.push(s.app);
      return {
        s,
        BW,
        t: electronApplicationTrackerFor({ app: s.app, BrowserWindow: BW }, onError),
      };
    };

    it('is the FOCUSED window (getFocusedWindow) first', () => {
      const a = new BoundsWindow(1);
      const b = new BoundsWindow(2);
      expect(keyOf([a, b], () => b).t.keyWindowBounds()).toEqual({
        x: 200,
        y: 0,
        width: 10,
        height: 10,
      });
    });

    it('else the most recently focused (remembered while windowFocus is armed), else the first created', () => {
      const a = new BoundsWindow(1);
      const b = new BoundsWindow(2);
      const { t } = keyOf([a, b], () => null);
      // nothing focused yet and nothing remembered: the first created
      expect(t.keyWindowBounds()).toEqual({ x: 100, y: 0, width: 10, height: 10 });
      t.on('windowFocus', () => undefined);
      b.emit('focus');
      b.emit('blur');
      a.emit('blur'); // a blur is not a focus: b stays the most recently focused
      expect(t.keyWindowBounds()).toEqual({ x: 200, y: 0, width: 10, height: 10 });
      a.emit('focus');
      expect(t.keyWindowBounds()).toEqual({ x: 100, y: 0, width: 10, height: 10 });
    });

    it('a closed or destroyed window is never the key window: falls through to the next rule', () => {
      const a = new BoundsWindow(1);
      const b = new BoundsWindow(2);
      const c = new BoundsWindow(3);
      const { t } = keyOf([a, b, c], () => c);
      t.on('windowFocus', () => undefined);
      b.emit('focus');
      c.close(); // focused (destroyed) -> most recent (b)
      expect(t.keyWindowBounds()).toEqual({ x: 200, y: 0, width: 10, height: 10 });
      b.close(); // forgotten on `closed` -> first listed that is alive (a)
      expect(t.keyWindowBounds()).toEqual({ x: 100, y: 0, width: 10, height: 10 });
      a.gone = true; // destroyed without a `closed` event
      expect(t.keyWindowBounds()).toBeUndefined();
    });

    it('a most-recently-focused window that closed (event only) or was destroyed (no event) is not remembered', () => {
      const a = new BoundsWindow(1);
      const b = new BoundsWindow(2);
      const { t } = keyOf([a, b], () => null);
      t.on('windowFocus', () => undefined);
      b.emit('focus');
      b.emit('closed'); // forgotten on the event even though isDestroyed is still false
      expect(t.keyWindowBounds()).toEqual({ x: 100, y: 0, width: 10, height: 10 });
      b.emit('focus'); // (its listeners are gone after closed; re-remember through a fresh arm is not possible)
      const c = new BoundsWindow(3);
      const d = new BoundsWindow(4);
      const second = keyOf([c, d], () => null);
      second.t.on('windowFocus', () => undefined);
      d.emit('focus');
      d.gone = true; // destroyed without `closed`
      expect(second.t.keyWindowBounds()).toEqual({ x: 300, y: 0, width: 10, height: 10 });
    });

    it('is undefined with no windows, without BrowserWindow, or without getBounds', () => {
      expect(keyOf([]).t.keyWindowBounds()).toBeUndefined();
      const s = setup([]);
      expect(track(s, undefined, false).keyWindowBounds()).toBeUndefined();
      const noBounds = new FakeWindow(1);
      expect(keyOf([noBounds as BoundsWindow]).t.keyWindowBounds()).toBeUndefined();
    });

    it('hostile getFocusedWindow / getAllWindows / getBounds never throw and are reported', () => {
      const onError = vi.fn();
      const a = new BoundsWindow(1);
      const { t } = keyOf(
        [a],
        () => {
          throw new Error('focused');
        },
        onError,
      );
      expect(t.keyWindowBounds()).toEqual({ x: 100, y: 0, width: 10, height: 10 }); // falls to first created
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: 'focused' }),
      );
      const onError2 = vi.fn();
      const s = setup([]);
      keys.push(s.app);
      const t2 = electronApplicationTrackerFor(
        {
          app: s.app,
          BrowserWindow: {
            getAllWindows: () => {
              throw new Error('all');
            },
          },
        },
        onError2,
      );
      expect(t2.keyWindowBounds()).toBeUndefined();
      expect(onError2).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'all' }));
      const onError3 = vi.fn();
      const bad = new BoundsWindow(1);
      bad.getBounds = vi.fn(() => {
        throw new Error('bounds');
      });
      expect(keyOf([bad], undefined, onError3).t.keyWindowBounds()).toBeUndefined();
      expect(onError3).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: 'bounds' }),
      );
    });
  });

  describe('registry / rebind', () => {
    it('is a singleton per app; throws without one', () => {
      const s = setup();
      expect(track(s)).toBe(track(s));
      expect(() => electronApplicationTrackerFor({})).toThrow(TypeError);
    });

    it('a relaunch rebinds onError (latest wins, absent keeps)', () => {
      const s = setup();
      const first = vi.fn();
      const second = vi.fn();
      const t = track(s, first);
      track(s, second);
      track(s, undefined);
      t.on('windowFocus', () => {
        throw new Error('sub');
      });
      const win = new FakeWindow();
      s.app.emit('browser-window-created', win);
      win.emit('focus');
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
    });

    it('a CHANGED BrowserWindow re-arms against it; an unchanged or absent one restarts nothing', () => {
      const s = setup();
      const t = track(s);
      t.on('windowFocus', () => {});
      const created = s.app.on.mock.calls.length;
      track(s); // same BrowserWindow
      track(s, undefined, false); // absent: keeps ours
      expect(s.app.on.mock.calls.length).toBe(created);
      const win = new FakeWindow(6);
      const other = { getAllWindows: vi.fn(() => [win]) };
      electronApplicationTrackerFor({ app: s.app, BrowserWindow: other });
      expect(other.getAllWindows).toHaveBeenCalledOnce();
      expect(s.BrowserWindow.getAllWindows).toHaveBeenCalledOnce(); // only the original arm
      expect(s.app.count('browser-window-created')).toBe(1); // old creation listener released
      expect(win.count('focus')).toBe(1);
    });

    it('reset releases everything and the next for() builds a fresh tracker', () => {
      const win = new FakeWindow();
      const s = setup([win]);
      const t = track(s);
      t.on('windowFocus', () => {});
      t.on('rendererResponsiveness', () => {});
      resetElectronApplicationTracker(s.app);
      expect(s.app.total()).toBe(0);
      expect(win.count('focus')).toBe(0);
      expect(track(s)).not.toBe(t);
    });
  });
});
