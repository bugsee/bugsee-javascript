import { describe, expect, it, vi } from 'vitest';
import {
  type ControlSenderLike,
  createElectronMainControl,
  type IpcMainControlEventLike,
  type IpcMainControlListener,
} from './main-control';
import { BUGSEE_CONTROL_CHANNEL, BUGSEE_HELLO_CHANNEL } from './preload-bridge';
import { decodeControl, encodeControl, encodeHello } from './protocol';

function fakeIpcMain() {
  const listeners = new Map<string, Set<IpcMainControlListener>>();
  return {
    ipcMain: {
      on(channel: string, listener: IpcMainControlListener): void {
        const set = listeners.get(channel) ?? new Set<IpcMainControlListener>();
        listeners.set(channel, set);
        set.add(listener);
      },
      removeListener(channel: string, listener: IpcMainControlListener): void {
        listeners.get(channel)?.delete(listener);
      },
    },
    emit(channel: string, event: IpcMainControlEventLike, ...args: unknown[]): void {
      for (const l of listeners.get(channel) ?? []) {
        l(event, ...args);
      }
    },
    has(channel: string): boolean {
      return (listeners.get(channel)?.size ?? 0) > 0;
    },
  };
}

function fakeSender(id = 1) {
  const sent: Array<{ channel: string; raw: string }> = [];
  return {
    sender: { id, send: vi.fn((channel: string, raw: string) => sent.push({ channel, raw })) },
    sent,
  };
}

