import type { EnvironmentEnvelope, FileType } from '@bugsee/protocol';
import { createServiceContainer, defineService, serviceToken } from '@bugsee/service';
import { strFromU8, unzipSync } from '@bugsee/util';
import { describe, expect, it, vi } from 'vitest';
import { CaptureDataEntryBase } from './capture-data-entry';
import { createCaptureExporter } from './capture-exporter';
import { createClient, type Scheduler, SchedulerToken } from './client';
import { type Clock, ClockToken } from './clock';
import {
  type CaptureProvider,
  type CaptureSnapshot,
  type CaptureStore,
  CaptureStoreToken,
  type DetectionProvider,
} from './contracts';
import { BugseeError } from './errors';
import { FiltersToken } from './filters';
import { createMemoryCaptureStore } from './memory-capture-store';
import { createOptionsContainer } from './options';
import type { ReportMarker, ReportMarkerStore } from './report-marker-store';
import { createReportingRequest, type ReportingRequest } from './reporting';
import { ContextProviderToken, type RequestContext } from './request-context';
import {
  type Bundle,
  type UploadPipeline,
  UploadPipelineToken,
  type UploadResult,
} from './transport';
import type { TriggerPipeline } from './trigger-pipeline';

/** Test-only service token (mirrors how a real contract exports its token). */
const Svc = serviceToken<{ v: number }>('svc');

const getEnvironment = (): EnvironmentEnvelope => ({
  platform: { type: 'web', version: '1' },
  sdk: { version: '0', type: 'javascript' },
});

// Fixed-time clock so capture-entry timestamps are deterministic.
const fixedClock = (wall = 1000): Clock => ({ wallNow: () => wall, monotonicNow: () => 0 });
// The aggregator is write-only; read captured entries back via an exporter over the client's store.
const firstEntry = async (store: CaptureStore, type: FileType) =>
  (await createCaptureExporter(store).drain()).get(type)?.[0];

// Test-only extension typing so registerExt/ext is exercised (services use tokens — see `Svc`).
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

describe('createClient — request context', () => {
  it('stamps captured entries with the active context when a contextProvider is injected', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const ctx: RequestContext = {
      contextId: 'ctx-1',
      trace: { traceId: 't1', spanId: 's1', sampled: true },
    };
    const client = createClient({
      captureStore: store,
      contextProvider: { getCurrent: () => ctx },
    });
    client.captureAggregator.addEntry(new CaptureDataEntryBase('log', 1, { msg: 'hi' }));
    expect((await firstEntry(store, 'log'))?.data).toEqual({
      msg: 'hi',
      context_id: 'ctx-1',
      trace_id: 't1',
      span_id: 's1',
    });
  });

  it('registers the injected contextProvider as a resolvable service', () => {
    const provider = { getCurrent: () => undefined };
    const client = createClient({ contextProvider: provider });
    expect(client.getService(ContextProviderToken)).toBe(provider);
  });

  it('does not stamp or register a provider by default (today’s behavior)', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store });
    client.captureAggregator.addEntry(new CaptureDataEntryBase('log', 1, { msg: 'hi' }));
    expect((await firstEntry(store, 'log'))?.data).toEqual({ msg: 'hi' });
    expect(
      client.getServiceProvider(ContextProviderToken).getImmediate({ optional: true }),
    ).toBeNull();
  });

  it('merges the active request context (context_id + user) into the reported bundle', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const ctx: RequestContext = {
      contextId: 'ctx-9',
      user: 'req@x.com',
      attributes: { route: '/pay' },
    };
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      contextProvider: { getCurrent: () => ctx },
    });
    await client.logException(new Error('boom'));
    const bundle = enqueue.mock.calls[0]?.[0] as Bundle;
    expect(bundle.request.context_id).toBe('ctx-9');
    expect(bundle.request.email).toBe('req@x.com');
  });

  it('captures the context at SUBMIT time, not assembly time (survives ALS detachment)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const contexts: RequestContext[] = [{ contextId: 'submit-ctx' }, { contextId: 'later-ctx' }];
    let calls = 0;
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      // The submit reads the context once; a (wrong) assembly-time read would advance to 'later-ctx'.
      contextProvider: { getCurrent: () => contexts[Math.min(calls++, 1)] },
    });
    await client.logException(new Error('boom'));
    expect((enqueue.mock.calls[0]?.[0] as Bundle).request.context_id).toBe('submit-ctx');
  });

  it('reports no context_id when no context is active at submit', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      contextProvider: { getCurrent: () => undefined },
    });
    await client.logException(new Error('boom'));
    expect((enqueue.mock.calls[0]?.[0] as Bundle).request.context_id).toBeUndefined();
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

