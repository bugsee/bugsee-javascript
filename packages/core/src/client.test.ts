import type { EnvironmentEnvelope, FileType, NetworkEvent } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { CaptureDataEntryBase } from './capture-data-entry';
import { createCaptureExporter } from './capture-exporter';
import { createClient, type Scheduler } from './client';
import type { Clock } from './clock';
import type {
  CaptureProvider,
  CaptureSnapshot,
  CaptureStore,
  DetectionProvider,
} from './contracts';
import { createMemoryCaptureStore } from './memory-capture-store';
import { createOptionsContainer } from './options';
import { createReportingRequest, type ReportingRequest } from './reporting';
import type { Bundle, UploadPipeline, UploadResult } from './transport';
import type { TriggerPipeline } from './trigger-pipeline';

const getEnvironment = (): EnvironmentEnvelope => ({
  platform: { type: 'web', version: '1' },
  sdk: { version: '0', type: 'javascript' },
});

// Fixed-time clock so capture-entry timestamps are deterministic.
const fixedClock = (wall = 1000): Clock => ({ wallNow: () => wall, monotonicNow: () => 0 });
// The aggregator is write-only; read captured entries back via an exporter over the client's store.
const firstEntry = async (store: CaptureStore, type: FileType) =>
  (await createCaptureExporter(store).drain()).get(type)?.[0];

// Test-only extension typing so registerExt/ext can be exercised.
declare module '@bugsee/types' {
  interface NameExtensionMapping {
    demo: { ping(): string };
  }
}

const captureProvider = (name: string): CaptureProvider => ({
  name,
  init: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
});
const detectionProvider = (name: string): DetectionProvider => ({
  name,
  start: vi.fn(),
  stop: vi.fn(),
});

describe('createClient — wiring', () => {
  it('exposes a working network hub', () => {
    const client = createClient();
    const seen: NetworkEvent[] = [];
    client.hubs.network.subscribe((e) => seen.push(e));
    const event: NetworkEvent = {
      timestamp: 1,
      id: 'a',
      sequence: 'a',
      mechanism: 'fetch',
      url: 'u',
      method: 'GET',
      type: 'complete',
    };
    client.hubs.network.emit(event);
    expect(seen).toEqual([event]);
  });

  it('exposes a working operation dispatcher', () => {
    const client = createClient();
    const seen: string[] = [];
    client.operations.registerObserver((o) => seen.push(o.type));
    client.operations.onOperation({ type: 'http', timestamp: 1 });
    expect(seen).toEqual(['http']);
  });

  it('exposes a working capture aggregator', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store });
    client.captureAggregator.addEntry(new CaptureDataEntryBase('log', 1, { msg: 'hi' }));
    expect((await createCaptureExporter(store).drain()).get('log')).toHaveLength(1);
  });
});

describe('createClient — registration seams', () => {
  it('registers a capture provider (delegates to the coordinator; duplicate name throws)', () => {
    const client = createClient();
    client.addCaptureProvider(captureProvider('network'));
    expect(() => client.addCaptureProvider(captureProvider('network'))).toThrow(
      /already registered/,
    );
  });

  it('registers a detection provider (duplicate name throws)', () => {
    const client = createClient();
    client.addDetectionProvider(detectionProvider('crash'));
    expect(() => client.addDetectionProvider(detectionProvider('crash'))).toThrow(
      /already registered/,
    );
  });

  it('registers and retrieves an extension API', () => {
    const client = createClient();
    const api = { ping: () => 'pong' };
    client.registerExt('demo', api);
    expect(client.ext('demo')).toBe(api);
    expect(client.ext('demo').ping()).toBe('pong');
  });
});

describe('createClient — identity & attributes', () => {
  it('round-trips and clears the user identifier', () => {
    const client = createClient();
    expect(client.getUserIdentifier()).toBeNull();
    client.setUserIdentifier('user-1');
    expect(client.getUserIdentifier()).toBe('user-1');
    client.clearUserIdentifier();
    expect(client.getUserIdentifier()).toBeNull();
  });

  it('round-trips, reads, and clears attributes', () => {
    const client = createClient();
    expect(client.getAttribute('k')).toBeUndefined();
    client.setAttribute('k', 1);
    client.setAttribute('j', 'x');
    expect(client.getAttribute('k')).toBe(1);
    expect(client.getAllAttributes()).toEqual({ k: 1, j: 'x' });
    client.clearAttribute('k');
    expect(client.getAttribute('k')).toBeUndefined();
    client.clearAllAttributes();
    expect(client.getAllAttributes()).toEqual({});
  });

  it('uses a separate environment per client instance', () => {
    const a = createClient();
    const b = createClient();
    a.setUserIdentifier('only-a');
    expect(b.getUserIdentifier()).toBeNull();
  });
});