describe('createElectronMainControl', () => {
  it('start() registers a listener on the hello channel', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    expect(ipc.has(BUGSEE_HELLO_CHANNEL)).toBe(false);
    control.start();
    expect(ipc.has(BUGSEE_HELLO_CHANNEL)).toBe(true);
  });

  it('replies to a hello with the session id on the control channel and registers the renderer', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 'sess-1' });
    control.start();
    const r = fakeSender();
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r.sender }, encodeHello());
    expect(control.rendererCount).toBe(1);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.channel).toBe(BUGSEE_CONTROL_CHANNEL);
    expect(decodeControl((r.sent[0] as { raw: string }).raw)).toEqual({
      command: 'session',
      sessionId: 'sess-1',
      blackout: false,
    });
  });

  it('broadcasts blackout start / end to every registered renderer', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    control.start();
    const a = fakeSender(1);
    const b = fakeSender(2);
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: a.sender }, encodeHello());
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: b.sender }, encodeHello());
    control.blackoutStart();
    control.blackoutEnd();
    for (const r of [a, b]) {
      expect(r.sent.slice(1).map((m) => decodeControl(m.raw)?.command)).toEqual([
        'blackout-start',
        'blackout-end',
      ]);
    }
  });

  it('the hello reply carries the CURRENT blackout state, so a renderer born mid-blackout stays dark', () => {
    const ipc = fakeIpcMain();
    let blackout = true;
    const control = createElectronMainControl({
      ipcMain: ipc.ipcMain,
      sessionId: 's1',
      isBlackout: () => blackout,
    });
    control.start();
    const during = fakeSender(1);
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: during.sender }, encodeHello());
    expect(decodeControl((during.sent[0] as { raw: string }).raw)).toEqual({
      command: 'session',
      sessionId: 's1',
      blackout: true,
    });
    blackout = false;
    const after = fakeSender(2);
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: after.sender }, encodeHello());
    expect(decodeControl((after.sent[0] as { raw: string }).raw)?.blackout).toBe(false);
  });

  it('a throwing isBlackout fails CLOSED (the renderer is told blackout is on)', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({
      ipcMain: ipc.ipcMain,
      sessionId: 's1',
      isBlackout: () => {
        throw new Error('gate gone');
      },
    });
    control.start();
    const r = fakeSender();
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r.sender }, encodeHello());
    expect(decodeControl((r.sent[0] as { raw: string }).raw)?.blackout).toBe(true);
  });

  it('without an isBlackout probe the reply still states bo:false explicitly', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    control.start();
    const r = fakeSender();
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r.sender }, encodeHello());
    const raw = (r.sent[0] as { raw: string }).raw;
    expect(JSON.parse(raw).bo).toBe(false);
    expect(decodeControl(raw)?.blackout).toBe(false);
  });

  it('ignores a non-hello message on the hello channel (no reply, no registration)', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    control.start();
    const r = fakeSender();
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r.sender }, encodeControl({ command: 'pause' }));
    expect(control.rendererCount).toBe(0);
    expect(r.sender.send).not.toHaveBeenCalled();
  });

  it('ignores a non-string arg on the hello channel', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    control.start();
    const r = fakeSender();
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r.sender }, { not: 'a string' });
    expect(control.rendererCount).toBe(0);
    expect(r.sender.send).not.toHaveBeenCalled();
  });

  it('does not register a hello whose event has no sender', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    control.start();
    ipc.emit(BUGSEE_HELLO_CHANNEL, {}, encodeHello());
    expect(control.rendererCount).toBe(0);
  });

  it('broadcasts pause/resume/flush to every registered renderer', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    control.start();
    const a = fakeSender(1);
    const b = fakeSender(2);
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: a.sender }, encodeHello());
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: b.sender }, encodeHello());
    a.sent.length = 0; // drop the session replies
    b.sent.length = 0;

    control.pause();
    control.resume();
    control.flush();

    for (const s of [a, b]) {
      expect(s.sent.map((m) => decodeControl(m.raw)?.command)).toEqual([
        'pause',
        'resume',
        'flush',
      ]);
      expect(s.sent.every((m) => m.channel === BUGSEE_CONTROL_CHANNEL)).toBe(true);
    }
  });

  it('stop() broadcasts stop to every renderer AND removes the hello listener', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    control.start();
    const a = fakeSender(1);
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: a.sender }, encodeHello());
    a.sent.length = 0;

    control.stop();

    expect(a.sent.map((m) => decodeControl(m.raw)?.command)).toEqual(['stop']);
    expect(ipc.has(BUGSEE_HELLO_CHANNEL)).toBe(false); // listener removed
  });

  it('declares the trace names the host owns in every session reply (`ho`), including a reload’s repeat hello', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({
      ipcMain: ipc.ipcMain,
      sessionId: 's1',
      hostOwnedTraces: ['displays', 'ram_js_heap_total'],
    });
    control.start();
    const r = fakeSender(7);
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r.sender }, encodeHello());
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r.sender }, encodeHello());
    expect(r.sent.map((m) => decodeControl(m.raw)?.hostOwnedTraces)).toEqual([
      ['displays', 'ram_js_heap_total'],
      ['displays', 'ram_js_heap_total'],
    ]);
  });

  it('a reply carries a COPY of the declared names (a later mutation of the option array changes nothing)', () => {
    const ipc = fakeIpcMain();
    const owned = ['displays'];
    const control = createElectronMainControl({
      ipcMain: ipc.ipcMain,
      sessionId: 's1',
      hostOwnedTraces: owned,
    });
    control.start();
    owned.push('battery');
    const r = fakeSender(7);
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r.sender }, encodeHello());
    expect(decodeControl(r.sent[0]?.raw as string)?.hostOwnedTraces).toEqual(['displays']);
  });

  it('states no `ho` at all without an option (the renderer keeps its built-in default)', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    control.start();
    const r = fakeSender(7);
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r.sender }, encodeHello());
    expect(JSON.parse(r.sent[0]?.raw as string)).not.toHaveProperty('ho');
  });

  it('dedupes a repeat hello from the same renderer (reload) but re-sends the session id', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 'sess-1' });
    control.start();
    const r = fakeSender();
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r.sender }, encodeHello());
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: r.sender }, encodeHello());
    expect(control.rendererCount).toBe(1); // one window, not two
    expect(r.sent).toHaveLength(2); // both hellos got a session reply
  });

  it('a renderer whose send throws (destroyed) does not break the broadcast to others', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    control.start();
    const dead = {
      sender: {
        id: 1,
        send: vi.fn(() => {
          throw new Error('Object has been destroyed');
        }),
      },
    };
    const alive = fakeSender(2);
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: dead.sender }, encodeHello());
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: alive.sender }, encodeHello());
    alive.sent.length = 0;

    expect(() => control.pause()).not.toThrow();
    expect(alive.sent.map((m) => decodeControl(m.raw)?.command)).toEqual(['pause']);
  });

  it('tolerates a registered sender that lacks a send fn (no throw on broadcast)', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    control.start();
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: { id: 1 } }, encodeHello());
    expect(control.rendererCount).toBe(1);
    expect(() => control.pause()).not.toThrow();
  });

  it('honours channel overrides', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({
      ipcMain: ipc.ipcMain,
      sessionId: 's1',
      helloChannel: 'hi',
      controlChannel: 'ctl',
    });
    control.start();
    const r = fakeSender();
    ipc.emit('hi', { sender: r.sender }, encodeHello());
    expect(r.sent[0]?.channel).toBe('ctl');
  });
});

