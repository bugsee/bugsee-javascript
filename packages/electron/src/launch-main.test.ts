import { CaptureStoreToken } from '@bugsee/core';
import type { Bugsee, BugseeLaunchOptions } from '@bugsee/node';
import { describe, expect, it, vi } from 'vitest';
import { launchMain } from './launch-main';
import type { IpcMainEventLike, IpcMainListener } from './main-receiver';
import { BUGSEE_STREAM_CHANNEL } from './preload-bridge';
import { encodeStreamEntry } from './protocol';

function fakeIpcMain() {
  const listeners = new Map<string, IpcMainListener>();
  return {
    ipcMain: {
      on: vi.fn((c: string, l: IpcMainListener) => listeners.set(c, l)),
      removeListener: vi.fn((c: string) => listeners.delete(c)),
    },
    emit: (c: string, e: IpcMainEventLike, raw: unknown) => listeners.get(c)?.(e, raw),
    has: (c: string) => listeners.has(c),
  };
}

/** A fake node launch: a client that resolves a recording store from getService + a stop spy. */
function fakeLaunch(options: { internals?: boolean } = {}) {
  const added: unknown[] = [];
  const stop = vi.fn(() => Promise.resolve(true));
  const store = { add: (e: unknown) => added.push(e) };
  const client = {
    getService: vi.fn((token: unknown) => (token === CaptureStoreToken ? store : undefined)),
    stop,
  } as unknown as Bugsee;
  const internals =
    options.internals === false
      ? undefined
      : { baseUrl: 'https://api.test', api: { sessionId: 'sess-xyz' } };
  let received: { appToken: string; options: BugseeLaunchOptions } | undefined;
  const launch = vi.fn((appToken: string, launchOptions: BugseeLaunchOptions) => {
    received = { appToken, options: launchOptions };
    return { client, internals };
  });
  return {
    launch: launch as never,
    client,
    stop,
    added,
    get received() {
      return received;
    },
  };
}

describe('launchMain', () => {
  it('runs node launch (options minus ipcMain/launch) and starts the receiver on the stream channel', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    const client = launchMain('tok', {
      ipcMain: ipc.ipcMain,
      launch: f.launch,
      appVersion: '1.2.3',
    });

    expect(client).toBe(f.client);
    expect(f.received?.appToken).toBe('tok');
    expect(f.received?.options.appVersion).toBe('1.2.3');
    expect('ipcMain' in (f.received?.options ?? {})).toBe(false);
    expect('launch' in (f.received?.options ?? {})).toBe(false);
    expect(ipc.has(BUGSEE_STREAM_CHANNEL)).toBe(true);
  });

  it("merges a renderer's streamed entry into the main store (resolved via getService)", () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch });

    const wire = encodeStreamEntry({
      type: 'log' as never,
      seq: 1,
      timestamp: 9,
      mono: 0,
      timeOrigin: 0,
      redacted: false,
      payload: '{"m":1}',
    });
    ipc.emit(BUGSEE_STREAM_CHANNEL, {}, wire);

    expect(f.added).toEqual([{ type: 'log', timestamp: 9, serialized: '{"m":1}' }]);
  });

  it('stopping the client removes the IPC listener AND calls node stop', async () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    const client = launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch });

    await client.stop();

    expect(ipc.has(BUGSEE_STREAM_CHANNEL)).toBe(false); // receiver stopped
    expect(f.stop).toHaveBeenCalledTimes(1); // original node stop still runs
  });

  it('starts Electron crashReporter (session-correlated, derived URL) when one is provided', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    const crashReporter = { start: vi.fn() };
    launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch, crashReporter });
    expect(crashReporter.start).toHaveBeenCalledTimes(1);
    expect(crashReporter.start.mock.calls[0]?.[0]).toMatchObject({
      submitURL: 'https://api.test/v2/apps/tok/minidumps', // derived from internals.baseUrl
      uploadToServer: true,
      extra: { session_id: 'sess-xyz', app_token: 'tok' },
    });
  });

  it('honours a minidumpUrl override', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    const crashReporter = { start: vi.fn() };
    launchMain('tok', {
      ipcMain: ipc.ipcMain,
      launch: f.launch,
      crashReporter,
      minidumpUrl: 'https://dumps.custom/put',
    });
    expect(crashReporter.start.mock.calls[0]?.[0]).toMatchObject({
      submitURL: 'https://dumps.custom/put',
    });
  });

  it('does NOT start a crashReporter when none is provided', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch();
    launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch });
    // (nothing to assert beyond no throw; covered by the absence of a crashReporter)
    expect(f.received?.appToken).toBe('tok');
  });

  it('skips the crashReporter on a repeat launch (internals undefined — installed once)', () => {
    const ipc = fakeIpcMain();
    const f = fakeLaunch({ internals: false });
    const crashReporter = { start: vi.fn() };
    launchMain('tok', { ipcMain: ipc.ipcMain, launch: f.launch, crashReporter });
    expect(crashReporter.start).not.toHaveBeenCalled();
  });
});