describe('createClient — capture entry points', () => {
  it('addBreadcrumb pushes a breadcrumbs entry stamped from the clock', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store, clock: fixedClock(1000) });
    client.addBreadcrumb({ message: 'clicked', category: 'ui' });
    const entry = await firstEntry(store, 'breadcrumbs');
    expect(entry?.timestamp).toBe(1000);
    expect(entry?.data).toEqual({ message: 'clicked', category: 'ui', timestamp: 1000 });
  });

  it('addBreadcrumb honors an explicit timestamp', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store, clock: fixedClock(1000) });
    client.addBreadcrumb({ message: 'x', timestamp: 42 });
    const entry = await firstEntry(store, 'breadcrumbs');
    expect(entry?.timestamp).toBe(42);
    expect((entry?.data as { timestamp: number }).timestamp).toBe(42);
  });

  it('log pushes a log entry with default level info and clock timestamp', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store, clock: fixedClock(1000) });
    client.log('hello');
    expect((await firstEntry(store, 'log'))?.data).toEqual({
      timestamp: 1000,
      level: 'info',
      source: 'logger',
      message: 'hello',
    });
  });

  it('log honors an explicit level and timestamp', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store, clock: fixedClock(1000) });
    client.log('boom', 'error', 7);
    expect((await firstEntry(store, 'log'))?.data).toEqual({
      timestamp: 7,
      level: 'error',
      source: 'logger',
      message: 'boom',
    });
  });

  it('event pushes an events.user entry with params', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store, clock: fixedClock(1000) });
    client.event('checkout', { total: 9 });
    expect((await firstEntry(store, 'events.user'))?.data).toEqual({
      timestamp: 1000,
      name: 'checkout',
      params: { total: 9 },
    });
  });

  it('event omits params when not provided', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store, clock: fixedClock(1000) });
    client.event('opened');
    expect((await firstEntry(store, 'events.user'))?.data).toEqual({
      timestamp: 1000,
      name: 'opened',
    });
  });

  it('trace pushes a traces.user entry with name and value', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store, clock: fixedClock(1000) });
    client.trace('fps', 60);
    expect((await firstEntry(store, 'traces.user'))?.data).toEqual({
      timestamp: 1000,
      name: 'fps',
      value: 60,
    });
  });

  it('routes each entry to its own file type', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store, clock: fixedClock(1000) });
    client.addBreadcrumb({ message: 'b' });
    client.log('l');
    client.event('e');
    client.trace('t', 1);
    const snap = await createCaptureExporter(store).drain();
    expect([...snap.keys()].sort()).toEqual(['breadcrumbs', 'events.user', 'log', 'traces.user']);
  });
});

const gatedCaptureProvider = (name: string, controllingOption?: string): CaptureProvider => ({
  name,
  ...(controllingOption !== undefined ? { controllingOption } : {}),
  init: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
});

function capturingDetector(name: string) {
  let captured: ((request: ReportingRequest) => void) | undefined;
  const provider: DetectionProvider = {
    name,
    start: vi.fn((_client, report: (request: ReportingRequest) => void) => {
      captured = report;
    }),
    stop: vi.fn(),
  };
  return { provider, fire: (request: ReportingRequest) => captured?.(request) };
}

function fakeUpload() {
  const flush = vi.fn(async () => true);
  const enqueue = vi.fn<UploadPipeline['enqueue']>(async () => ({ ok: true }));
  const uploadPipeline: UploadPipeline = { enqueue, flush, drop: vi.fn() };
  return { uploadPipeline, flush, enqueue };
}