// The renderer registry must SHRINK.
//
// Every window that ever said hello was retained for the process lifetime, pinning destroyed `webContents`
// objects — and whatever they retain — in the main process. An app that opens and closes windows in a loop
// leaks monotonically; `rendererCount`, documented as the window count, is wrong after the first close; and
// every pause/resume/flush/stop iterates a growing set of corpses.
//
// The fix hangs off the same lifecycle signal `render-process-gone` already relies on: a renderer that is
// gone is no longer a renderer.
describe('the renderer registry shrinks', () => {
  /** A sender that can be destroyed, the way a real `webContents` is. */
  function destroyableSender(id: number) {
    const sent: Array<{ channel: string; raw: string }> = [];
    const listeners: Array<() => void> = [];
    let destroyed = false;
    return {
      sent,
      /** How many `destroyed` listeners were installed — one per reload would be a listener leak. */
      destroyedSubscriptions: () => listeners.length,
      destroy: () => {
        destroyed = true;
        for (const l of listeners.splice(0)) l();
      },
      sender: {
        id,
        send: vi.fn((channel: string, raw: string) => {
          if (destroyed) throw new Error('Object has been destroyed');
          sent.push({ channel, raw });
        }),
        once: (event: string, listener: () => void) => {
          if (event === 'destroyed') listeners.push(listener);
        },
        isDestroyed: () => destroyed,
      },
    };
  }

  const helloFrom = (ipc: ReturnType<typeof fakeIpcMain>, sender: ControlSenderLike): void => {
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender }, encodeHello());
  };

  it('drops a renderer from the count when its webContents is destroyed', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    control.start();
    const a = destroyableSender(1);
    const b = destroyableSender(2);
    helloFrom(ipc, a.sender);
    helloFrom(ipc, b.sender);
    expect(control.rendererCount).toBe(2);
    a.destroy();
    expect(control.rendererCount).toBe(1); // …the documented window count is right again
  });

  it('stops broadcasting to a destroyed renderer', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    control.start();
    const a = destroyableSender(1);
    const b = destroyableSender(2);
    helloFrom(ipc, a.sender);
    helloFrom(ipc, b.sender);
    a.sent.length = 0;
    b.sent.length = 0;
    a.destroy();
    control.pause();
    expect(a.sent).toEqual([]); // the corpse is not addressed…
    expect(b.sent).toHaveLength(1); // …and the live renderer still is
  });

  it('prunes a renderer that reports itself destroyed without emitting the event', () => {
    // Belt and braces: `isDestroyed()` is the state Electron exposes, and a missed event would otherwise
    // keep the corpse forever. Broadcasting is where we notice.
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    control.start();
    const a = destroyableSender(1);
    helloFrom(ipc, a.sender);
    // Destroy WITHOUT firing the listener, as a missed/absent event would leave it.
    (a.sender as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true;
    control.pause();
    expect(control.rendererCount).toBe(0);
  });

  it('registers a plain sender with no lifecycle surface at all — the canary', () => {
    // The Electron object is host-supplied; a test double, an older Electron, or a proxy may expose neither
    // `once` nor `isDestroyed`. Such a sender must still be registered and still receive broadcasts.
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    control.start();
    const plain = fakeSender(9);
    helloFrom(ipc, plain.sender);
    expect(control.rendererCount).toBe(1);
    plain.sent.length = 0;
    control.pause();
    expect(plain.sent).toHaveLength(1);
  });

  it('does not stack `destroyed` listeners on a reload’s repeat hello', () => {
    // `rendererCount` alone does not test this: the registry is a Set, so it dedupes whatever we do. What
    // a repeat subscription actually costs is a listener per reload on the real webContents — Electron
    // warns past ten of them — so the subscription count is the assertion that has teeth.
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's1' });
    control.start();
    const a = destroyableSender(1);
    helloFrom(ipc, a.sender);
    helloFrom(ipc, a.sender);
    helloFrom(ipc, a.sender);
    expect(control.rendererCount).toBe(1);
    expect(a.destroyedSubscriptions()).toBe(1);
  });
});

