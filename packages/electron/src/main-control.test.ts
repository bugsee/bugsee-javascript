import { describe, expect, it, vi } from 'vitest';
import {
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
        (listeners.get(channel) ?? listeners.set(channel, new Set()).get(channel)!).add(listener);
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
    expect(decodeControl(r.sent[0]!.raw)).toEqual({ command: 'session', sessionId: 'sess-1' });
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
      expect(s.sent.map((m) => decodeControl(m.raw)?.command)).toEqual(['pause', 'resume', 'flush']);
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
