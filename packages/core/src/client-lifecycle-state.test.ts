import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { BugseeOption } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { BlackoutToken } from './blackout';
import { getCarrier, getCarrierBlackout, setProcessLifecycleEventsListener } from './carrier';
import { type CreateClientOptions, createClient } from './client';
import type { CaptureProvider } from './contracts';
import { BugseeError } from './errors';
import { BugseeStatus } from './launch-status';
import { LifecycleEvents } from './lifecycle-events';
import { createOptionsContainer } from './options';
import type { UploadPipeline, UploadResult } from './transport';

// Lifecycle-event delivery, stop generations, the kill state,
// blackout state and `getLaunchOptions`.

const getEnvironment = (): EnvironmentEnvelope => ({
  platform: { type: 'web', version: '1' },
  runtime: { type: 'web', version: '' },
  sdk: { version: '0', type: 'javascript' },
});
const noScheduler = { setInterval: () => 'h', clearInterval: () => {} };
const types = (events: Array<[string, unknown]>): string[] => events.map(([type]) => type);
const listen = (client: { setLifecycleEventsListener(l: never): void }) => {
  const events: Array<[string, unknown]> = [];
  client.setLifecycleEventsListener(((type: string, data: unknown) =>
    events.push([type, data])) as never);
  return events;
};
const countingProvider = (): CaptureProvider & { starts: number; stops: number } => {
  const provider = {
    name: 'counting',
    starts: 0,
    stops: 0,
    init: () => {},
    start() {
      provider.starts += 1;
    },
    stop() {
      provider.stops += 1;
    },
  };
  return provider as CaptureProvider & { starts: number; stops: number };
};

describe('the lifecycle listener is process-level', () => {
  it('a listener set through a carrier survives into the NEXT client (relaunch builds a new one)', () => {
    const host = {};
    const first = createClient({ carrier: host, scheduler: noScheduler });
    const events = listen(first);
    const second = createClient({ carrier: host, scheduler: noScheduler });
    second.launch();
    expect(types(events)).toEqual([LifecycleEvents.Launching, LifecycleEvents.Launched]);
  });

  it('a listener installed BEFORE any client exists observes Launching and Launched', () => {
    const host = {};
    const seen: string[] = [];
    setProcessLifecycleEventsListener((type) => seen.push(type), host);
    createClient({ carrier: host, scheduler: noScheduler }).launch();
    expect(seen).toEqual([LifecycleEvents.Launching, LifecycleEvents.Launched]);
  });

  it('the `lifecycleEventsListener` option installs the listener before launch() can run', () => {
    const host = {};
    const seen: string[] = [];
    const client = createClient({
      carrier: host,
      scheduler: noScheduler,
      lifecycleEventsListener: (type) => seen.push(type),
    });
    client.launch();
    expect(seen).toEqual([LifecycleEvents.Launching, LifecycleEvents.Launched]);
    expect(getCarrier(host).lifecycleListener).toEqual(expect.any(Function));
  });

  it('setLifecycleEventsListener(null) clears it for the process, and a later option replaces it', () => {
    const host = {};
    const a = createClient({ carrier: host, scheduler: noScheduler });
    const seen: string[] = [];
    a.setLifecycleEventsListener((type) => seen.push(type));
    a.setLifecycleEventsListener(null);
    createClient({ carrier: host, scheduler: noScheduler }).launch();
    expect(seen).toEqual([]);
    const later: string[] = [];
    createClient({
      carrier: host,
      scheduler: noScheduler,
      lifecycleEventsListener: (type) => later.push(type),
    });
    createClient({ carrier: host, scheduler: noScheduler }).launch();
    expect(later).toEqual([LifecycleEvents.Launching, LifecycleEvents.Launched]);
  });

  it('without a carrier the listener stays private to its client', () => {
    const a = createClient({ scheduler: noScheduler });
    const events = listen(a);
    createClient({ scheduler: noScheduler }).launch();
    expect(events).toEqual([]);
  });
});