// A killed renderer is NOT destroyed: `isDestroyed()` stays false while its frame is gone, and Electron prints
// 'Error sending from webContents: Render frame was disposed' for every `send` (real Electron 44.9.3 smoke).
describe('crashed renderers are not addressed', () => {
  function crashable(id: number) {
    let crashed = false;
    let destroyedListeners = 0;
    const sent: string[] = [];
    return {
      sent,
      setCrashed: (v: boolean) => (crashed = v),
      subscriptions: () => destroyedListeners,
      sender: {
        id,
        send: vi.fn((_c: string, raw: string) => {
          sent.push(raw);
        }),
        once: () => {
          destroyedListeners++;
        },
        isDestroyed: () => false,
        isCrashed: () => crashed,
      } as ControlSenderLike,
    };
  }
  const hello = (ipc: ReturnType<typeof fakeIpcMain>, s: ControlSenderLike) =>
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: s }, encodeHello());

  it('never sends to a sender whose isCrashed() is true, but still reaches the others', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's' });
    control.start();
    const dead = crashable(1);
    const live = crashable(2);
    hello(ipc, dead.sender);
    hello(ipc, live.sender);
    dead.sent.length = 0;
    live.sent.length = 0;
    dead.setCrashed(true);
    control.pause();
    expect(dead.sender.send).toHaveBeenCalledTimes(1); // only the hello reply
    expect(dead.sent).toEqual([]);
    expect(live.sent).toHaveLength(1);
  });

  it('a throwing isCrashed() is treated as not crashed (send is still attempted)', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's' });
    control.start();
    const a = crashable(1);
    (a.sender as { isCrashed: () => boolean }).isCrashed = () => {
      throw new Error('boom');
    };
    hello(ipc, a.sender);
    a.sent.length = 0;
    control.flush();
    expect(a.sent).toHaveLength(1);
  });

  it('rendererGone(id) forgets the sender; a reload re-handshakes and rejoins without stacking destroyed listeners', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's' });
    control.start();
    const a = crashable(7);
    hello(ipc, a.sender);
    expect(control.rendererCount).toBe(1);
    a.setCrashed(true);
    control.rendererGone(99); // unknown id: no-op
    expect(control.rendererCount).toBe(1);
    control.rendererGone(7);
    expect(control.rendererCount).toBe(0);
    // the webContents reloads: a new frame says hello again while isCrashed() is false
    a.setCrashed(false);
    a.sent.length = 0;
    hello(ipc, a.sender);
    expect(control.rendererCount).toBe(1);
    expect(a.sent).toHaveLength(1); // the session reply
    expect(a.sent[0]).toContain('session');
    expect(a.subscriptions()).toBe(1); // not 2
    control.pause();
    expect(a.sent).toHaveLength(2);
  });

  it.each([
    [1],
    ['yes'],
    [{}],
  ])('a truthy non-boolean isCrashed() (%j) is NOT read as crashed', (v) => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's' });
    control.start();
    const a = crashable(1);
    (a.sender as { isCrashed: () => unknown }).isCrashed = () => v;
    hello(ipc, a.sender);
    a.sent.length = 0;
    control.pause();
    expect(a.sent).toHaveLength(1);
  });

  it('rendererGone forgets EVERY sender sharing the id (does not stop at the first)', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's' });
    control.start();
    hello(ipc, crashable(3).sender);
    hello(ipc, crashable(3).sender);
    hello(ipc, crashable(4).sender);
    control.rendererGone(3);
    expect(control.rendererCount).toBe(1);
  });

  it('the hello reply is sent even if isCrashed() is stale-true (the hello proves the frame is alive)', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's' });
    control.start();
    const a = crashable(1);
    a.setCrashed(true);
    hello(ipc, a.sender);
    expect(a.sent).toHaveLength(1);
  });
});

