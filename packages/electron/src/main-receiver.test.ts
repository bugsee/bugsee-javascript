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
