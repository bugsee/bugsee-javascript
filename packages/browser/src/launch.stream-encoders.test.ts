import 'fake-indexeddb/auto';
import type { LockManagerLike } from '@bugsee/browser-utils';
import { CaptureDataEntryBase } from '@bugsee/core';
import { strFromU8, unzipSync } from '@bugsee/util';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DeviceIdLocalStorage, resetBrowserDeviceIdCache } from './device-id';
import type { BrowserProbe } from './environment';
import { type Bugsee, type BugseeLaunchOptions, launch } from './launch';

// The streaming replay encoder reaches the report: launch hands registerReplay the shared `streamEncoders` map and the
// client reads it at assembly, so a replay entry in the window is encoded by what registerReplay put there.
const { registerReplay } = vi.hoisted(() => ({ registerReplay: vi.fn() }));
vi.mock('@bugsee/replay', () => ({ registerReplay }));

const DEVICE_ID = 'a1b2c3d4-e5f6-4789-a012-3456789abcde';
const probe: BrowserProbe = {
  userAgent: () => 'Mozilla/5.0 Chrome/119.0.0.0 Safari/537.36',
  uaDataPlatform: () => 'macOS',
  locale: () => 'en-US',
  utcOffsetMinutes: () => 0,
  screenWidth: () => 1280,
  screenHeight: () => 720,
  pixelRatio: () => 1,
  deviceMemoryBytes: () => undefined,
  cpuCount: () => undefined,
};
const freeLocks: LockManagerLike = {
  request(name, options, callback) {
    if (options.ifAvailable) return Promise.resolve(callback({ name }));
    void callback({ name });
    return new Promise<never>(() => {});
  },
};
const deviceIdLocalStorage = (): DeviceIdLocalStorage => {
  const data = new Map([['bugsee.device_id', DEVICE_ID]]);
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
};
const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const clients: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop(0)));
  resetBrowserDeviceIdCache();
  vi.clearAllMocks();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('browser launch — streaming replay encoder', () => {
  it('registers the replay stream encoder through registerReplay and uses it for the report', async () => {
    const puts: Uint8Array[] = [];
    const transport: NonNullable<BugseeLaunchOptions['transport']> = async (url, options) => {
      if (url.endsWith('/v2/sessions'))
        return { status: 200, headers: {}, body: json({ access_token: 'a' }) };
      if (url.endsWith('/v2/issues'))
        return {
          status: 200,
          headers: {},
          body: json({ endpoint: 'https://s3.test/put', issueId: 'i1', recordingId: 'r1' }),
        };
      if (url === 'https://s3.test/put') puts.push(options?.body as Uint8Array);
      return { status: 200, headers: {}, body: new Uint8Array() };
    };
    registerReplay.mockImplementation(
      (_client: unknown, _file: unknown, o: { streamEncoders?: { replay?: unknown } }) => {
        if (o.streamEncoders !== undefined) {
          o.streamEncoders.replay = {
            begin: () => ({
              write: () => [new TextEncoder().encode('S:')],
              end: () => [new TextEncoder().encode('end')],
            }),
          };
        }
        return { checkout: vi.fn() };
      },
    );
    const now = 1_000_000;
    const client = await launch('tok', {
      window: { addEventListener: () => {}, removeEventListener: () => {} } as unknown as Window,
      document: {
        visibilityState: 'visible',
        addEventListener: () => {},
        removeEventListener: () => {},
      } as unknown as Document,
      transport,
      systemProbe: probe,
      captureNetwork: false,
      captureViewHierarchy: false,
      captureInteractions: false,
      persist: false,
      clock: { wallNow: () => now, monotonicNow: () => now },
      indexedDB: new IDBFactory(),
      locks: freeLocks,
      deviceIdEnv: { localStorage: deviceIdLocalStorage(), randomUUID: () => DEVICE_ID },
    } as BugseeLaunchOptions);
    clients.push(client);
    await vi.waitFor(() => expect(registerReplay).toHaveBeenCalledTimes(1));
    client.captureAggregator.addEntry(new CaptureDataEntryBase('replay', now, { type: 4 }));
    await client.logException(new Error('x'));
    expect(puts).toHaveLength(1);
    const files = unzipSync(puts[0] as Uint8Array);
    expect(strFromU8(files['replay.bin'] as Uint8Array)).toBe('S:end');
  });
});