describe('events are delivered after the state is consistent, and re-entry is safe', () => {
  it('reports Launching while the Launching event is delivered, Launched on Launched', () => {
    const client = createClient({ scheduler: noScheduler });
    const states: Array<[string, BugseeStatus, boolean]> = [];
    client.setLifecycleEventsListener((type) =>
      states.push([type, client.getStatus(), client.isLaunched()]),
    );
    client.launch();
    expect(states).toEqual([
      [LifecycleEvents.Launching, BugseeStatus.Launching, true],
      [LifecycleEvents.Launched, BugseeStatus.Launched, true],
    ]);
  });

  it('reports Stopping while Stopping is delivered and Stopped on Stopped', async () => {
    const client = createClient({ scheduler: noScheduler });
    client.launch();
    const states: Array<[string, BugseeStatus, boolean]> = [];
    client.setLifecycleEventsListener((type) =>
      states.push([type, client.getStatus(), client.isLaunched()]),
    );
    await client.stop();
    expect(states).toEqual([
      [LifecycleEvents.Stopping, BugseeStatus.Stopping, false],
      [LifecycleEvents.Stopped, BugseeStatus.Stopped, false],
    ]);
  });

  it('a listener that calls launch() on Launching does not start providers or timers twice', () => {
    const setInterval = vi.fn(() => 'h');
    const client = createClient({ scheduler: { setInterval, clearInterval: () => {} } });
    const provider = countingProvider();
    client.addCaptureProvider(provider);
    const events = listen(client);
    client.setLifecycleEventsListener((type, data) => {
      events.push([type, data]);
      if (type === LifecycleEvents.Launching) client.launch();
    });
    client.launch();
    expect(provider.starts).toBe(1);
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(types(events)).toEqual([LifecycleEvents.Launching, LifecycleEvents.Launched]);
  });

  it('a listener that calls stop() on Launching aborts the launch: nothing starts, Launched never fires', async () => {
    const clearInterval = vi.fn();
    const client = createClient({ scheduler: { setInterval: () => 'h', clearInterval } });
    const provider = countingProvider();
    client.addCaptureProvider(provider);
    const seen: string[] = [];
    let stopped: Promise<boolean> | undefined;
    client.setLifecycleEventsListener((type) => {
      seen.push(type);
      if (type === LifecycleEvents.Launching) stopped = client.stop();
    });
    client.launch();
    await stopped;
    expect(provider.starts).toBe(0);
    expect(clearInterval).not.toHaveBeenCalled(); // no timer had been armed, so none is cleared
    expect(client.isLaunched()).toBe(false);
    expect(client.getStatus()).toBe(BugseeStatus.Stopped);
    expect(seen).toEqual([
      LifecycleEvents.Launching,
      LifecycleEvents.Stopping,
      LifecycleEvents.Stopped,
    ]);
  });

  it('a listener that calls stop() on Stopping does not double-stop', async () => {
    const client = createClient({ scheduler: noScheduler });
    const provider = countingProvider();
    client.addCaptureProvider(provider);
    client.launch();
    const seen: string[] = [];
    client.setLifecycleEventsListener((type) => {
      seen.push(type);
      if (type === LifecycleEvents.Stopping) void client.stop();
    });
    await client.stop();
    expect(provider.stops).toBe(1);
    expect(seen).toEqual([LifecycleEvents.Stopping, LifecycleEvents.Stopped]);
  });

  it('a listener that relaunches from Stopped gets a clean second run', async () => {
    const client = createClient({ scheduler: noScheduler });
    const provider = countingProvider();
    client.addCaptureProvider(provider);
    client.launch();
    const seen: string[] = [];
    client.setLifecycleEventsListener((type) => {
      seen.push(type);
      if (type === LifecycleEvents.Stopped) client.launch();
    });
    await client.stop();
    expect(client.getStatus()).toBe(BugseeStatus.Launched);
    expect(provider.starts).toBe(2);
    expect(seen).toEqual([
      LifecycleEvents.Stopping,
      LifecycleEvents.Stopped,
      LifecycleEvents.Launching,
      LifecycleEvents.Launched,
    ]);
  });
});