describe('createClient — internal service container (DI)', () => {
  it('lazily instantiates a registered service exactly once (singleton)', () => {
    const factory = vi.fn(() => ({ v: 7 }));
    const client = createClient();
    client.addService(defineService(Svc, factory));
    expect(client.getService(Svc)).toEqual({ v: 7 });
    expect(client.getService(Svc)).toBe(client.getService(Svc));
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('resolves a service registered AFTER getServiceProvider (late registration)', async () => {
    const client = createClient();
    const pending = client.getServiceProvider(Svc).get();
    client.addService(defineService(Svc, () => ({ v: 9 })));
    expect(await pending).toEqual({ v: 9 });
  });

  it('uses an injected container when provided', () => {
    const container = createServiceContainer();
    container.addService(defineService(Svc, () => ({ v: 42 })));
    const client = createClient({ services: container });
    expect(client.getService(Svc)).toEqual({ v: 42 });
  });

  it('registers the provided captureStore as a resolvable service', () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store });
    expect(client.getService(CaptureStoreToken)).toBe(store); // same instance the aggregator uses
  });

  it('registers the default in-memory captureStore as a service when none is provided', () => {
    const client = createClient();
    const store = client.getService(CaptureStoreToken);
    // it is the SAME store the aggregator writes to (drains what was added)
    client.captureAggregator.addEntry(new CaptureDataEntryBase('log', 1, { msg: 'hi' }));
    return createCaptureExporter(store)
      .drain()
      .then((parts) => expect(parts.get('log')).toHaveLength(1));
  });

  it('registers the resolved clock and scheduler as services', () => {
    const clock = fixedClock(1234);
    const scheduler = { setInterval: () => 'h', clearInterval: () => {} };
    const client = createClient({ clock, scheduler });
    expect(client.getService(ClockToken)).toBe(clock);
    expect(client.getService(SchedulerToken)).toBe(scheduler);
  });

  it('registers the uploadPipeline as a service when one is provided', () => {
    const uploadPipeline = {
      enqueue: async () => ({ ok: true }),
      flush: async () => true,
      drop: () => {},
    };
    const client = createClient({ uploadPipeline });
    expect(client.getService(UploadPipelineToken)).toBe(uploadPipeline);
  });

  it('does not register an uploadPipeline service when none is provided', () => {
    const client = createClient();
    expect(() => client.getService(UploadPipelineToken)).toThrow();
  });
});

