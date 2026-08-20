import type { StoredEntry } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import { createElectronMainReceiver, type IpcMainEventLike } from './main-receiver';
import { BUGSEE_STREAM_CHANNEL } from './preload-bridge';
import { encodeStreamEntry } from './protocol';

/** A fake ipcMain that records listeners and can emit to them. */
function fakeIpcMain() {
  const listeners = new Map<string, (event: IpcMainEventLike, ...args: unknown[]) => void>();
  return {
    ipcMain: {
      on: vi.fn(
        (channel: string, listener: (event: IpcMainEventLike, ...args: unknown[]) => void) => {
          listeners.set(channel, listener);
        },
      ),
      removeListener: vi.fn((channel: string) => {
        listeners.delete(channel);
      }),
    },
    emit(channel: string, event: IpcMainEventLike, raw: unknown) {
      listeners.get(channel)?.(event, raw);
    },
    has: (channel: string) => listeners.has(channel),
  };
}

function fakeStore() {
  const added: StoredEntry[] = [];
  return { store: { add: (e: StoredEntry) => added.push(e) }, added };
}

const wire = (type: string, timestamp: number, payload: string) =>
  encodeStreamEntry({
    type: type as never,
    seq: 1,
    timestamp,
    mono: 0,
    timeOrigin: 0,
    redacted: false,
    payload,
  });

describe('createElectronMainReceiver', () => {
  it('on start, subscribes to the stream channel and merges decoded entries into the main store', () => {
    const ipc = fakeIpcMain();
    const s = fakeStore();
    const receiver = createElectronMainReceiver({ ipcMain: ipc.ipcMain, store: s.store });
    receiver.start();
    expect(ipc.has(BUGSEE_STREAM_CHANNEL)).toBe(true);

    ipc.emit(BUGSEE_STREAM_CHANNEL, { sender: { id: 3 } }, wire('network', 500, '{"u":"x"}'));

    expect(s.added).toEqual([{ type: 'network', timestamp: 500, serialized: '{"u":"x"}' }]);
  });

  it('calls onEntry with the decoded entry + originating window id', () => {
    const ipc = fakeIpcMain();
    const s = fakeStore();
    const onEntry = vi.fn();
    createElectronMainReceiver({ ipcMain: ipc.ipcMain, store: s.store, onEntry }).start();
    ipc.emit(BUGSEE_STREAM_CHANNEL, { sender: { id: 42 } }, wire('log', 1, '{}'));
    expect(onEntry).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'log', timestamp: 1 }),
      42,
    );
  });

  it('defaults the window id to -1 when the event has no sender', () => {
    const ipc = fakeIpcMain();
    const s = fakeStore();
    const onEntry = vi.fn();
    createElectronMainReceiver({ ipcMain: ipc.ipcMain, store: s.store, onEntry }).start();
    ipc.emit(BUGSEE_STREAM_CHANNEL, {}, wire('log', 1, '{}'));
    expect(onEntry).toHaveBeenCalledWith(expect.anything(), -1);
  });

  it('ignores non-string payloads and undecodable messages (no store write)', () => {
    const ipc = fakeIpcMain();
    const s = fakeStore();
    createElectronMainReceiver({ ipcMain: ipc.ipcMain, store: s.store }).start();
    ipc.emit(BUGSEE_STREAM_CHANNEL, {}, 12345); // not a string
    ipc.emit(BUGSEE_STREAM_CHANNEL, {}, '<<bad json>>');
    ipc.emit(BUGSEE_STREAM_CHANNEL, {}, JSON.stringify({ k: 'control' })); // not an entry
    expect(s.added).toEqual([]);
  });

  it('honours a custom channel', () => {
    const ipc = fakeIpcMain();
    const s = fakeStore();
    createElectronMainReceiver({ ipcMain: ipc.ipcMain, store: s.store, channel: 'x:c' }).start();
    ipc.emit('x:c', {}, wire('log', 7, '{}'));
    expect(s.added).toHaveLength(1);
  });

  it('stop() removes the listener (later messages are dropped)', () => {
    const ipc = fakeIpcMain();
    const s = fakeStore();
    const receiver = createElectronMainReceiver({ ipcMain: ipc.ipcMain, store: s.store });
    receiver.start();
    receiver.stop();
    expect(ipc.has(BUGSEE_STREAM_CHANNEL)).toBe(false);
    ipc.emit(BUGSEE_STREAM_CHANNEL, {}, wire('log', 1, '{}'));
    expect(s.added).toEqual([]);
  });
});

describe('createElectronMainReceiver — report routing + listener containment', () => {
  const ipc = () => {
    const listeners: Array<(e: unknown, raw: string) => void> = [];
    return {
      ipcMain: {
        on: (_c: string, l: (e: unknown, raw: string) => void) => listeners.push(l),
        removeListener: () => {},
      } as never,
      send: (raw: string) => {
        for (const l of listeners) l({ sender: { id: 3 } }, raw);
      },
    };
  };
  const inertStore = { add: () => {} };

  it('routes a report to onReport WITHOUT storing it as capture', () => {
    const { ipcMain, send } = ipc();
    const added: unknown[] = [];
    const reports: unknown[] = [];
    createElectronMainReceiver({
      ipcMain,
      store: { add: (e) => added.push(e) },
      onReport: (r) => reports.push(r),
    }).start();
    send(
      JSON.stringify({
        k: 'report',
        p: { source: { type: 'crash', mechanism: 'uncaught' }, report: {} },
        ts: 1,
      }),
    );
    expect(reports).toHaveLength(1);
    expect(added).toHaveLength(0); // the store must not see an incident
  });

  it('passes the originating window id to onReport', () => {
    const { ipcMain, send } = ipc();
    let windowId = -99;
    createElectronMainReceiver({
      ipcMain,
      store: inertStore,
      onReport: (_r, id) => {
        windowId = id;
      },
    }).start();
    send(JSON.stringify({ k: 'report', p: { source: {}, report: {} }, ts: 1 }));
    expect(windowId).toBe(3);
  });

  it('R5: a throwing store never escapes the ipcMain listener', () => {
    // The listener runs inside Electron's IPC dispatch; a throw escapes into the host app's machinery and
    // can take the channel — and with it ALL renderer capture — down.
    const { ipcMain, send } = ipc();
    const errors: unknown[] = [];
    createElectronMainReceiver({
      ipcMain,
      store: {
        add: () => {
          throw new Error('store boom');
        },
      },
      onError: (e) => errors.push(e),
    }).start();
    expect(() => send(JSON.stringify({ k: 'entry', t: 'log', p: {} }))).not.toThrow();
    expect(String(errors[0])).toContain('store boom');
  });

  it('R5: a throwing onReport callback never escapes either', () => {
    const { ipcMain, send } = ipc();
    const errors: unknown[] = [];
    createElectronMainReceiver({
      ipcMain,
      store: inertStore,
      onReport: () => {
        throw new Error('join boom');
      },
      onError: (e) => errors.push(e),
    }).start();
    expect(() =>
      send(JSON.stringify({ k: 'report', p: { source: {}, report: {} }, ts: 1 })),
    ).not.toThrow();
    expect(String(errors[0])).toContain('join boom');
  });
});