describe('createClient — lifecycle', () => {
  it('is not launched initially', () => {
    expect(createClient().isLaunched()).toBe(false);
  });

  it('launch starts capture providers and marks the client launched', () => {
    const client = createClient();
    const provider = gatedCaptureProvider('net');
    client.addCaptureProvider(provider);
    client.launch();
    expect(client.isLaunched()).toBe(true);
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('inits a registered capture provider with the capture pipeline (hubs/operations/aggregator)', () => {
    const client = createClient();
    const provider = gatedCaptureProvider('net');
    client.addCaptureProvider(provider);
    expect(provider.init).toHaveBeenCalledTimes(1);
    const init = vi.mocked(provider.init).mock.calls[0]?.[0];
    expect(init?.hubs).toBe(client.hubs);
    expect(init?.operations).toBe(client.operations);
    expect(init?.captureAggregator).toBe(client.captureAggregator);
  });

  it('passes the configured launchOptions to each capture provider on start', () => {
    const launchOptions = createOptionsContainer({ captureNetworkBodySizeLimit: 4096 });
    const client = createClient({ launchOptions });
    const provider = gatedCaptureProvider('net');
    client.addCaptureProvider(provider);
    client.launch();
    expect(provider.start).toHaveBeenCalledWith(launchOptions);
  });

  it('launch starts detection providers', () => {
    const client = createClient();
    const { provider } = capturingDetector('crash');
    client.addDetectionProvider(provider);
    client.launch();
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('launch is idempotent', () => {
    const client = createClient();
    const provider = gatedCaptureProvider('net');
    client.addCaptureProvider(provider);
    client.launch();
    client.launch();
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('routes a detection submission to the trigger pipeline', () => {
    const report = vi.fn(async () => ({ ok: true }));
    const triggerPipeline = { report } as TriggerPipeline;
    const client = createClient({ triggerPipeline });
    const { provider, fire } = capturingDetector('crash');
    client.addDetectionProvider(provider);
    client.launch();
    const request = createReportingRequest({ source: { type: 'crash' }, id: 'r1' });
    fire(request);
    expect(report).toHaveBeenCalledWith(request);
  });

  it('respects the option gate (a disabled capture provider is not started)', () => {
    const client = createClient({ isEnabled: (opt) => opt !== 'captureNetwork' });
    const provider = gatedCaptureProvider('net', 'captureNetwork');
    client.addCaptureProvider(provider);
    client.launch();
    expect(provider.start).not.toHaveBeenCalled();
  });

  it('uses an all-enabled gate by default (a gated provider still starts)', () => {
    const client = createClient(); // no isEnabled -> default all-enabled gate
    const provider = gatedCaptureProvider('net', 'captureNetwork');
    client.addCaptureProvider(provider);
    client.launch();
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('stop stops providers, drains uploads, and clears launched', async () => {
    const { uploadPipeline, flush } = fakeUpload();
    const client = createClient({ uploadPipeline });
    const provider = gatedCaptureProvider('net');
    client.addCaptureProvider(provider);
    client.launch();
    const drained = await client.stop(50);
    expect(drained).toBe(true);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(50);
    expect(client.isLaunched()).toBe(false);
  });

  it('stop is a no-op when not launched (does not flush)', async () => {
    const { uploadPipeline, flush } = fakeUpload();
    const client = createClient({ uploadPipeline });
    expect(await client.stop()).toBe(true);
    expect(flush).not.toHaveBeenCalled();
  });

  it('stop without an upload pipeline stops providers and resolves true', async () => {
    const client = createClient(); // no uploadPipeline
    const provider = gatedCaptureProvider('net');
    client.addCaptureProvider(provider);
    client.launch();
    expect(await client.stop()).toBe(true);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(client.isLaunched()).toBe(false);
  });

  it('flush delegates to the upload pipeline', async () => {
    const { uploadPipeline, flush } = fakeUpload();
    const client = createClient({ uploadPipeline });
    await client.flush(99);
    expect(flush).toHaveBeenCalledWith(99);
  });

  it('flush without an upload pipeline resolves true', async () => {
    expect(await createClient().flush()).toBe(true);
  });

  it('can relaunch after stop', () => {
    const client = createClient();
    const provider = gatedCaptureProvider('net');
    client.addCaptureProvider(provider);
    client.launch();
    void client.stop();
    client.launch();
    expect(provider.start).toHaveBeenCalledTimes(2);
  });
});

const throwingCaptureProvider = (name: string, err: unknown): CaptureProvider => ({
  name,
  init: vi.fn(),
  start: vi.fn(() => {
    throw err;
  }),
  stop: vi.fn(),
});
const throwingDetectionProvider = (name: string, err: unknown): DetectionProvider => ({
  name,
  start: vi.fn(() => {
    throw err;
  }),
  stop: vi.fn(),
});

describe('createClient — launch never throws (§15.1)', () => {
  it('swallows a throwing capture provider start and routes it to onError', () => {
    const onError = vi.fn();
    const client = createClient({ onError });
    const boom = new Error('capture start failed');
    client.addCaptureProvider(throwingCaptureProvider('bad', boom));
    expect(() => client.launch()).not.toThrow();
    expect(client.isLaunched()).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('still starts detection providers when a capture provider start throws', () => {
    const onError = vi.fn();
    const client = createClient({ onError });
    const { provider: detector } = capturingDetector('crash');
    client.addCaptureProvider(throwingCaptureProvider('bad', new Error('x')));
    client.addDetectionProvider(detector);
    client.launch();
    expect(detector.start).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing detection provider start and routes it to onError', () => {
    const onError = vi.fn();
    const client = createClient({ onError });
    const boom = new Error('detection start failed');
    client.addDetectionProvider(throwingDetectionProvider('crash', boom));
    expect(() => client.launch()).not.toThrow();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('launch does not throw with no onError configured (defaults to a no-op)', () => {
    const client = createClient();
    client.addCaptureProvider(throwingCaptureProvider('bad', new Error('x')));
    expect(() => client.launch()).not.toThrow();
  });

  it('routes a throwing hub listener to onError', () => {
    const onError = vi.fn();
    const client = createClient({ onError });
    client.hubs.log.subscribe(() => {
      throw new Error('listener boom');
    });
    client.hubs.log.emit({ timestamp: 1, level: 'info', source: 'logger', message: 'x' });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('routes a throwing operation observer to onError', () => {
    const onError = vi.fn();
    const client = createClient({ onError });
    client.operations.registerObserver(() => {
      throw new Error('observer boom');
    });
    client.operations.onOperation({ type: 'http', timestamp: 1 });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('createClient — logException', () => {
  const withTrigger = () => {
    const report = vi.fn<TriggerPipeline['report']>(async () => ({ ok: true }));
    return { client: createClient({ triggerPipeline: { report } as TriggerPipeline }), report };
  };

  it('builds an error report (type/mechanism/summary/stack) and reports it', async () => {
    const { client, report } = withTrigger();
    const result = await client.logException(new Error('boom'));
    expect(result).toEqual({ ok: true });
    const request = report.mock.calls[0]?.[0] as ReportingRequest;
    expect(request.report.type).toBe('error');
    expect(request.source).toEqual({ type: 'error', mechanism: 'programmatic' });
    expect(request.report.summary).toBe('boom');
    expect(request.report.description).toMatch(/Error: boom/);
  });

  it('dedups a re-captured instance (reports once)', async () => {
    const { client, report } = withTrigger();
    const err = new Error('x');
    await client.logException(err);
    expect(await client.logException(err)).toEqual({ ok: false });
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('rate-limits captures beyond the configured limit', async () => {
    const report = vi.fn(async (): Promise<UploadResult> => ({ ok: true }));
    const client = createClient({
      triggerPipeline: { report } as TriggerPipeline,
      captureRateLimit: { limit: 2, windowMs: 1000 },
      clock: fixedClock(0),
    });
    await client.logException(new Error('1'));
    await client.logException(new Error('2'));
    expect(await client.logException(new Error('3'))).toEqual({ ok: false });
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('resolves {ok:false} when there is no trigger pipeline', async () => {
    expect(await createClient().logException(new Error('x'))).toEqual({ ok: false });
  });

  it('uses String(value) as the summary for a non-Error value (no description)', async () => {
    const { client, report } = withTrigger();
    await client.logException('plain failure');
    const request = report.mock.calls[0]?.[0] as ReportingRequest;
    expect(request.report.summary).toBe('plain failure');
    expect(request.report.description).toBeUndefined();
  });

  it('applies mechanism, severity and labels overrides', async () => {
    const { client, report } = withTrigger();
    await client.logException(new Error('x'), {
      mechanism: 'uncaught',
      severity: 'blocker',
      labels: ['p1'],
    });
    const request = report.mock.calls[0]?.[0] as ReportingRequest;
    expect(request.source.mechanism).toBe('uncaught');
    expect(request.report.severity).toBe('blocker');
    expect(request.report.labels).toEqual(['p1']);
  });
});

describe('createClient — report path (built trigger pipeline)', () => {
  it('logException assembles + enqueues a bundle through the built trigger pipeline', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      bundleFileName: () => 'x.bundle.zip',
      clock: fixedClock(1000),
    });
    const result = await client.logException(new Error('boom'));
    expect(result).toEqual({ ok: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const bundle = enqueue.mock.calls[0]?.[0] as Bundle;
    expect(bundle.request.summary).toBe('boom');
    expect(bundle.fileName).toBe('x.bundle.zip');
  });

  it('a detection submission assembles + enqueues through the built trigger pipeline', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });
    const { provider, fire } = capturingDetector('crash');
    client.addDetectionProvider(provider);
    client.launch();
    fire(
      createReportingRequest({
        source: { type: 'crash', mechanism: 'uncaught' },
        id: 'r1',
        summary: 'crashed',
      }),
    );
    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect((enqueue.mock.calls[0]?.[0] as Bundle).request.summary).toBe('crashed');
  });

  it('does not build a trigger pipeline without appToken/getEnvironment (reports drop)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload(); // uploadPipeline only
    const client = createClient({ uploadPipeline });
    expect(await client.logException(new Error('x'))).toEqual({ ok: false });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

function tickStore() {
  const tick = vi.fn();
  const store: CaptureStore = {
    add: vi.fn(),
    tick,
    snapshot: () =>
      ({
        stream: async function* () {},
        drainAll: async () => new Map(),
        release: () => {},
      }) as CaptureSnapshot,
    clear: vi.fn(),
  };
  return { store, tick };
}

function fakeScheduler() {
  const calls: Array<{ cb: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  const scheduler: Scheduler = {
    setInterval: (cb, ms) => {
      calls.push({ cb, ms });
      return `handle-${calls.length}`;
    },
    clearInterval: (handle) => {
      cleared.push(handle);
    },
  };
  return { scheduler, calls, cleared };
}

describe('createClient — capture-store tick timer', () => {
  it('ticks the store on the scheduler interval (default 1000ms) while launched', () => {
    const { store, tick } = tickStore();
    const sched = fakeScheduler();
    createClient({
      captureStore: store,
      scheduler: sched.scheduler,
      clock: fixedClock(7777),
    }).launch();
    expect(sched.calls).toHaveLength(1);
    expect(sched.calls[0]?.ms).toBe(1000);
    sched.calls[0]?.cb(); // fire the interval
    expect(tick).toHaveBeenCalledWith(7777);
  });

  it('uses the configured tickIntervalMs', () => {
    const { store } = tickStore();
    const sched = fakeScheduler();
    createClient({ captureStore: store, scheduler: sched.scheduler, tickIntervalMs: 250 }).launch();
    expect(sched.calls[0]?.ms).toBe(250);
  });

  it('does not start a timer before launch', () => {
    const { store } = tickStore();
    const sched = fakeScheduler();
    createClient({ captureStore: store, scheduler: sched.scheduler });
    expect(sched.calls).toHaveLength(0);
  });

  it('clears the tick timer on stop', async () => {
    const { store } = tickStore();
    const sched = fakeScheduler();
    const client = createClient({ captureStore: store, scheduler: sched.scheduler });
    client.launch();
    await client.stop();
    expect(sched.cleared).toEqual(['handle-1']);
  });

  it('drives the store via the global timers by default, and stops on stop()', async () => {
    vi.useFakeTimers();
    try {
      const { store, tick } = tickStore();
      const client = createClient({ captureStore: store, clock: fixedClock(123) }); // default scheduler
      client.launch();
      vi.advanceTimersByTime(1000);
      expect(tick).toHaveBeenCalledWith(123);
      await client.stop();
      tick.mockClear();
      vi.advanceTimersByTime(3000);
      expect(tick).not.toHaveBeenCalled(); // timer cleared on stop
    } finally {
      vi.useRealTimers();
    }
  });
});
