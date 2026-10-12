import 'fake-indexeddb/auto';
import {
  BugseeStatus,
  getCarrierClient,
  getProcessStatus,
  type HttpResponse,
  type HttpTransport,
} from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Bugsee, type BugseeWorkerLaunchOptions, launch } from './launch';
import { relaunch } from './relaunch';

// `relaunch` is built on core's `relaunchWith` over THIS package's launch (review R2D-4), so a worker that
// imports `@bugsee/webworker` directly can restart without reaching into another entry.
const okTransport = (): HttpTransport =>
  vi.fn(
    async (): Promise<HttpResponse> => ({
      status: 200,
      headers: {},
      body: new TextEncoder().encode(JSON.stringify({ access_token: 'a' })),
    }),
  );
const opts = (carrier: object): BugseeWorkerLaunchOptions => ({
  transport: okTransport(),
  carrier,
  detectCrashes: false,
});

const live: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map((c) => c.stop(0)));
});

describe('webworker relaunch', () => {
  it('rejects while nothing has been launched (there is no token to reuse)', async () => {
    await expect(relaunch(opts({}))).rejects.toThrow(/before launch/);
  });

  it('stops the running client and starts a new one through the webworker launch', async () => {
    const carrier = {};
    const first = launch('tok', opts(carrier));
    live.push(first);
    const second = await relaunch(opts(carrier));
    live.push(second);
    expect(second).not.toBe(first);
    expect(first.getStatus()).toBe(BugseeStatus.Stopped);
    expect(second.getStatus()).toBe(BugseeStatus.Launched);
    expect(getCarrierClient(carrier)).toBe(second);
    expect(getProcessStatus(carrier)).toBe(BugseeStatus.Launched);
  });
});