describe('a lifecycle subscriber that toggles blackout cannot leave replay on a stale state', () => {
  it('startBlackout() from BlackoutEnded: a later blackout subscriber ends up active', () => {
    const client = createClient({ scheduler: noScheduler });
    client.launch();
    const replay: boolean[] = [];
    client.getService(BlackoutToken).onChange((active) => replay.push(active));
    client.startBlackout();
    replay.length = 0;
    let restarted = false;
    client.setLifecycleEventsListener((type) => {
      if (type === LifecycleEvents.BlackoutEnded && !restarted) {
        restarted = true;
        client.startBlackout();
      }
    });
    client.endBlackout();
    expect(client.isBlackout()).toBe(true);
    expect(replay).not.toContain(false); // never told to resume
  });

  it('endBlackout() from BlackoutStarted: a later subscriber ends inactive, events stay ordered', () => {
    const client = createClient({ scheduler: noScheduler });
    client.launch();
    const replay: boolean[] = [];
    client.getService(BlackoutToken).onChange((active) => replay.push(active));
    const seen: string[] = [];
    client.setLifecycleEventsListener((type) => {
      seen.push(type);
      if (type === LifecycleEvents.BlackoutStarted) client.endBlackout();
    });
    client.startBlackout();
    expect(client.isBlackout()).toBe(false);
    expect(replay).not.toContain(true);
    expect(seen).toEqual([LifecycleEvents.BlackoutStarted, LifecycleEvents.BlackoutEnded]);
  });
});

describe('blackout is refused while the client is not launched', () => {
  it('startBlackout() before launch and after stop does nothing and emits nothing', async () => {
    const client = createClient({ scheduler: noScheduler });
    const events = listen(client);
    client.startBlackout();
    expect(client.isBlackout()).toBe(false);
    client.launch();
    await client.stop();
    events.length = 0;
    client.startBlackout();
    expect(client.isBlackout()).toBe(false);
    expect(events).toEqual([]);
  });

  it('endBlackout() while not launched is also a silent no-op', () => {
    const client = createClient({ scheduler: noScheduler });
    const events = listen(client);
    client.endBlackout();
    expect(events).toEqual([]);
  });

  it('endBlackout() after stop() ends the blackout quietly (it must be liftable, but nothing is captured to describe)', async () => {
    const client = createClient({ scheduler: noScheduler });
    client.launch();
    client.startBlackout();
    await client.stop();
    const events = listen(client);
    client.endBlackout();
    expect(client.isBlackout()).toBe(false);
    expect(events).toEqual([]);
  });

  it('works normally while launched', () => {
    const client = createClient({ scheduler: noScheduler });
    client.launch();
    const events = listen(client);
    client.startBlackout();
    client.endBlackout();
    expect(types(events)).toEqual([LifecycleEvents.BlackoutStarted, LifecycleEvents.BlackoutEnded]);
  });
});

describe('the blackout state is carried across a relaunch', () => {
  it('a new client on the same carrier starts blacked out, silently, and can end it', () => {
    const host = {};
    const first = createClient({ carrier: host, scheduler: noScheduler });
    first.launch();
    first.startBlackout();
    expect(getCarrierBlackout(host)).toBe(true);

    const second = createClient({ carrier: host, scheduler: noScheduler });
    expect(second.isBlackout()).toBe(true);
    expect(second.getService(BlackoutToken).isActive()).toBe(true);
    second.launch();
    const events = listen(second);
    second.endBlackout();
    expect(second.isBlackout()).toBe(false);
    expect(getCarrierBlackout(host)).toBe(false);
    expect(types(events)).toEqual([LifecycleEvents.BlackoutEnded]);
    expect(createClient({ carrier: host, scheduler: noScheduler }).isBlackout()).toBe(false);
  });

  it('survives stop() of the old client (the state is the process, not the client)', async () => {
    const host = {};
    const first = createClient({ carrier: host, scheduler: noScheduler });
    first.launch();
    first.startBlackout();
    await first.stop();
    expect(createClient({ carrier: host, scheduler: noScheduler }).isBlackout()).toBe(true);
  });

  it('a client without a carrier keeps its own state and touches no process state', () => {
    const client = createClient({ scheduler: noScheduler });
    client.launch();
    client.startBlackout();
    expect(client.isBlackout()).toBe(true);
    expect(getCarrierBlackout({})).toBe(false);
  });
});

