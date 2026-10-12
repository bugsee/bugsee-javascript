import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCarrier,
  getCarrierBlackout,
  setCarrierClient,
  setCarrierLastLaunch,
  setCarrierStatus,
} from './carrier';
import { type CreateClientOptions, createClient } from './client';
import type { CaptureProvider } from './contracts';
import { BugseeError } from './errors';
import { BugseeStatus } from './launch-status';
import { LifecycleEvents } from './lifecycle-events';
import { createMemoryCaptureStore } from './memory-capture-store';
import { relaunchWith } from './relaunch';
import type { ReportingRequest } from './reporting';
import type { NotifyItem, NotifyResult, UploadPipeline, UploadResult } from './transport';
import type { TriggerPipeline } from './trigger-pipeline';

// Core half: stop() safety, ReportHandler.after on injected pipelines
// refusing launch() on a stopped platform client, blackout end while stopped,
// the kill-state generation and the notify backlog handover across relaunch().

const getEnvironment = (): EnvironmentEnvelope => ({
  platform: { type: 'web', version: '1' },
  runtime: { type: 'web', version: '' },
  sdk: { version: '0', type: 'javascript' },
});
const noScheduler = { setInterval: () => 'h', clearInterval: () => {} };
const tick = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};
const types = (events: Array<[string, unknown]>): string[] => events.map(([type]) => type);
const listen = (client: { setLifecycleEventsListener(l: never): void }) => {
  const events: Array<[string, unknown]> = [];
  client.setLifecycleEventsListener(((type: string, data: unknown) =>
    events.push([type, data])) as never);
  return events;
};
const countingProvider = (): CaptureProvider & { starts: number } => {
  const provider = {
    name: 'counting',
    starts: 0,
    init: () => {},
    start() {
      provider.starts += 1;
    },
    stop: () => {},
  };
  return provider as CaptureProvider & { starts: number };
};

/** A client whose upload flush is held until `release()`. */
const hung = (extra: Partial<CreateClientOptions> = {}) => {
  let release: (ok: boolean) => void = () => {};
  let gate = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const uploadPipeline: UploadPipeline = {
    enqueue: async () => ({ ok: true }),
    flush: () => gate,
    drop: vi.fn(),
  };
  const client = createClient({
    uploadPipeline,
    appToken: 'tok',
    getEnvironment,
    scheduler: noScheduler,
    ...extra,
  });
  return {
    client,
    release: (ok = true) => release(ok),
    rearm: () => {
      gate = new Promise<boolean>((resolve) => {
        release = resolve;
      });
    },
  };
};

describe('R2L-1 — a repeat stop() is the SAME drain, never "drained" while one is in flight', () => {
  it('returns a promise that settles only when the first stop() drain does', async () => {
    const { client, release } = hung();
    client.launch();
    const first = client.stop();
    let secondSettled = false;
    const second = client.stop().then((drained) => {
      secondSettled = true;
      return drained;
    });
    await tick();
    expect(secondSettled).toBe(false);
    expect(client.getStatus()).toBe(BugseeStatus.Stopping);
    release(true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(client.getStatus()).toBe(BugseeStatus.Stopped);
  });

  it('after a TIMED-OUT stop(), a repeat stop() waits for the real drain (bounded by its own timeout)', async () => {
    const { client, release } = hung();
    client.launch();
    await expect(client.stop(5)).resolves.toBe(false);
    // The upload is still running: a second stop() must not claim it drained.
    await expect(client.stop(5)).resolves.toBe(false);
    release(true);
    await tick();
    await expect(client.stop(5)).resolves.toBe(true);
  });

  it('a repeat stop() after a drain that FAILED keeps reporting false', async () => {
    const { client, release } = hung();
    client.launch();
    const first = client.stop();
    release(false);
    await expect(first).resolves.toBe(false);
    await expect(client.stop()).resolves.toBe(false);
  });

  it('a launch() forgets the previous drain: the next stop() reports its own', async () => {
    const { client, release, rearm } = hung();
    client.launch();
    const first = client.stop();
    release(false);
    await expect(first).resolves.toBe(false);
    rearm();
    client.launch();
    const next = client.stop();
    release(true);
    await expect(next).resolves.toBe(true);
  });

  it('a drain remembered from an earlier life does not answer for a LATER kill', async () => {
    const fatal = new BugseeError('off', 0, { fatal: true, serverCode: 99_099 });
    const client = createClient({
      uploadPipeline: {
        enqueue: async (): Promise<UploadResult> => ({ ok: false, error: fatal }),
        flush: async () => false, // the first life's drain FAILED
        drop: vi.fn(),
      },
      appToken: 'tok',
      getEnvironment,
      scheduler: noScheduler,
    });
    client.launch();
    await expect(client.stop()).resolves.toBe(false);
    client.launch();
    await client.logException(new Error('boom')); // killed in the second life
    expect(client.isLaunched()).toBe(false);
    await expect(client.stop()).resolves.toBe(true);
  });

  it('a stop() on a client that never launched is still an immediate true', async () => {
    const { client } = hung();
    await expect(client.stop()).resolves.toBe(true);
  });

  it('a repeat stop() after a kill is an immediate true (nothing was in flight)', async () => {
    const fatal = new BugseeError('off', 0, { fatal: true, serverCode: 99_099 });
    const uploadPipeline: UploadPipeline = {
      enqueue: async (): Promise<UploadResult> => ({ ok: false, error: fatal }),
      flush: async () => true,
      drop: vi.fn(),
    };
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      scheduler: noScheduler,
    });
    client.launch();
    await client.logException(new Error('boom'));
    expect(client.isLaunched()).toBe(false);
    await expect(client.stop()).resolves.toBe(true);
  });
});