// The one-shot `destroyed` subscription must not outlive the control: each cycle used to leave one per window.
describe('stop() releases the destroyed subscriptions', () => {
  function emitterSender(id: number, mode: 'removeListener' | 'off' | 'none' = 'removeListener') {
    const listeners: Array<() => void> = [];
    const sender: Record<string, unknown> = {
      id,
      send: vi.fn(),
      once: (_e: string, l: () => void) => listeners.push(l),
    };
    const remove = (_e: string, l: () => void) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    };
    if (mode !== 'none') sender[mode] = remove;
    return { sender: sender as ControlSenderLike, listeners };
  }
  const hello = (ipc: ReturnType<typeof fakeIpcMain>, s: ControlSenderLike) =>
    ipc.emit(BUGSEE_HELLO_CHANNEL, { sender: s }, encodeHello());

  it.each([
    'removeListener',
    'off',
  ] as const)('removes the listener from every sender via %s', (mode) => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's' });
    control.start();
    const a = emitterSender(1, mode);
    const b = emitterSender(2, mode);
    hello(ipc, a.sender);
    hello(ipc, b.sender);
    expect(a.listeners).toHaveLength(1);
    control.stop();
    expect(a.listeners).toHaveLength(0);
    expect(b.listeners).toHaveLength(0);
  });

  it('prefers removeListener over off', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's' });
    control.start();
    const a = emitterSender(1);
    const off = vi.fn();
    (a.sender as { off?: unknown }).off = off;
    hello(ipc, a.sender);
    control.stop();
    expect(off).not.toHaveBeenCalled();
    expect(a.listeners).toHaveLength(0);
  });

  it('a sender without a remover, or whose remover throws, never breaks stop() or the others', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's' });
    control.start();
    const none = emitterSender(1, 'none');
    const hostile = emitterSender(2);
    (hostile.sender as { removeListener: () => void }).removeListener = () => {
      throw new Error('gone');
    };
    const ok = emitterSender(3);
    hello(ipc, none.sender);
    hello(ipc, hostile.sender);
    hello(ipc, ok.sender);
    expect(() => control.stop()).not.toThrow();
    expect(ok.listeners).toHaveLength(0);
  });

  it('a sender without `once` is never tracked (nothing would drop the entry), so stop() does not touch it', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's' });
    control.start();
    const spy = vi.fn();
    const sender = { id: 1, send: vi.fn(), removeListener: spy } as ControlSenderLike;
    hello(ipc, sender);
    expect(control.rendererCount).toBe(1); // still registered and addressed
    control.stop();
    expect(spy).not.toHaveBeenCalled();
  });

  it('a second stop() does not release again', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's' });
    control.start();
    const a = emitterSender(1);
    const spy = vi.fn();
    (a.sender as { removeListener: unknown }).removeListener = spy;
    hello(ipc, a.sender);
    control.stop();
    control.stop();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a destroyed sender is no longer tracked, so stop() does not touch it again', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's' });
    control.start();
    const a = emitterSender(1);
    const spy = vi.fn();
    (a.sender as { removeListener: unknown }).removeListener = spy;
    hello(ipc, a.sender);
    a.listeners[0]?.(); // destroyed fires
    control.stop();
    expect(spy).not.toHaveBeenCalled();
  });

  it('a crash + reload rejoin keeps exactly one subscription, released by stop()', () => {
    const ipc = fakeIpcMain();
    const control = createElectronMainControl({ ipcMain: ipc.ipcMain, sessionId: 's' });
    control.start();
    const a = emitterSender(1);
    hello(ipc, a.sender);
    control.rendererGone(1);
    hello(ipc, a.sender);
    expect(a.listeners).toHaveLength(1);
    control.stop();
    expect(a.listeners).toHaveLength(0);
  });
});