describe('a stale stop() cannot disturb a newer launch', () => {
  const draining = (extra: Partial<CreateClientOptions> = {}) => {
    let release: (ok: boolean) => void = () => {};
    const gate = new Promise<boolean>((resolve) => {
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
    return { client, release: (ok = true) => release(ok) };
  };
  const tick = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  it('launch() while stop() drains ends the stop first: Stopping, Stopped, Launching, Launched', async () => {
    const { client, release } = draining();
    client.launch();
    const events = listen(client);
    const stopping = client.stop();
    expect(client.getStatus()).toBe(BugseeStatus.Stopping);
    client.launch();
    expect(client.getStatus()).toBe(BugseeStatus.Launched);
    expect(types(events)).toEqual([
      LifecycleEvents.Stopping,
      LifecycleEvents.Stopped,
      LifecycleEvents.Launching,
      LifecycleEvents.Launched,
    ]);
    release();
    await expect(stopping).resolves.toBe(true);
    await tick();
    // The stale drain neither emitted a second Stopped nor flipped the status.
    expect(types(events)).toHaveLength(4);
    expect(client.getStatus()).toBe(BugseeStatus.Launched);
    expect(client.isLaunched()).toBe(true);
  });

  it('the stale drain does not suspend the notify relay of the relaunched client', async () => {
    vi.useFakeTimers();
    try {
      // The first two attempts fail (the initial one and the drain's flush), arming the retry backoff;
      // only a relay that is still allowed to retry reaches the third.
      const sender = vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'retry' })
        .mockResolvedValueOnce({ outcome: 'retry' })
        .mockResolvedValue({ outcome: 'sent' });
      const { client, release } = draining({ notifySender: sender });
      client.launch();
      client.notify('hello');
      await vi.advanceTimersByTimeAsync(0);
      expect(sender).toHaveBeenCalledTimes(1);
      const stopping = client.stop();
      client.launch();
      release();
      await stopping;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sender).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a plain stop() suspends the notify relay: no retry timer outlives it', async () => {
    vi.useFakeTimers();
    try {
      const sender = vi.fn().mockResolvedValue({ outcome: 'retry' });
      const { client, release } = draining({ notifySender: sender });
      client.launch();
      client.notify('hello');
      await vi.advanceTimersByTimeAsync(0);
      const stopping = client.stop();
      release();
      await stopping;
      const calls = sender.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sender).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second stop() after the relaunch drains normally and emits its own Stopped', async () => {
    const { client, release } = draining();
    client.launch();
    const events = listen(client);
    const first = client.stop();
    client.launch();
    events.length = 0;
    const second = client.stop();
    release();
    await Promise.all([first, second]);
    await tick();
    expect(types(events)).toEqual([LifecycleEvents.Stopping, LifecycleEvents.Stopped]);
    expect(client.getStatus()).toBe(BugseeStatus.Stopped);
  });

  it('an uninterrupted stop() still emits Stopped once and clears Stopping', async () => {
    const { client, release } = draining();
    client.launch();
    const events = listen(client);
    const stopping = client.stop();
    release();
    await stopping;
    expect(types(events)).toEqual([LifecycleEvents.Stopping, LifecycleEvents.Stopped]);
    expect(client.getStatus()).toBe(BugseeStatus.Stopped);
  });
});

