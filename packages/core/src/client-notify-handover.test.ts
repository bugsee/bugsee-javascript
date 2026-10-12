import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCarrier,
  setCarrierClient,
  setCarrierLastLaunch,
  setCarrierRelaunching,
  setCarrierStatus,
} from './carrier';
import { createClient } from './client';
import { BugseeStatus } from './launch-status';
import { createMemoryCaptureStore } from './memory-capture-store';
import { relaunchWith } from './relaunch';
import type { NotifyItem, NotifyResult, UploadPipeline } from './transport';

// Review round 3 (H1): R3L-5 / R3P-4. The notify hand-over of relaunch(): a batch in flight at take() that later
// fails, a late old-stop `.finally`, and the relaunch failure path.

const getEnvironment = (): EnvironmentEnvelope => ({
  platform: { type: 'web', version: '1' },
  runtime: { type: 'web', version: '' },
  sdk: { version: '0', type: 'javascript' },
});
const noScheduler = { setInterval: () => 'h', clearInterval: () => {} };

type Sender = (items: readonly NotifyItem[]) => Promise<NotifyResult>;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const build = (
  host: object,
  sender: Sender,
  uploadPipeline?: UploadPipeline,
  onError?: (error: unknown) => void,
) => {
  const client = createClient({
    carrier: host,
    captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
    scheduler: noScheduler,
    notifySender: sender,
    getEnvironment,
    appToken: 'tok',
    ...(uploadPipeline !== undefined ? { uploadPipeline } : {}),
    ...(onError !== undefined ? { onError } : {}),
  });
  client.launch();
  setCarrierClient(client, host);
  setCarrierLastLaunch('tok', {}, host);
  setCarrierStatus(BugseeStatus.Launched, host);
  return client;
};
const titles = (batches: NotifyItem[][]): string[] => batches.flat().map((item) => item.title);