describe('R2L-2 — ReportHandler.after also runs when a triggerPipeline is injected', () => {
  const injected = () => {
    const reported: ReportingRequest[] = [];
    const calls: string[] = [];
    const triggerPipeline: TriggerPipeline = {
      report: async (request) => {
        calls.push('report');
        reported.push(request);
        return { ok: true };
      },
    };
    const client = createClient({ triggerPipeline, scheduler: noScheduler });
    client.launch();
    return { client, reported, calls };
  };

  it('calls `after` synchronously BEFORE the injected pipeline sees the request, which then carries its edits', async () => {
    const { client, reported, calls } = injected();
    client.setReportHandler({
      after: (request) => {
        calls.push('after');
        request.report.labels = ['from-after'];
      },
    });
    await client.logException(new Error('boom'));
    expect(calls).toEqual(['after', 'report']);
    expect(reported[0]?.report.labels).toEqual(['from-after']);
  });

  it('is not called for a vetoed report', async () => {
    const { client, calls } = injected();
    client.setReportHandler({ before: () => null, after: () => calls.push('after') });
    await client.logException(new Error('boom'));
    expect(calls).toEqual([]);
  });

  it('a throwing `after` is routed to onError and the report is still delivered', async () => {
    const onError = vi.fn();
    const calls: string[] = [];
    const client = createClient({
      triggerPipeline: {
        report: async () => {
          calls.push('report');
          return { ok: true };
        },
      },
      scheduler: noScheduler,
      onError,
    });
    client.launch();
    const boom = new Error('after');
    client.setReportHandler({
      after: () => {
        throw boom;
      },
    });
    await client.logException(new Error('boom'));
    expect(onError).toHaveBeenCalledWith(boom);
    expect(calls).toEqual(['report']);
  });

  it('a throwing user onError does not lose the report either', async () => {
    const calls: string[] = [];
    const client = createClient({
      triggerPipeline: {
        report: async () => {
          calls.push('report');
          return { ok: true };
        },
      },
      scheduler: noScheduler,
      onError: () => {
        throw new Error('sink');
      },
    });
    client.launch();
    client.setReportHandler({
      after: () => {
        throw new Error('after');
      },
    });
    await client.logException(new Error('boom'));
    expect(calls).toEqual(['report']);
  });

  it('is called exactly once on the BUILT pipeline path (no double call)', async () => {
    const after = vi.fn();
    const uploadPipeline: UploadPipeline = {
      enqueue: async () => ({ ok: true }),
      flush: async () => true,
      drop: vi.fn(),
    };
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      scheduler: noScheduler,
    });
    client.launch();
    client.setReportHandler({ after });
    await client.logException(new Error('boom'));
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe('R2L-3 — `restartable: false` refuses launch() on a stopped client', () => {
  it('reports through onError, starts nothing and keeps the status Stopped', async () => {
    const onError = vi.fn();
    const client = createClient({ scheduler: noScheduler, restartable: false, onError });
    const provider = countingProvider();
    client.addCaptureProvider(provider);
    client.launch();
    await client.stop();
    const events = listen(client);
    client.launch();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String((onError.mock.calls[0]?.[0] as Error).message)).toMatch(/stopped/i);
    expect(provider.starts).toBe(1);
    expect(client.isLaunched()).toBe(false);
    expect(client.getStatus()).toBe(BugseeStatus.Stopped);
    expect(events).toEqual([]);
  });

  it('refuses a launch() while the stop is still draining, too', async () => {
    const onError = vi.fn();
    const { client, release } = hung({ restartable: false, onError });
    client.launch();
    const stopping = client.stop();
    client.launch();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(client.getStatus()).toBe(BugseeStatus.Stopping);
    release(true);
    await stopping;
    expect(client.getStatus()).toBe(BugseeStatus.Stopped);
  });

  it('still allows the FIRST launch and ignores a repeat launch() while launched without an error', () => {
    const onError = vi.fn();
    const client = createClient({ scheduler: noScheduler, restartable: false, onError });
    client.launch();
    client.launch();
    expect(client.isLaunched()).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a killed client stays silently dead (no error: the collector switched it off)', async () => {
    const fatal = new BugseeError('off', 0, { fatal: true, serverCode: 99_099 });
    const onError = vi.fn();
    const client = createClient({
      uploadPipeline: {
        enqueue: async (): Promise<UploadResult> => ({ ok: false, error: fatal }),
        flush: async () => true,
        drop: vi.fn(),
      },
      appToken: 'tok',
      getEnvironment,
      scheduler: noScheduler,
      restartable: false,
      onError,
    });
    client.launch();
    await client.logException(new Error('boom'));
    onError.mockClear();
    client.launch();
    expect(onError).not.toHaveBeenCalled();
    expect(client.isLaunched()).toBe(false);
  });

  it('the default (restartable) client still restarts', async () => {
    const client = createClient({ scheduler: noScheduler });
    client.launch();
    await client.stop();
    client.launch();
    expect(client.isLaunched()).toBe(true);
  });
});

describe('R2L-7 — a blackout can be ENDED while stopped (silently), never started', () => {
  it('clears the carried process flag and the client state without events, so the next launch is not dark', async () => {
    const host = {};
    const client = createClient({ carrier: host, scheduler: noScheduler });
    client.launch();
    client.startBlackout();
    await client.stop();
    expect(getCarrierBlackout(host)).toBe(true);
    const events = listen(client);
    client.endBlackout();
    expect(events).toEqual([]);
    expect(client.isBlackout()).toBe(false);
    expect(getCarrierBlackout(host)).toBe(false);
    // …and a new client on the same carrier starts lit
    const next = createClient({ carrier: host, scheduler: noScheduler });
    expect(next.isBlackout()).toBe(false);
  });

  it('startBlackout() while stopped is still refused (fail closed on start)', async () => {
    const host = {};
    const client = createClient({ carrier: host, scheduler: noScheduler });
    client.launch();
    await client.stop();
    client.startBlackout();
    expect(client.isBlackout()).toBe(false);
    expect(getCarrierBlackout(host)).toBe(false);
  });

  it('endBlackout() while launched still emits BlackoutEnded', () => {
    const client = createClient({ scheduler: noScheduler });
    client.launch();
    client.startBlackout();
    const events = listen(client);
    client.endBlackout();
    expect(types(events)).toEqual([LifecycleEvents.BlackoutEnded]);
  });
});

describe('R2L-13 — the kill state is a transition like stop(): a stale drain stays stale', () => {
  it('a drain from before a relaunch and a kill emits no extra Stopped', async () => {
    const fatal = new BugseeError('off', 0, { fatal: true, serverCode: 99_099 });
    let release: (ok: boolean) => void = () => {};
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const client = createClient({
      uploadPipeline: {
        enqueue: async (): Promise<UploadResult> => ({ ok: false, error: fatal }),
        flush: () => gate,
        drop: vi.fn(),
      },
      appToken: 'tok',
      getEnvironment,
      scheduler: noScheduler,
    });
    client.launch();
    const staleStop = client.stop();
    client.launch();
    const events = listen(client);
    await client.logException(new Error('boom')); // the collector kills the SDK
    const stops = (): string[] =>
      types(events).filter(
        (type) => type === LifecycleEvents.Stopping || type === LifecycleEvents.Stopped,
      );
    expect(stops()).toEqual([LifecycleEvents.Stopping, LifecycleEvents.Stopped]);
    release(true);
    await staleStop;
    await tick();
    expect(stops()).toEqual([LifecycleEvents.Stopping, LifecycleEvents.Stopped]);
    expect(client.getStatus()).toBe(BugseeStatus.Stopped);
  });
});

describe('R2L-6 — notifications still queued at relaunch() are handed to the new client', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  type Sender = (items: readonly NotifyItem[]) => Promise<NotifyResult>;
  const build = (host: object, sender: Sender) => {
    const client = createClient({
      carrier: host,
      captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
      scheduler: noScheduler,
      notifySender: sender,
      getEnvironment,
      appToken: 'tok',
    });
    client.launch();
    setCarrierClient(client, host);
    setCarrierLastLaunch('tok', {}, host);
    setCarrierStatus(BugseeStatus.Launched, host);
    return client;
  };

  it('delivers a message the OLD client could not send (offline) through the NEW client', async () => {
    const host = {};
    const offline: Sender = async () => ({ outcome: 'retry' });
    const old = build(host, offline);
    old.notify('while offline');
    await vi.advanceTimersByTimeAsync(0);
    expect(old.getStatus()).toBe(BugseeStatus.Launched);

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
    await vi.advanceTimersByTimeAsync(10);
    expect(received.flat().map((item) => item.title)).toEqual(['while offline']);
    expect(getCarrier(host).notifyBacklog).toBeUndefined();
  });

  it('a plain stop() (no relaunch) keeps nothing on the carrier', async () => {
    const host = {};
    const old = build(host, async () => ({ outcome: 'retry' }));
    old.notify('while offline');
    await vi.advanceTimersByTimeAsync(0);
    const stopped = old.stop(10);
    await vi.advanceTimersByTimeAsync(20);
    await stopped;
    expect(getCarrier(host).notifyBacklog).toBeUndefined();
  });

  it('a client without a carrier is unaffected', async () => {
    const client = createClient({
      scheduler: noScheduler,
      notifySender: async () => ({ outcome: 'retry' }),
      getEnvironment,
      appToken: 'tok',
    });
    client.launch();
    client.notify('x');
    const stopped = client.stop(10);
    await vi.advanceTimersByTimeAsync(20);
    await expect(stopped).resolves.toBe(false);
  });
});