describe('the kill state announces itself with Stopping and Stopped', () => {
  it('emits both, in order, with consistent state, exactly once', async () => {
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
    const states: Array<[string, BugseeStatus]> = [];
    client.setLifecycleEventsListener((type) => states.push([type, client.getStatus()]));
    await client.logException(new Error('boom'));
    await client.logException(new Error('again'));
    expect(states).toEqual(
      expect.arrayContaining([
        [LifecycleEvents.Stopping, BugseeStatus.Stopping],
        [LifecycleEvents.Stopped, BugseeStatus.Stopped],
      ]),
    );
    const lifecycle = states.filter(([type]) =>
      [LifecycleEvents.Stopping, LifecycleEvents.Stopped].includes(type as never),
    );
    expect(lifecycle.map(([type]) => type)).toEqual([
      LifecycleEvents.Stopping,
      LifecycleEvents.Stopped,
    ]);
  });
});

describe('getLaunchOptions reports the values in effect', () => {
  const view = (effective: Record<string, unknown>, host: Record<string, unknown> = effective) => ({
    effective,
    host,
  });

  it('normalises priorities and the log level exactly as the client applies them', () => {
    const onError = vi.fn();
    const raw = {
      [BugseeOption.CaptureLogsLevel]: 'Verbose',
      [BugseeOption.ReportingDefaultCrashPriority]: 'urgent',
      [BugseeOption.ReportingDefaultErrorPriority]: 'HIGH',
      [BugseeOption.NotifyFlushDelay]: -5,
      [BugseeOption.CaptureBreadcrumbs]: true,
    };
    const client = createClient({
      launchOptions: createOptionsContainer(raw),
      launchOptionsView: view(raw),
      onError,
    });
    const expected = {
      [BugseeOption.CaptureLogsLevel]: 'verbose',
      [BugseeOption.ReportingDefaultCrashPriority]: 'blocker',
      [BugseeOption.ReportingDefaultErrorPriority]: 'high',
      [BugseeOption.NotifyFlushDelay]: 0,
      [BugseeOption.CaptureBreadcrumbs]: true,
    };
    expect(client.getLaunchOptions()).toEqual(expected);
    expect(client.getHostLaunchOptions()).toEqual(expected);
  });

  it('leaves a key alone when it was not supplied, and returns copies', () => {
    const raw = { [BugseeOption.CaptureBreadcrumbs]: false };
    const client = createClient({ launchOptionsView: view(raw) });
    const got = client.getLaunchOptions();
    expect(got).toEqual(raw);
    got.mutated = true;
    expect(client.getLaunchOptions()).toEqual(raw);
    expect(createClient().getLaunchOptions()).toEqual({});
  });

  it('keeps already-valid values untouched', () => {
    const raw = {
      [BugseeOption.CaptureLogsLevel]: 'warning',
      [BugseeOption.ReportingDefaultCrashPriority]: 'critical',
      [BugseeOption.NotifyFlushDelay]: 40.7,
    };
    const client = createClient({
      launchOptions: createOptionsContainer(raw),
      launchOptionsView: view(raw),
    });
    expect(client.getLaunchOptions()).toEqual({
      ...raw,
      [BugseeOption.NotifyFlushDelay]: 40,
    });
  });

  it('reads the default bug priority as the severity the report dialog will use', () => {
    const key = BugseeOption.ReportingDefaultBugPriority;
    const client = createClient({
      launchOptionsView: view({ [key]: 'Critical' }, { [key]: 'urgent' }),
    });
    expect(client.getLaunchOptions()[key]).toBe('critical');
    expect(client.getHostLaunchOptions()[key]).toBe('high');
  });

  it('only rewrites host keys the host actually supplied', () => {
    const client = createClient({
      launchOptions: createOptionsContainer({ [BugseeOption.CaptureLogsLevel]: 'nonsense' }),
      launchOptionsView: view(
        { [BugseeOption.CaptureLogsLevel]: 'nonsense', [BugseeOption.NotifyFlushDelay]: 0 },
        {},
      ),
      onError: () => {},
    });
    expect(client.getHostLaunchOptions()).toEqual({});
    expect(client.getLaunchOptions()).toEqual({
      [BugseeOption.CaptureLogsLevel]: 'verbose',
      [BugseeOption.NotifyFlushDelay]: 0,
    });
  });
});