describe('createClient — redaction filters', () => {
  const memStore = () => createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
  const drainType = async (store: CaptureStore, type: FileType) =>
    (await createCaptureExporter(store).drain()).get(type) ?? [];

  it('set* write the filters service (the same instance the capture pipeline reads)', () => {
    const client = createClient();
    const nf = (e: { url: string }) => e as never;
    client.setNetworkEventFilter(nf as never);
    expect(client.getService(FiltersToken).network).toBe(nf);
    client.setNetworkEventFilter(null);
    expect(client.getService(FiltersToken).network).toBeNull();
  });

  it('setBreadcrumbFilter mutates, drops, and clears', async () => {
    const store = memStore();
    const client = createClient({ captureStore: store });
    client.setBreadcrumbFilter((b) => ({ ...b, message: 'redacted' }));
    client.addBreadcrumb({ message: 'secret' });
    expect((await drainType(store, 'breadcrumbs'))[0]?.data).toMatchObject({ message: 'redacted' });
    client.setBreadcrumbFilter(() => null); // drop
    client.addBreadcrumb({ message: 'gone' });
    expect(await drainType(store, 'breadcrumbs')).toHaveLength(1); // dropped one not added
    client.setBreadcrumbFilter(null); // cleared → passes through
    client.addBreadcrumb({ message: 'kept' });
    expect(await drainType(store, 'breadcrumbs')).toHaveLength(2);
  });

  it('setLogEventFilter mutates or drops logs', async () => {
    const store = memStore();
    const client = createClient({ captureStore: store });
    client.setLogEventFilter((e) => (e.message.includes('drop') ? null : { ...e, message: 'X' }));
    client.log('keep me');
    client.log('please drop');
    const logs = await drainType(store, 'log');
    expect(logs).toHaveLength(1);
    expect((logs[0]?.data as { message: string }).message).toBe('X');
  });

  it('a throwing filter drops the event and routes to onError once', async () => {
    const store = memStore();
    const onError = vi.fn();
    const client = createClient({ captureStore: store, onError });
    client.setBreadcrumbFilter(() => {
      throw new Error('bad scrubber');
    });
    client.addBreadcrumb({ message: 'x' });
    expect((await createCaptureExporter(store).drain()).size).toBe(0); // dropped (privacy-safe)
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('setReportHandler before mutates the report; a null veto blocks the upload', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });
    client.setReportHandler({
      before: (r) => {
        r.report.summary = 'masked';
        return r;
      },
    });
    await client.logException(new Error('boom'));
    expect((enqueue.mock.calls[0]?.[0] as Bundle).request.summary).toBe('masked');

    client.setReportHandler({ before: () => null }); // veto
    expect(await client.logException(new Error('veto'))).toEqual({ ok: false });
    expect(enqueue).toHaveBeenCalledTimes(1); // no second enqueue
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

function fakeMarkers() {
  const put = vi.fn<(marker: ReportMarker) => void>();
  const remove = vi.fn<(id: string) => void>();
  const store: ReportMarkerStore = { put, list: () => [], remove };
  return { store, put, remove };
}

describe('createClient — capture-recovery markers', () => {
  it('logException persists a recovery marker BEFORE assembly and clears it on settle', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const { store, put, remove } = fakeMarkers();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 42 },
    });
    client.setAttribute('k', 1);
    client.setUserIdentifier('u@e.com');

    const result = await client.logException(new Error('boom'));

    expect(result.ok).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
    const marker = put.mock.calls[0]?.[0] as ReportMarker;
    expect(marker.generation).toBe(42);
    expect(marker.attributes).toEqual({ k: 1 }); // incident-time global attributes
    expect(marker.userIdentifier).toBe('u@e.com');
    expect(marker.request.report.summary).toBe('boom');
    // put happened before the bundle was enqueued (so a crash during assembly still leaves the marker).
    expect(
      (put.mock.invocationCallOrder[0] as number) < (enqueue.mock.invocationCallOrder[0] as number),
    ).toBe(true);
    expect(remove).toHaveBeenCalledWith(marker.request.id); // cleared on settle
  });

  it('a detection report also routes through the marker hook', async () => {
    const { uploadPipeline } = fakeUpload();
    const { store, put, remove } = fakeMarkers();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 7 },
    });
    const { provider, fire } = capturingDetector('crash');
    client.addDetectionProvider(provider);
    client.launch();

    fire(createReportingRequest({ source: { type: 'crash' }, id: 'det-1' }));

    expect(put).toHaveBeenCalledTimes(1);
    expect((put.mock.calls[0]?.[0] as ReportMarker).generation).toBe(7);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith('det-1')); // cleared on settle
  });

  it('a marker put failure routes to onError and the report still proceeds', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const onError = vi.fn();
    const store: ReportMarkerStore = {
      put: () => {
        throw new Error('put boom');
      },
      list: () => [],
      remove: vi.fn(),
    };
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
      onError,
    });
    const result = await client.logException(new Error('x'));
    expect(result.ok).toBe(true); // report still delivered
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('a marker remove failure on settle routes to onError', async () => {
    const { uploadPipeline } = fakeUpload();
    const onError = vi.fn();
    const store: ReportMarkerStore = {
      put: vi.fn(),
      list: () => [],
      remove: () => {
        throw new Error('remove boom');
      },
    };
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
      onError,
    });
    await client.logException(new Error('x'));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.any(Error)));
  });

  it('clears the marker even when the upload fails (the durable bundle queue then owns delivery)', async () => {
    const enqueue = vi.fn<UploadPipeline['enqueue']>(async () => ({ ok: false }));
    const uploadPipeline: UploadPipeline = {
      enqueue,
      flush: vi.fn(async () => true),
      drop: vi.fn(),
    };
    const { store, remove } = fakeMarkers();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });
    expect(await client.logException(new Error('x'))).toEqual({ ok: false });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1)); // still cleared
  });

  it('a vetoed report writes no marker', async () => {
    const { uploadPipeline } = fakeUpload();
    const { store, put } = fakeMarkers();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });
    client.setReportHandler({ before: () => null });
    expect(await client.logException(new Error('x'))).toEqual({ ok: false });
    expect(put).not.toHaveBeenCalled();
  });
});

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

  it('inits a registered capture provider with the capture pipeline (operations/aggregator)', () => {
    const client = createClient();
    const provider = gatedCaptureProvider('net');
    client.addCaptureProvider(provider);
    expect(provider.init).toHaveBeenCalledTimes(1);
    const init = vi.mocked(provider.init).mock.calls[0]?.[0];
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

  it('is a silent no-op after stop() (does not report), and resumes after re-launch', async () => {
    const report = vi.fn<TriggerPipeline['report']>(async () => ({ ok: true }));
    const client = createClient({
      triggerPipeline: { report } as TriggerPipeline,
      scheduler: { setInterval: () => 'h', clearInterval: () => {} },
    });
    client.launch();
    await client.stop();
    expect(await client.logException(new Error('after-stop'))).toEqual({ ok: false }); // §1501
    expect(report).not.toHaveBeenCalled();
    client.launch(); // re-launch restores capture
    expect(await client.logException(new Error('after-relaunch'))).toEqual({ ok: true });
    expect(report).toHaveBeenCalledTimes(1);
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

  it('merges report-snapshot entries (e.g. a viewtree) into the assembled bundle at the report time', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    // Two entries of the same (new) type exercise BOTH merge branches: the first creates the list, the
    // second appends to it — and the order is preserved.
    const snap = vi.fn((now: number) => [
      new CaptureDataEntryBase('viewtree' as FileType, now, { tag: 'body', children: [] }),
      new CaptureDataEntryBase('viewtree' as FileType, now, { tag: 'dialog' }),
    ]);
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      clock: fixedClock(1000),
      reportSnapshots: [snap],
    });
    await client.logException(new Error('boom'));
    expect(snap).toHaveBeenCalledWith(1000); // pulled with the report's wall-clock timestamp
    const bundle = enqueue.mock.calls[0]?.[0] as Bundle;
    const files = unzipSync(bundle.body);
    // viewtree.json holds the array of entry data, in source order.
    expect(JSON.parse(strFromU8(files['viewtree.json'] as Uint8Array))).toEqual([
      { tag: 'body', children: [] },
      { tag: 'dialog' },
    ]);
  });

  it('merges entries from an ASYNC snapshot source (e.g. a node CPU profile)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const snap = vi.fn(async (now: number) => [
      new CaptureDataEntryBase('profile' as FileType, now, { nodes: [], samples: [1] }),
    ]);
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      clock: fixedClock(1000),
      reportSnapshots: [snap],
    });
    await client.logException(new Error('boom'));
    expect(snap).toHaveBeenCalledWith(1000);
    const files = unzipSync((enqueue.mock.calls[0]?.[0] as Bundle).body);
    // profile.json is the single bare object (the assembler's profile special-case).
    expect(JSON.parse(strFromU8(files['profile.json'] as Uint8Array))).toEqual({
      nodes: [],
      samples: [1],
    });
  });

  it('isolates a REJECTING async snapshot source: onError fires and the report still uploads', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const onError = vi.fn();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      onError,
      reportSnapshots: [async () => Promise.reject(new Error('async snapshot failed'))],
    });
    expect(await client.logException(new Error('boom'))).toEqual({ ok: true });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing snapshot source: onError fires and the report still uploads', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const onError = vi.fn();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      onError,
      reportSnapshots: [
        () => {
          throw new Error('snapshot failed');
        },
      ],
    });
    const result = await client.logException(new Error('boom'));
    expect(result).toEqual({ ok: true }); // delivered despite the snapshot failure
    expect(onError).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('puts the global userIdentifier on the wire as request.json email', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });
    client.setUserIdentifier('alice@example.com');
    await client.logException(new Error('boom'));
    expect((enqueue.mock.calls[0]?.[0] as Bundle).request.email).toBe('alice@example.com');

    // Clearing the identity drops the email on subsequent reports.
    client.clearUserIdentifier();
    await client.logException(new Error('boom2'));
    expect('email' in (enqueue.mock.calls[1]?.[0] as Bundle).request).toBe(false);
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