describe('R3L-5 — a batch in flight when relaunch() took the queue and then fails', () => {
  it('reaches the NEW client (the adopter), not the dead relay', async () => {
    const host = {};
    let failOld: () => void = () => {};
    const oldSender: Sender = () =>
      new Promise<NotifyResult>((resolve) => {
        failOld = () => resolve({ outcome: 'retry' });
      });
    const old = build(host, oldSender);
    old.notify('in flight');
    await vi.advanceTimersByTimeAsync(0); // the request is out

    const received: NotifyItem[][] = [];
    const online: Sender = async (items) => {
      received.push(items.map((item) => ({ ...item })));
      return { outcome: 'sent' };
    };
    const relaunching = relaunchWith(async () => build(host, online), undefined, host, {
      stopTimeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(100);
    await relaunching;
    expect(received).toEqual([]);
    failOld(); // the old request finally fails, after the new client is up
    await vi.advanceTimersByTimeAsync(10);
    expect(titles(received)).toEqual(['in flight']);
    expect(getCarrier(host).notifyBacklog).toBeUndefined();
  });

  it('with no new client yet it is parked on the carrier backlog for the next launch', async () => {
    const host = {};
    let failOld: () => void = () => {};
    const old = build(
      host,
      () =>
        new Promise<NotifyResult>((resolve) => {
          failOld = () => resolve({ outcome: 'retry' });
        }),
    );
    old.notify('in flight');
    await vi.advanceTimersByTimeAsync(0);
    setCarrierRelaunching(true, host);
    const stopped = old.stop(20);
    setCarrierRelaunching(false, host);
    await vi.advanceTimersByTimeAsync(30);
    await stopped;
    failOld();
    await vi.advanceTimersByTimeAsync(0);
    expect(getCarrier(host).notifyBacklog?.map((item) => item.title)).toEqual(['in flight']);

    const received: NotifyItem[][] = [];
    build(host, async (items) => {
      received.push(items.map((item) => ({ ...item })));
      return { outcome: 'sent' };
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(titles(received)).toEqual(['in flight']);
    expect(getCarrier(host).notifyBacklog).toBeUndefined();
  });

  it('a late old-stop finally goes to the client that already adopted, and parks nothing', async () => {
    const host = {};
    const hungUpload: UploadPipeline = {
      enqueue: async () => ({ ok: true }),
      flush: () => new Promise<boolean>(() => {}), // the old stop's drain never settles in time
      drop: vi.fn(),
    };
    const old = build(host, async () => ({ outcome: 'retry' }), hungUpload);
    old.notify('queued offline');
    await vi.advanceTimersByTimeAsync(0);
    setCarrierRelaunching(true, host);
    const stopped = old.stop(200); // relaunch's own stop: decided now, settles LATE
    setCarrierRelaunching(false, host);

    const received: NotifyItem[][] = [];
    build(host, async (items) => {
      received.push(items.map((item) => ({ ...item })));
      return { outcome: 'sent' };
    }); // the new client is up and has adopted (nothing yet)
    await vi.advanceTimersByTimeAsync(300);
    await stopped;
    await vi.advanceTimersByTimeAsync(10);
    expect(titles(received)).toEqual(['queued offline']);
    expect(getCarrier(host).notifyBacklog).toBeUndefined();
  });

  it('a stop() issued OUTSIDE relaunch keeps nothing, even if a relaunch is running when it settles', async () => {
    const host = {};
    const hungUpload: UploadPipeline = {
      enqueue: async () => ({ ok: true }),
      flush: () => new Promise<boolean>(() => {}),
      drop: vi.fn(),
    };
    const old = build(host, async () => ({ outcome: 'retry' }), hungUpload);
    old.notify('queued offline');
    await vi.advanceTimersByTimeAsync(0);
    const stopped = old.stop(100); // a plain stop
    setCarrierRelaunching(true, host); // a relaunch begins while it drains
    await vi.advanceTimersByTimeAsync(150);
    await stopped;
    setCarrierRelaunching(false, host);
    expect(getCarrier(host).notifyBacklog).toBeUndefined();
  });
});

describe('R3L-5 — relaunch failure', () => {
  it('clears the carrier backlog when the new launch throws, so nothing waits for a later unrelated launch', async () => {
    const host = {};
    const old = build(host, async () => ({ outcome: 'retry' }));
    old.notify('queued offline');
    await vi.advanceTimersByTimeAsync(0);
    const relaunching = relaunchWith(
      async () => {
        throw new Error('launch failed');
      },
      undefined,
      host,
      { stopTimeoutMs: 20 },
    );
    const settled = relaunching.then(
      () => 'ok',
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(await settled).toBe('launch failed');
    expect(getCarrier(host).notifyBacklog).toBeUndefined();
  });
});

describe('R4L-2 — a hand-back that belongs to a FAILED relaunch attempt is dropped, not parked', () => {
  it('in flight -> relaunch fails -> the request fails: the backlog stays empty and onError says what was dropped', async () => {
    const host = {};
    let failOld: () => void = () => {};
    const errors: unknown[] = [];
    const old = build(
      host,
      () =>
        new Promise<NotifyResult>((resolve) => {
          failOld = () => resolve({ outcome: 'retry' });
        }),
      undefined,
      (error) => errors.push(error),
    );
    old.notify('secret title');
    await vi.advanceTimersByTimeAsync(0); // the request is out
    const relaunching = relaunchWith(
      async () => {
        throw new Error('launch failed');
      },
      undefined,
      host,
      { stopTimeoutMs: 20 },
    );
    const settled = relaunching.then(
      () => 'ok',
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(await settled).toBe('launch failed');
    failOld(); // the old request fails AFTER the attempt failed: nobody will adopt it
    await vi.advanceTimersByTimeAsync(10);
    expect(getCarrier(host).notifyBacklog).toBeUndefined();
    expect(errors.some((e) => /dropped 1 notification/.test(String((e as Error).message)))).toBe(
      true,
    );
  });

  it('a queued item stashed by the late old stop after the attempt failed is dropped too', async () => {
    const host = {};
    const errors: unknown[] = [];
    const hungUpload: UploadPipeline = {
      enqueue: async () => ({ ok: true }),
      flush: () => new Promise<boolean>(() => {}),
      drop: vi.fn(),
    };
    const old = build(
      host,
      async () => ({ outcome: 'retry' }),
      hungUpload,
      (e) => errors.push(e),
    );
    old.notify('queued offline');
    await vi.advanceTimersByTimeAsync(0);
    const relaunching = relaunchWith(
      async () => {
        throw new Error('launch failed');
      },
      undefined,
      host,
      { stopTimeoutMs: 20 },
    );
    const settled = relaunching.then(
      () => 'ok',
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(await settled).toBe('launch failed');
    expect(getCarrier(host).notifyBacklog).toBeUndefined();
  });
});