describe('createClient — kill-state (invalid app token)', () => {
  const killClient = (
    over: { enqueue?: UploadPipeline['enqueue']; onError?: (e: unknown) => void } = {},
  ) => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const enqueue = over.enqueue ?? vi.fn<UploadPipeline['enqueue']>(async () => ({ ok: true }));
    const onError = over.onError ?? vi.fn();
    const client = createClient({
      uploadPipeline: { enqueue, flush: vi.fn(async () => true), drop: vi.fn() },
      appToken: 'tok',
      getEnvironment,
      captureStore: store,
      scheduler: { setInterval: () => 'h', clearInterval: () => {} },
      onError,
    });
    return { client, store, enqueue, onError };
  };
  const fatal = () => new BugseeError('invalid app token', 401, { fatal: true });

  it('enters the kill-state on a fatal report result: onError once, halts, captures no-op', async () => {
    const err = fatal();
    const { client, store, onError } = killClient({
      enqueue: async () => ({ ok: false, error: err }),
    });
    const provider = { name: 'p', init: vi.fn(), start: vi.fn(), stop: vi.fn() } as CaptureProvider;
    client.addCaptureProvider(provider);
    client.launch();
    await client.logException(new Error('boom'));

    expect(onError).toHaveBeenCalledWith(err);
    expect(client.isLaunched()).toBe(false); // capture/detection halted
    expect(provider.stop).toHaveBeenCalled(); // the capture coordinator was stopped
    // Subsequent captures are no-ops.
    client.log('after-kill');
    client.event('e');
    client.trace('t', 1);
    client.addBreadcrumb({ message: 'b' });
    const drained = await createCaptureExporter(store).drain();
    expect(drained.size).toBe(0);
    expect(await client.logException(new Error('again'))).toEqual({ ok: false }); // no-op
  });

  it('fires onError exactly once even when multiple fatal reports settle', async () => {
    const { client, onError } = killClient({
      enqueue: async () => ({ ok: false, error: fatal() }),
    });
    client.launch();
    const a = client.logException(new Error('a'));
    const b = client.logException(new Error('b')); // both in flight before either settles
    await Promise.all([a, b]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('stays dead: launch() after a kill is a no-op (does not re-arm capture)', async () => {
    const { client } = killClient({ enqueue: async () => ({ ok: false, error: fatal() }) });
    const provider = { name: 'p', init: vi.fn(), start: vi.fn(), stop: vi.fn() } as CaptureProvider;
    client.addCaptureProvider(provider);
    client.launch();
    await client.logException(new Error('boom')); // → kill
    (provider.start as ReturnType<typeof vi.fn>).mockClear();
    client.launch(); // attempt to re-arm a killed client
    expect(client.isLaunched()).toBe(false);
    expect(provider.start).not.toHaveBeenCalled(); // capture was NOT restarted
  });

  it('does NOT kill on a non-fatal report failure', async () => {
    const nonFatal = new BugseeError('5xx', 500); // fatal defaults false
    const { client, store, onError } = killClient({
      enqueue: async () => ({ ok: false, error: nonFatal }),
    });
    client.launch();
    await client.logException(new Error('boom'));
    expect(onError).not.toHaveBeenCalled();
    expect(client.isLaunched()).toBe(true);
    client.log('still-capturing');
    expect((await createCaptureExporter(store).drain()).get('log')).toHaveLength(1);
  });
});

describe('createClient — flush/stop await pending reports', () => {
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) =>
      (globalThis as unknown as { setTimeout(cb: () => void, ms: number): unknown }).setTimeout(
        resolve,
        ms,
      ),
    );
  // Tracks whether a promise has settled yet (without consuming it).
  const tracked = <T>(p: Promise<T>) => {
    let settled = false;
    void p.finally(() => {
      settled = true;
    });
    return {
      p,
      get settled() {
        return settled;
      },
    };
  };
  // A trigger pipeline whose report() stays pending until we release it — modelling the async
  // assemble→enqueue→upload a report drives (report resolves only after the upload completes).
  const deferredTrigger = () => {
    const resolvers: Array<(r: UploadResult) => void> = [];
    const report = vi.fn<TriggerPipeline['report']>(
      () => new Promise<UploadResult>((resolve) => resolvers.push(resolve)),
    );
    return {
      triggerPipeline: { report } as TriggerPipeline,
      report,
      releaseAll: (r: UploadResult = { ok: true }) => {
        for (const res of resolvers) {
          res(r);
        }
      },
    };
  };

  it('flush() does not resolve until an in-flight logException report settles', async () => {
    const { triggerPipeline, report, releaseAll } = deferredTrigger();
    const client = createClient({ triggerPipeline });
    void client.logException(new Error('x'));
    expect(report).toHaveBeenCalledTimes(1);
    const f = tracked(client.flush());
    await delay(5);
    expect(f.settled).toBe(false); // report still assembling/uploading → flush waits
    releaseAll();
    expect(await f.p).toBe(true);
  });

  it('flush() awaits an in-flight detection report (fire-and-forget submission)', async () => {
    const { triggerPipeline, report, releaseAll } = deferredTrigger();
    const client = createClient({ triggerPipeline });
    const { provider, fire } = capturingDetector('crash');
    client.addDetectionProvider(provider);
    client.launch();
    fire(createReportingRequest({ source: { type: 'crash' }, id: 'r1' }));
    expect(report).toHaveBeenCalledTimes(1);
    const f = tracked(client.flush());
    await delay(5);
    expect(f.settled).toBe(false);
    releaseAll();
    expect(await f.p).toBe(true);
  });

  it('stop() awaits an in-flight report before resolving', async () => {
    const { triggerPipeline, releaseAll } = deferredTrigger();
    const client = createClient({ triggerPipeline });
    client.launch();
    void client.logException(new Error('x'));
    const s = tracked(client.stop());
    await delay(5);
    expect(s.settled).toBe(false);
    releaseAll();
    expect(await s.p).toBe(true);
  });

  it('flush(timeout) resolves false when a report does not settle within the budget', async () => {
    const { triggerPipeline } = deferredTrigger(); // never released
    const client = createClient({ triggerPipeline });
    void client.logException(new Error('x'));
    expect(await client.flush(10)).toBe(false);
  });

  it('drains an in-flight report that rejects, without surfacing an unhandled rejection', async () => {
    // Explicitly watch for unhandled rejections: drainPending's own allSettled tolerates the
    // rejection regardless, so the ONLY thing distinguishing track's `.then(forget, forget)` from a
    // `.finally` (whose discarded derived promise re-raises) is whether an unhandled rejection fires.
    const proc = (
      globalThis as unknown as {
        process: {
          on(event: string, listener: (reason: unknown) => void): unknown;
          off(event: string, listener: (reason: unknown) => void): unknown;
        };
      }
    ).process;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    proc.on('unhandledRejection', onUnhandled);
    try {
      let reject!: (reason: unknown) => void;
      const report = vi.fn<TriggerPipeline['report']>(
        () => new Promise<UploadResult>((_resolve, rej) => (reject = rej)),
      );
      const client = createClient({ triggerPipeline: { report } as TriggerPipeline });
      const logged = client.logException(new Error('x'));
      logged.catch(() => {}); // the public promise rejects too; handle it so it isn't "unhandled"
      const f = tracked(client.flush());
      await delay(5);
      expect(f.settled).toBe(false); // still awaiting the pending report
      reject(new Error('report blew up'));
      expect(await f.p).toBe(true); // allSettled tolerates the rejection; flush still resolves
      await delay(10); // let any unhandled rejection settle into a macrotask
      expect(unhandled).toEqual([]); // track must not leak the rejection (reverting to .finally would)
    } finally {
      proc.off('unhandledRejection', onUnhandled);
    }
  });

  it('tracks a dropped report when a detection fires with no trigger pipeline', async () => {
    const client = createClient(); // no triggerPipeline → report resolves {ok:false}
    const { provider, fire } = capturingDetector('crash');
    client.addDetectionProvider(provider);
    client.launch();
    fire(createReportingRequest({ source: { type: 'crash' }, id: 'r1' }));
    expect(await client.flush()).toBe(true); // the settled {ok:false} report drains
  });

  it('a report that already settled does not block a later flush', async () => {
    // (The pending-set cleanup itself is non-observable memory hygiene — a resolved promise left in
    // the set wouldn't change flush; what's validated here is that a settled report can't stall flush.)
    const { triggerPipeline, releaseAll } = deferredTrigger();
    const client = createClient({ triggerPipeline });
    void client.logException(new Error('x'));
    releaseAll(); // report settles before flush is called
    await delay(0);
    expect(await client.flush()).toBe(true);
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

  it('a throwing tick is routed to onError, never thrown out of the timer (no uncaughtException)', () => {
    const { store } = tickStore();
    (store.tick as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('tick boom'); // e.g. a backend that throws — must not crash the host via the timer
    });
    const sched = fakeScheduler();
    const onError = vi.fn();
    createClient({ captureStore: store, scheduler: sched.scheduler, onError }).launch();
    expect(() => sched.calls[0]?.cb()).not.toThrow(); // the interval callback must never throw
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'tick boom' }));
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
