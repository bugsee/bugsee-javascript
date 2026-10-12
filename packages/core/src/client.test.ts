import type { EnvironmentEnvelope, FileType } from '@bugsee/protocol';
import { createServiceContainer, defineService, serviceToken } from '@bugsee/service';
import { strFromU8, unzipSync } from '@bugsee/util';
import { describe, expect, it, vi } from 'vitest';
import { addReportAttachment, decodeRequestFromMarker } from './attachments';
import { BlackoutToken } from './blackout';
import { CaptureDataEntryBase } from './capture-data-entry';
import { createCaptureExporter } from './capture-exporter';
import {
  asInternalClient,
  type BugseeClient,
  createClient,
  type Scheduler,
  SchedulerToken,
} from './client';
import { type Clock, ClockToken } from './clock';
import {
  type CaptureProvider,
  type CaptureSnapshot,
  type CaptureStore,
  CaptureStoreToken,
  type DetectionProvider,
} from './contracts';
import {
  type BundleStore,
  createDurableUploadPipeline,
  type IdentifiedBundle,
} from './durable-upload-pipeline';
import { BugseeError } from './errors';
import { type FilterableSpan, FiltersToken } from './filters';
import { BugseeStatus } from './launch-status';
import { createMemoryCaptureStore } from './memory-capture-store';
import { createOptionsContainer } from './options';
import { createPartitionedCaptureStore } from './partitioned-capture-store';
import type { ReportMarker, ReportMarkerStore } from './report-marker-store';
import {
  createReportingRequest,
  type Report,
  type ReportAttachmentInput,
  type ReportingRequest,
} from './reporting';
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
  runtime: { type: 'web', version: '' },
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

  it('a throwing contextProvider degrades to no context — never breaks reporting (R-5)', async () => {
    // The provider is integrator-replaceable; a custom binding whose getCurrent() throws must read
    // as "no active context" at submit, not propagate out of logException into the application.
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      contextProvider: {
        getCurrent: (): RequestContext => {
          throw new Error('custom provider broken');
        },
      },
    });
    await client.logException(new Error('boom')); // must not throw…
    expect((enqueue.mock.calls[0]?.[0] as Bundle).request.context_id).toBeUndefined(); // …and reports clean
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

  // The wire level is NUMERIC (mobile parity: 1=Error … 5=Verbose). `client.log()` — the manual API
  // users are told to call — once shipped the string name. These two tests asserted `level: 'info'` and
  // `level: 'error'`, so they pinned the defect in place; the e2e upload contract is what finally named it.
  it('log pushes a log entry whose level is the NUMERIC wire value', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store, clock: fixedClock(1000) });
    client.log('hello');
    expect((await firstEntry(store, 'log'))?.data).toEqual({
      timestamp: 1000,
      level: 3, // 'info' (1=Error, 2=Warning, 3=Info, 4=Debug, 5=Verbose)
      source: 'logger',
      message: 'hello',
    });
  });

  it('log honors an explicit level and timestamp, still encoding the level', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store, clock: fixedClock(1000) });
    client.log('boom', 'error', 7);
    expect((await firstEntry(store, 'log'))?.data).toEqual({
      timestamp: 7,
      level: 1, // 'error'
      source: 'logger',
      message: 'boom',
    });
  });

  it('passes an ALREADY-numeric level through unchanged', async () => {
    // The API accepts both, so the encoder must be idempotent — re-encoding a number would corrupt it.
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store, clock: fixedClock(1000) });
    client.log('n', 2);
    expect((await firstEntry(store, 'log'))?.data).toMatchObject({ level: 2 });
  });

  it('shows the LOG FILTER the friendly name, not the wire number', async () => {
    // A user's filter is application code written against the documented API, where levels are names.
    // Encoding before the filter would silently break every `level === 'error'` check ever written.
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const seen: unknown[] = [];
    const client = createClient({ captureStore: store, clock: fixedClock(1000) });
    const filters = client.getService(FiltersToken);
    filters.log = (e) => {
      seen.push(e.level);
      return e;
    };
    client.log('boom', 'error');
    expect(seen).toEqual(['error']);
    expect((await firstEntry(store, 'log'))?.data).toMatchObject({ level: 1 });
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

/**
 * Let every already-queued microtask run — enough for `submitReport`'s settle handler, which is a
 * plain `.then` on the report promise. A `vi.waitFor` cannot express "and then nothing happened".
 */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function fakeMarkers() {
  const put = vi.fn<(marker: ReportMarker) => void | Promise<void>>();
  const remove = vi.fn<(id: string) => void>();
  const store: ReportMarkerStore = { put, list: () => [], remove };
  return { store, put, remove };
}

describe('createClient — file encoders', () => {
  it('threads fileEncoders into bundle assembly (a binary file type → bytes, not JSON)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      // Inject a `replay` entry at report time + a binary encoder for it (mirrors @bugsee/replay's wiring).
      reportSnapshots: [() => [new CaptureDataEntryBase('replay', 1, { e: 1 })]],
      fileEncoders: { replay: (payloads) => new Uint8Array([7, payloads.length]) },
    });
    await client.logException(new Error('x'));
    const bundle = enqueue.mock.calls[0]?.[0] as Bundle;
    expect(unzipSync(bundle.body)['replay.bin']).toEqual(new Uint8Array([7, 1])); // encoder output, stored raw
  });
});

describe('createClient — crash.json (SC3)', () => {
  const crashOf = (bundle: Bundle) =>
    JSON.parse(strFromU8(unzipSync(bundle.body)['crash.json'] as Uint8Array));

  it('logException writes a structured crash.json (handled) into the bundle', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at handleClick (app.min.js:1:2345)';
    await client.logException(err);
    const crash = crashOf(enqueue.mock.calls[0]?.[0] as Bundle);
    expect(crash.exception_type).toBe('error');
    expect(crash.handled).toBe(true);
    expect(crash.exception.name).toBe('Error');
    expect(crash.exception.reason).toBe('boom');
    expect(crash.exception.frames[0].trace).toBe('at handleClick (app.min.js:1:2345)');
    expect(crash.exception.frames[0].data).toEqual({
      source: 'app.min.js',
      member: 'handleClick',
      line: 1,
      column: 2345,
    });
  });

  it('gives a thrown NON-Error the caller\u2019s frames, not an empty list', async () => {
    // `logException('a string')` shipped `frames: []`, and the backend only emits a grouping
    // signature when it has a top frame (worker/crash/managed/common.py:88) \u2014 so each occurrence
    // became a new issue rather than another event. This test calls through a named function so the
    // caller is identifiable in the resulting frames.
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });
    async function applicationCode(): Promise<void> {
      await client.logException('a string throwable');
    }
    await applicationCode();
    const crash = crashOf(enqueue.mock.calls[0]?.[0] as Bundle);
    expect(crash.exception.name).toBe('String');
    expect(crash.exception.frames.length).toBeGreaterThan(0);
    // The caller is present and the SDK boundary is not.
    const members = crash.exception.frames.map(
      (f: { data?: { member?: string } }) => f.data?.member,
    );
    expect(members).toContain('applicationCode');
    // the PUBLIC wrapper (`Object.logException`) used to be frame 0. Frame 0 IS the application.
    expect(members[0]).toBe('applicationCode');
    expect(members.some((m: string | undefined) => m?.includes('logException'))).toBe(false);
  });

  it('skipFrames on a non-Error counts from the APPLICATION frame, not the SDK wrapper (R2P-1)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });
    async function applicationCode(): Promise<void> {
      await client.logException('str', { skipFrames: 1 });
    }
    await applicationCode();
    const crash = crashOf(enqueue.mock.calls[0]?.[0] as Bundle);
    const frames = crash.exception.frames as { hidden?: boolean; data?: { member?: string } }[];
    expect(frames[0]?.data?.member).toBe('applicationCode');
    expect(frames[0]?.hidden).toBe(true);
    expect(frames[1]?.hidden).not.toBe(true);
  });

  it('the fallback (no Error.captureStackTrace) also starts at the application frame (R2P-1)', async () => {
    const original = (Error as { captureStackTrace?: unknown }).captureStackTrace;
    (Error as { captureStackTrace?: unknown }).captureStackTrace = undefined;
    try {
      const { uploadPipeline, enqueue } = fakeUpload();
      const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });
      async function applicationCode(): Promise<void> {
        await client.logException('str');
      }
      await applicationCode();
      const crash = crashOf(enqueue.mock.calls[0]?.[0] as Bundle);
      expect(crash.exception.frames[0].data.member).toBe('applicationCode');
    } finally {
      (Error as { captureStackTrace?: unknown }).captureStackTrace = original;
    }
  });

  it('the wrapper callSite wins over a caller-supplied one (R2P-1, R3P-5)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });
    async function applicationCode(): Promise<void> {
      await client.logException('str', {
        callSite: { boundary: () => undefined, sdkFrames: 0 },
      } as never);
    }
    await applicationCode();
    const crash = crashOf(enqueue.mock.calls[0]?.[0] as Bundle);
    expect(crash.exception.frames[0].data.member).toBe('applicationCode');
  });

  it('uses the injected stackParser (browser passes its multi-engine parser)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const stackParser = vi.fn(() => [{ function: 'fn', file: 'x.js', line: 5, column: 6 }]);
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment, stackParser });
    await client.logException(new Error('e'));
    expect(stackParser).toHaveBeenCalled();
    const crash = crashOf(enqueue.mock.calls[0]?.[0] as Bundle);
    expect(crash.exception.frames[0].data).toEqual({
      source: 'x.js',
      member: 'fn',
      line: 5,
      column: 6,
    });
  });

  describe('logException domain and skipFrames', () => {
    const stacked = () => {
      const err = new Error('boom');
      err.stack =
        'Error: boom\n    at wrapper (a.js:1:1)\n    at inner (b.js:2:2)\n    at app (c.js:3:3)';
      return err;
    };
    const run = async (opts: Record<string, unknown>) => {
      const { uploadPipeline, enqueue } = fakeUpload();
      const onError = vi.fn();
      const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment, onError });
      await client.logException(stacked(), opts);
      return { crash: crashOf(enqueue.mock.calls[0]?.[0] as Bundle), onError };
    };

    it('writes exception.domain, the field the Android worker folds into the signature', async () => {
      const { crash, onError } = await run({ domain: 'checkout ' });
      expect(crash.exception.domain).toBe('checkout '); // verbatim, not trimmed
      expect(onError).not.toHaveBeenCalled();
    });

    it('omits domain when not given', async () => {
      const { crash } = await run({});
      expect('domain' in crash.exception).toBe(false);
      expect(crash.exception.frames.some((f: { hidden?: boolean }) => f.hidden)).toBe(false);
    });

    it('ignores a non-string or empty domain and warns through onError', async () => {
      for (const bad of [42, '', {}]) {
        const { crash, onError } = await run({ domain: bad });
        expect('domain' in crash.exception).toBe(false);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(String(onError.mock.calls[0]?.[0])).toContain('domain');
      }
    });

    it('marks the top skipFrames frames hidden, so grouping skips them but they stay visible', async () => {
      const { crash } = await run({ skipFrames: 2 });
      const f = crash.exception.frames as { trace: string; hidden?: boolean }[];
      expect(f).toHaveLength(3);
      expect(f.map((x) => x.hidden)).toEqual([true, true, undefined]);
    });

    it('clamps skipFrames to frames.length - 1 so a location always remains; 0 hides none (P5)', async () => {
      const all = await run({ skipFrames: 99 });
      const hidden = all.crash.exception.frames.map((x: { hidden?: boolean }) => x.hidden);
      expect(hidden).toEqual([true, true, undefined]); // 3 frames: the last one stays visible
      expect(all.onError).toHaveBeenCalledTimes(1);
      expect(String(all.onError.mock.calls[0]?.[0])).toContain('skipFrames');
      const exact = await run({ skipFrames: 3 }); // == frames.length also clamps
      expect(exact.crash.exception.frames.map((x: { hidden?: boolean }) => x.hidden)).toEqual([
        true,
        true,
        undefined,
      ]);
      expect(exact.onError).toHaveBeenCalledTimes(1);
      const inRange = await run({ skipFrames: 2 }); // frames.length - 1: no clamp, no warning
      expect(inRange.onError).not.toHaveBeenCalled();
      const none = await run({ skipFrames: 0 });
      expect(none.crash.exception.frames.some((x: { hidden?: boolean }) => x.hidden)).toBe(false);
      expect(none.onError).not.toHaveBeenCalled();
    });

    it('caps domain at 150 characters and says so once (P9)', async () => {
      const { crash, onError } = await run({ domain: 'd'.repeat(151) });
      expect(crash.exception.domain).toBe('d'.repeat(150));
      expect(onError).toHaveBeenCalledTimes(1);
      const ok = await run({ domain: 'd'.repeat(150) });
      expect(ok.crash.exception.domain).toBe('d'.repeat(150));
      expect(ok.onError).not.toHaveBeenCalled();
    });

    it('does not cut a surrogate pair in half when capping domain', async () => {
      const { crash } = await run({ domain: `${'d'.repeat(149)}\u{1F600}` });
      expect(crash.exception.domain).toBe('d'.repeat(149));
    });

    it('skipFrames on a stackless throwable keeps its one frame visible', async () => {
      const { uploadPipeline, enqueue } = fakeUpload();
      const onError = vi.fn();
      const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment, onError });
      const err = new Error('x');
      err.stack = 'Error: x';
      await client.logException(err, { skipFrames: 5 });
      const crash = crashOf(enqueue.mock.calls[0]?.[0] as Bundle);
      expect(crash.exception.frames.some((x: { hidden?: boolean }) => x.hidden)).toBe(false);
    });

    it('ignores an invalid skipFrames (negative, fractional, non-number) and warns', async () => {
      for (const bad of [-1, 1.5, '2', Number.NaN]) {
        const { crash, onError } = await run({ skipFrames: bad });
        expect(crash.exception.frames.some((x: { hidden?: boolean }) => x.hidden)).toBe(false);
        expect(onError).toHaveBeenCalledTimes(1);
        expect(String(onError.mock.calls[0]?.[0])).toContain('skipFrames');
      }
    });

    it('applies to a non-Error throwable too', async () => {
      const { uploadPipeline, enqueue } = fakeUpload();
      const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });
      await client.logException('str', { domain: 'd', skipFrames: 1 });
      const crash = crashOf(enqueue.mock.calls[0]?.[0] as Bundle);
      expect(crash.exception.domain).toBe('d');
      expect(crash.exception.frames[0].hidden).toBe(true);
    });
  });

  it('still writes a crash.json for a non-Error logException, with a synthetic exception', async () => {
    // A bundle with no crash.json produced an issue the backend could only answer with "Crash data
    // for the issue was not found" — present, counted, unusable. Non-Error throwables are ordinary
    // JS, and `logException` accepts them.
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });
    await client.logException('just a string');
    const files = unzipSync((enqueue.mock.calls[0]?.[0] as Bundle).body);
    expect('crash.json' in files).toBe(true);
    const crash = JSON.parse(strFromU8(files['crash.json'] as Uint8Array)) as {
      handled: boolean;
      exception: { name: string; reason: string };
    };
    expect(crash.exception).toMatchObject({ name: 'String', reason: 'just a string' });
    expect(crash.handled).toBe(true); // logException is a caught exception
  });
});

describe('createClient — report identity is snapshotted at submit time', () => {
  // Assembly runs DETACHED from the call that reported: the trigger pipeline awaits the capture drain
  // (and any report snapshots) before it builds the bundle. Reading the global attributes / user
  // identifier at that point reads whatever the app has done to them in the meantime — so
  // `logException(e)` followed by `clearAllAttributes()` uploaded an empty `manifest.attrs`, and the
  // recovery marker (which HAS always snapshotted at submit) disagreed with the live upload of the
  // very same report. The request context was already snapshotted at submit for exactly this reason;
  // these two were left reading live.
  const assembledFrom = (enqueue: ReturnType<typeof fakeUpload>['enqueue'], call = 0) => {
    const files = unzipSync((enqueue.mock.calls[call]?.[0] as Bundle).body);
    return {
      attrs: (
        JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)) as {
          attrs: Record<string, unknown>;
        }
      ).attrs,
      email: (JSON.parse(strFromU8(files['request.json'] as Uint8Array)) as { email?: string })
        .email,
    };
  };

  it('uploads the attributes + user identifier that were live when logException was CALLED', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });
    client.setAttribute('k', 1);
    client.setAttribute('tier', 'gold');
    client.setUserIdentifier('u@e.com');

    // Report, then mutate the global state in the SAME synchronous turn — assembly has not run yet.
    const pending = client.logException(new Error('boom'));
    client.clearAllAttributes();
    client.clearUserIdentifier();
    await pending;

    expect(assembledFrom(enqueue)).toEqual({ attrs: { k: 1, tier: 'gold' }, email: 'u@e.com' });
  });

  it('gives each report ITS OWN snapshot when attributes change between two reports', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });

    client.setAttribute('step', 'first');
    const first = client.logException(new Error('one'));
    client.setAttribute('step', 'second');
    const second = client.logException(new Error('two'));
    client.setAttribute('step', 'third'); // after BOTH — must reach neither
    await Promise.all([first, second]);

    expect(assembledFrom(enqueue, 0).attrs).toEqual({ step: 'first' });
    expect(assembledFrom(enqueue, 1).attrs).toEqual({ step: 'second' });
  });

  it('agrees with the recovery marker written for the same report', async () => {
    // The marker is what a recovered (crashed-before-upload) report carries. If the live upload reads
    // later state, the same incident is described two different ways depending on how it was delivered.
    const { uploadPipeline, enqueue } = fakeUpload();
    const { store, put } = fakeMarkers();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });
    client.setAttribute('k', 1);
    client.setUserIdentifier('u@e.com');

    const pending = client.logException(new Error('boom'));
    client.clearAllAttributes();
    client.clearUserIdentifier();
    await pending;

    const marker = put.mock.calls[0]?.[0] as ReportMarker;
    const assembled = assembledFrom(enqueue);
    expect(assembled.attrs).toEqual(marker.attributes);
    expect(assembled.email).toBe(marker.userIdentifier);
  });

  it('stamps the assembled bundle with the SAME report id its recovery marker is keyed by', async () => {
    // The durable queue writes this id into its frame header; recovery matches a staged blob to a still-
    // pending marker on it. If the two disagree, the blob is unreconcilable and the incident is reported
    // twice (or, worse, a blob is mistaken for one that was already delivered).
    const { uploadPipeline, enqueue } = fakeUpload();
    const { store, put } = fakeMarkers();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });

    await client.logException(new Error('boom'));

    const marker = put.mock.calls[0]?.[0] as ReportMarker;
    const bundle = enqueue.mock.calls[0]?.[0] as IdentifiedBundle;
    expect(bundle.reportId).toBe(marker.request.id);
    expect(bundle.reportId).toBeTypeOf('string');
    expect(JSON.stringify(bundle.request)).not.toContain(bundle.reportId); // never on the wire
  });

  it('stamps the ReportingRequest id, not the nested Report id, when the two differ', async () => {
    // `createReportingRequest` happens to set both to the same value, but the marker store — and
    // submitReport's clear — are keyed on the ReportingRequest id alone. Pinning the field, not the
    // coincidence, is what keeps a hand-built request (a detection provider's) reconcilable.
    const { uploadPipeline, enqueue } = fakeUpload();
    const { store, put } = fakeMarkers();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });
    const { provider, fire } = capturingDetector('crash');
    client.addDetectionProvider(provider);
    client.launch();

    const base = createReportingRequest({ source: { type: 'crash' }, id: 'request-id' });
    fire({ ...base, report: { ...base.report, id: 'nested-report-id' } });

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect((enqueue.mock.calls[0]?.[0] as IdentifiedBundle).reportId).toBe('request-id');
    expect((put.mock.calls[0]?.[0] as ReportMarker).request.id).toBe('request-id'); // the same key
  });

  it('snapshots a DETECTION report at submit too', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });
    const { provider, fire } = capturingDetector('crash');
    client.addDetectionProvider(provider);
    client.launch();
    client.setAttribute('at_crash', 'yes');

    fire(createReportingRequest({ source: { type: 'crash' }, id: 'det-attrs' }));
    client.clearAllAttributes(); // same turn — before the detached assembly runs

    await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
    expect(assembledFrom(enqueue).attrs).toEqual({ at_crash: 'yes' });
  });
});

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

  // ── When may the marker be retired? ────────────────────────────────────────────────────────────
  //
  // The marker is the ONLY trace of an incident whose bundle never reached durable storage, and it is
  // what keeps that incident's capture generation alive: `capture-recovery.ts`'s sweep frees every
  // generation no marker still names. So retiring one is a deletion, and it needs the same
  // justification every other deletion in the SDK needs.
  //
  // This used to be `result.then(clear, clear)` — retire on ANY settlement — justified by "the durable
  // bundle queue owns delivery from here". It does not always: `durable-upload-pipeline.ts` CATCHES a
  // throwing `store.put` and continues, so a full disk plus one 503 erased the blob, the marker and the
  // recording of a crash that had already happened. The test that stood here asserted exactly that
  // behaviour, with a bare `vi.fn` pipeline that staged nothing — so its own parenthetical was false.

  const failedUpload = (over: Partial<UploadResult> = {}): UploadPipeline => ({
    enqueue: vi.fn<UploadPipeline['enqueue']>(async () => ({ ok: false, ...over })),
    flush: vi.fn(async () => true),
    drop: vi.fn(),
  });

  it('threads enrichFrames into the crash it builds, so a platform can attach locals', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      enrichFrames: (_error, frames) => frames.map((f) => ({ ...f, variables: { a: '1' } })),
    });
    await client.logException(new Error('boom'));
    const files = unzipSync(enqueue.mock.calls[0]?.[0]?.body as Uint8Array);
    const crash = JSON.parse(strFromU8(files['crash.json'] as Uint8Array)) as {
      exception: { frames: Array<{ variables?: Record<string, string> }> };
    };
    expect(crash.exception.frames[0]?.variables).toEqual({ a: '1' });
  });

  it('calls onReportSite at the boundary of logException, before the crash is built', async () => {
    // The seam exists for ONE reason: at this instant the caller's catch block is still on the stack,
    // so a platform with a debugger attached can read the scope the report was made from. A moment
    // later — inside buildCrashJson, or in any promise callback — those frames are gone.
    const { uploadPipeline } = fakeUpload();
    const order: string[] = [];
    const thrown = new Error('boom');
    const seen: unknown[] = [];
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      onReportSite: (error) => {
        seen.push(error);
        order.push('report-site');
      },
      enrichFrames: (_error, frames) => {
        order.push('enrich');
        return frames;
      },
    });
    await client.logException(thrown);
    expect(seen).toEqual([thrown]);
    expect(order).toEqual(['report-site', 'enrich']);
  });

  it('does not call onReportSite for a report it is going to refuse anyway', async () => {
    // Pausing the process to look at a scope whose report is then dropped is pure cost.
    const { uploadPipeline } = fakeUpload();
    const onReportSite = vi.fn();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      onReportSite,
      captureRateLimit: { limit: 1, windowMs: 60_000 },
    });
    await client.logException(new Error('one'));
    await client.logException(new Error('two')); // over the capture rate limit
    expect(onReportSite).toHaveBeenCalledTimes(1);
  });

  it('does not let a throwing onReportSite lose the report', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const onError = vi.fn();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      onError,
      onReportSite: () => {
        throw new Error('inspector detached');
      },
    });
    const result = await client.logException(new Error('boom'));
    expect(result.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('stores a span filter for the capture pipeline to read live', async () => {
    // The seam consumed OpenTelemetry spans are scrubbed through — `@bugsee/performance` reads
    // `filters.span` from this same store at both of its transaction funnels. Set here, read there.
    const client = createClient({ appToken: 'tok', getEnvironment });
    const filters = client.getService(FiltersToken);
    expect(filters.span).toBeNull();
    const filter = (span: FilterableSpan): FilterableSpan => span;
    client.setSpanFilter(filter);
    expect(filters.span).toBe(filter);
    client.setSpanFilter(null); // and it clears
    expect(filters.span).toBeNull();
  });

  it('KEEPS the marker when the upload fails retryably and nothing durably retained the bundle', async () => {
    const { store, remove } = fakeMarkers();
    const client = createClient({
      uploadPipeline: failedUpload(),
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });
    expect(await client.logException(new Error('x'))).toEqual({ ok: false });
    await flushMicrotasks();
    expect(remove).not.toHaveBeenCalled();
  });

  it('KEEPS the marker when the durable queue could not stage the bundle ASYNCHRONOUSLY', async () => {
    // COMPOSITION. Every other `retained` test on this path drives a STUB pipeline that stages nothing,
    // so each pins this file's rule while being unable to see whether the queue's answer is TRUE. On the
    // browser and worker tiers the durable write is an IndexedDB transaction that is accepted and then
    // fails — quota exhaustion, the routine failure there — and a queue that could only observe a
    // SYNCHRONOUS throw answered `retained: true` regardless. The marker was then retired here with
    // nothing durable behind the incident, which is the one deletion that makes a crash unrecoverable.
    const { store, remove } = fakeMarkers();
    const persisted = new Map<string, Uint8Array>();
    const asyncFailingStore: BundleStore = {
      put: () => Promise.reject(new Error('QuotaExceededError')),
      list: () => [...persisted.keys()],
      read: (id) => persisted.get(id),
      remove: (id) => {
        persisted.delete(id);
      },
    };
    const client = createClient({
      uploadPipeline: createDurableUploadPipeline({
        store: asyncFailingStore,
        pipeline: failedUpload(), // retryable — nothing is settled either
        onError: () => {},
      }),
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });
    expect(await client.logException(new Error('x'))).toMatchObject({ ok: false });
    await flushMicrotasks();
    expect(persisted.size).toBe(0); // nothing durable carries this incident forward …
    expect(remove).not.toHaveBeenCalled(); // … so the marker is the only trace, and MUST survive
  });

  it('retires the marker when an ASYNCHRONOUS durable write SUCCEEDS — the positive control', async () => {
    // Without this the test above also passes on a queue that never reports `retained` for an async
    // store at all, which would strand every browser marker forever and re-upload on every launch.
    const { store, remove } = fakeMarkers();
    const persisted = new Map<string, Uint8Array>();
    const asyncStore: BundleStore = {
      put: (id, bytes) => {
        persisted.set(id, bytes);
        return Promise.resolve();
      },
      list: () => [...persisted.keys()],
      read: (id) => persisted.get(id),
      remove: (id) => {
        persisted.delete(id);
      },
    };
    const client = createClient({
      uploadPipeline: createDurableUploadPipeline({
        store: asyncStore,
        pipeline: failedUpload(),
        onError: () => {},
      }),
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });
    await client.logException(new Error('x'));
    expect(persisted.size).toBe(1); // durably staged ⇒ the next launch replays and reconciles it
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
  });

  it('KEEPS the marker, and reports, when the pipeline resolves a NON-CONFORMING result', async () => {
    // `triggerPipeline.report` is an injectable seam, so its answer is not guaranteed to be an
    // `UploadResult`. Reading `.retained` off it before entering the try turned that into a THROW inside
    // a `.then` whose only handler is for the upstream promise — an unhandled rejection surfacing in the
    // host application, which the SDK must never cause. Nothing is known about the upload here, so the
    // fail-safe direction is to keep the marker and let the next launch rebuild the incident.
    const { store, remove } = fakeMarkers();
    const onError = vi.fn();
    const client = createClient({
      uploadPipeline: {
        enqueue: vi.fn(async () => undefined as unknown as UploadResult),
        flush: vi.fn(async () => true),
        drop: vi.fn(),
      },
      appToken: 'tok',
      getEnvironment,
      onError,
      reportMarkers: { store, generation: 1 },
    });
    await client.logException(new Error('x'));
    await flushMicrotasks();
    expect(remove).not.toHaveBeenCalled();
    // TWO sites read this result and both must survive it: the marker gate here, and `track`'s
    // kill-state check. Counting pins them separately — asserting only "called with an Error" is
    // satisfied by either one alone, which would leave the other's guard unpinned.
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('REPORTS an incident that neither uploaded nor left any durable trace', async () => {
    // The end of the line. Keeping the marker is the right answer when nothing settled and nothing was
    // staged — but it is only worth anything if the MARKER itself persisted, and on the browser tier it
    // shares a database with the bundle, so quota exhaustion fails both together. The marker then exists
    // only in the store's in-memory mirror, dies with the page, and takes the incident with it. Silence
    // there is the difference between a degraded install and an invisible one.
    const { store, remove } = fakeMarkers();
    const onError = vi.fn();
    const client = createClient({
      uploadPipeline: failedUpload(), // retryable, nothing retained
      appToken: 'tok',
      getEnvironment,
      onError,
      reportMarkers: {
        store: { ...store, put: () => Promise.reject(new Error('QuotaExceededError')) },
        generation: 1,
      },
    });
    await client.logException(new Error('x'));
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('unrecoverable') }),
      ),
    );
    expect(remove).not.toHaveBeenCalled(); // still not deleted — the mirror may yet serve this run
  });

  it('stays SILENT when the marker persisted, though the upload failed', async () => {
    // The ordinary retryable failure: the marker is durable, so the next launch rebuilds. No alarm.
    const { store } = fakeMarkers();
    const onError = vi.fn();
    const client = createClient({
      uploadPipeline: failedUpload(),
      appToken: 'tok',
      getEnvironment,
      onError,
      reportMarkers: { store: { ...store, put: () => Promise.resolve() }, generation: 1 },
    });
    await client.logException(new Error('x'));
    await flushMicrotasks();
    expect(onError).not.toHaveBeenCalled();
  });

  it('does NOT call an incident unrecoverable when the queue RETAINED the bundle', async () => {
    // Recovery then rides the staged blob, not the marker, so the failed marker write costs this
    // incident nothing. The write failure is still reported — it is a real storage problem, and that is
    // the diagnostic the store used to emit itself — but the far louder "unrecoverable" claim is not.
    const { store } = fakeMarkers();
    const onError = vi.fn();
    const client = createClient({
      uploadPipeline: failedUpload({ retained: true }),
      appToken: 'tok',
      getEnvironment,
      onError,
      reportMarkers: {
        store: { ...store, put: () => Promise.reject(new Error('QuotaExceededError')) },
        generation: 1,
      },
    });
    await client.logException(new Error('x'));
    await flushMicrotasks();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'QuotaExceededError' }),
    );
    expect(onError).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('unrecoverable') }),
    );
  });

  it('retires the marker when the durable queue RETAINED the bundle, though the upload failed', async () => {
    const { store, remove } = fakeMarkers();
    const client = createClient({
      uploadPipeline: failedUpload({ retained: true }),
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });
    await client.logException(new Error('x'));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
  });

  it('retires the marker when the collector PERMANENTLY refused the bundle', async () => {
    const { store, remove } = fakeMarkers();
    const client = createClient({
      uploadPipeline: failedUpload({ permanent: true }),
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });
    await client.logException(new Error('x'));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
  });

  it('KEEPS the marker when the report path REJECTS — nothing at all is known about delivery', async () => {
    const { store, remove } = fakeMarkers();
    const client = createClient({
      triggerPipeline: { report: () => Promise.reject(new Error('assembly exploded')) },
      uploadPipeline: failedUpload(),
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });
    await expect(client.logException(new Error('x'))).rejects.toThrow('assembly exploded');
    await flushMicrotasks();
    expect(remove).not.toHaveBeenCalled();
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
    expect(flush).toHaveBeenCalledWith(undefined); // the shared drain is unbounded; 50 only bounds this wait
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

  it('getStatus walks Stopped -> Launched -> Stopping -> Stopped around a draining stop', async () => {
    let release!: () => void;
    const flush = vi.fn(() => new Promise<boolean>((r) => (release = () => r(true))));
    const client = createClient({ uploadPipeline: { flush } as unknown as UploadPipeline });
    expect(client.getStatus()).toBe(BugseeStatus.Stopped);
    client.launch();
    expect(client.getStatus()).toBe(BugseeStatus.Launched);
    const stopping = client.stop();
    expect(client.getStatus()).toBe(BugseeStatus.Stopping);
    await vi.waitFor(() => expect(flush).toHaveBeenCalled());
    expect(client.getStatus()).toBe(BugseeStatus.Stopping); // still draining
    release();
    await stopping;
    expect(client.getStatus()).toBe(BugseeStatus.Stopped);
  });

  it('a stop whose drain times out still ends Stopped', async () => {
    const flush = vi.fn(() => new Promise<boolean>(() => {}));
    const client = createClient({ uploadPipeline: { flush } as unknown as UploadPipeline });
    client.launch();
    expect(await client.stop(5)).toBe(false);
    expect(client.getStatus()).toBe(BugseeStatus.Stopped);
  });

  it('getLaunchOptions / getHostLaunchOptions return copies of the supplied view (empty by default)', () => {
    expect(createClient().getLaunchOptions()).toEqual({});
    expect(createClient().getHostLaunchOptions()).toEqual({});
    const effective = { a: 1, b: 2 };
    const host = { b: 2 };
    const client = createClient({ launchOptionsView: { effective, host } });
    const got = client.getLaunchOptions();
    expect(got).toEqual(effective);
    expect(got).not.toBe(effective);
    got.a = 99;
    expect(client.getLaunchOptions()).toEqual({ a: 1, b: 2 });
    expect(client.getHostLaunchOptions()).toEqual({ b: 2 });
    expect(client.getHostLaunchOptions()).not.toBe(host);
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

  it('links the error `cause` chain into the description (LinkedErrors — e.g. a React component stack)', async () => {
    const { client, report } = withTrigger();
    const componentStack = new Error('React component stack:\n    in Widget\n    in App');
    const err = new Error('render failed');
    err.cause = componentStack; // a framework adapter links supplementary context via cause
    await client.logException(err);
    const request = report.mock.calls[0]?.[0] as ReportingRequest;
    expect(request.report.description).toMatch(/Error: render failed/); // the error's own stack
    expect(request.report.description).toContain('Caused by: '); // the cause is linked
    expect(request.report.description).toContain('in Widget'); // the component stack travels with the report
  });

  it('falls back to the cause message when the cause has no stack, and stops at a non-Error cause', async () => {
    const { client, report } = withTrigger();
    const noStack = new Error('inner');
    noStack.stack = undefined; // a cause without a stack → use its message
    noStack.cause = 'a plain string cause'; // a non-Error cause ENDS the chain (not appended)
    const err = new Error('outer');
    err.stack = undefined; // the head also lacks a stack → the description is the cause chain alone
    err.cause = noStack;
    await client.logException(err);
    const desc = (report.mock.calls[0]?.[0] as ReportingRequest).report.description as string;
    expect(desc).toBe('Caused by: inner'); // head has no stack → just the linked cause (message used)
    expect(desc).not.toContain('a plain string cause'); // the non-Error cause is not chained
  });

  it('bounds the cause chain depth and survives a cyclic cause (no infinite loop)', async () => {
    const { client, report } = withTrigger();
    const a = new Error('a');
    const b = new Error('b');
    a.cause = b;
    b.cause = a; // cycle
    await client.logException(a);
    const desc = (report.mock.calls[0]?.[0] as ReportingRequest).report.description as string;
    // The seen-set breaks the cycle: `b` is linked once, then `a` (already seen) stops the walk.
    expect(desc.match(/Caused by: /g)?.length).toBe(1);
  });

  it('caps the linked cause chain at MAX_CAUSE_DEPTH (5)', async () => {
    const { client, report } = withTrigger();
    // A 7-deep distinct chain: head + 7 causes; only the first 5 causes are linked.
    let tip = new Error('c7');
    for (let i = 6; i >= 1; i--) {
      const next = new Error(`c${i}`);
      next.cause = tip;
      tip = next;
    }
    const head = new Error('head');
    head.cause = tip;
    await client.logException(head);
    const desc = (report.mock.calls[0]?.[0] as ReportingRequest).report.description as string;
    expect(desc.match(/Caused by: /g)?.length).toBe(5); // capped
  });

  it('omits the description for an Error with no stack and no cause', async () => {
    const { client, report } = withTrigger();
    const err = new Error('stackless');
    err.stack = undefined;
    await client.logException(err);
    const request = report.mock.calls[0]?.[0] as ReportingRequest;
    expect(request.report.summary).toBe('stackless'); // summary still set from the message
    expect(request.report.description).toBeUndefined(); // but no description (no stack, no cause)
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
    expect(await client.logException(new Error('after-stop'))).toEqual({ ok: false });
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
    await asInternalClient(client).logException(new Error('x'), {
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

describe('createClient — kill-state (collector KILL_SDK)', () => {
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
  // The kill-state is the collector's KILL_SDK verdict (99099), NOT an HTTP 401 and NOT an invalid
  // app token (which is 14019 → `permanent`). `code` is 0 because no HTTP status carried it.
  const fatal = () => new BugseeError('sdk switched off', 0, { fatal: true, serverCode: 99_099 });

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
    expect(client.getStatus()).toBe(BugseeStatus.Stopped); // a killed SDK is not 'Launched'
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

// an incident drains only the faulting TENANT.
//
// The client-level statement of the leak proven on real workerd, where tenant C's bundle carried tenant
// A's and B's secrets. Store, aggregator and exporter are all REAL
// here — only the context provider is driven, standing in for per-DO contexts in one isolate.
describe('createClient — per-tenant capture isolation', () => {
  it('an incident in one tenant enqueues that tenant only', async () => {
    let current: RequestContext | undefined;
    const store = createPartitionedCaptureStore({
      createPartition: () => createMemoryCaptureStore(),
    });
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      captureStore: store,
      contextProvider: { getCurrent: () => current },
    });

    current = { contextId: 'ca', owner: 'tenant-A' };
    client.log('SECRET-OF-A');
    current = { contextId: 'cb', owner: 'tenant-B' };
    client.log('SECRET-OF-B');
    current = { contextId: 'cc', owner: 'tenant-C' };
    client.log('INCIDENT-IN-C');
    await client.logException(new Error('boom in C'));

    const bundle = enqueue.mock.calls[0]?.[0] as { body: Uint8Array };
    const files = unzipSync(bundle.body) as Record<string, Uint8Array>;
    const text = Object.values(files)
      .map((b) => strFromU8(b))
      .join('\n');
    expect(text).toContain('INCIDENT-IN-C');
    expect(text).not.toContain('SECRET-OF-A');
    expect(text).not.toContain('SECRET-OF-B');
  });

  it('a prepared upload freezes only the tenant it was prepared in', async () => {
    let current: RequestContext | undefined;
    const store = createPartitionedCaptureStore({
      createPartition: () => createMemoryCaptureStore(),
    });
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      captureStore: store,
      contextProvider: { getCurrent: () => current },
    });
    current = { contextId: 'ca', owner: 'tenant-A' };
    client.log('SECRET-OF-A');
    current = { contextId: 'cc', owner: 'tenant-C' };
    client.log('MINE-IN-C');

    await client.prepareUpload()?.send({ summary: 'from C' });

    const files = unzipSync((enqueue.mock.calls[0]?.[0] as { body: Uint8Array }).body) as Record<
      string,
      Uint8Array
    >;
    const text = Object.values(files)
      .map((b) => strFromU8(b))
      .join('\n');
    expect(text).toContain('MINE-IN-C');
    expect(text).not.toContain('SECRET-OF-A');
  });

  it('with no owners in play, the bundle still carries everything (single-tenant unchanged)', async () => {
    const store = createPartitionedCaptureStore({
      createPartition: () => createMemoryCaptureStore(),
    });
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      captureStore: store,
    });
    client.log('FIRST');
    client.log('SECOND');
    await client.logException(new Error('boom'));
    const bundle = enqueue.mock.calls[0]?.[0] as { body: Uint8Array };
    const files = unzipSync(bundle.body) as Record<string, Uint8Array>;
    const text = Object.values(files)
      .map((b) => strFromU8(b))
      .join('\n');
    expect(text).toContain('FIRST');
    expect(text).toContain('SECOND');
  });
});

describe('createClient — upload (manual report)', () => {
  const upload = () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });
    const sent = (): Bundle['request'] => (enqueue.mock.calls[0]?.[0] as Bundle).request;
    return { client, enqueue, sent };
  };

  it('reports with the code_upload trigger and the supplied fields', async () => {
    const { client, sent } = upload();

    const result = await client.upload({
      summary: 'Checkout is stuck',
      description: 'Spinner never stops',
      severity: 'critical',
      labels: ['checkout', 'payments'],
      email: 'jane@example.com',
    });

    expect(result).toEqual({ ok: true });
    expect(sent().source.type).toBe('code_upload');
    expect(sent().summary).toBe('Checkout is stuck');
    expect(sent().description).toBe('Spinner never stops');
    expect(sent().labels).toEqual(['checkout', 'payments']);
    expect(sent().email).toBe('jane@example.com');
    expect(sent().severity).toBe(4); // critical on the wire
  });

  it('attaches UploadOptions.attachments to the uploaded bundle and drops over-limit ones to onError', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const onError = vi.fn();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment, onError });

    await client.upload({
      attachments: [
        { name: 'one', data: 'a' },
        { name: 'two', data: 'b' },
        { name: 'three', data: 'c' },
        { name: 'four', data: 'd' },
      ],
    });

    const bundle = enqueue.mock.calls[0]?.[0] as Bundle;
    const files = unzipSync(bundle.body) as Record<string, Uint8Array>;
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array));
    const names = manifest.files
      .filter((f: { type: string }) => f.type === 'attachment')
      .map((f: { name: string }) => f.name);
    expect(names).toEqual(['one', 'two', 'three']);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a THROWING user onError never loses a report that carries a bad attachment (R2P-6)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const onError = vi.fn(() => {
      throw new Error('the app\u2019s onError is broken');
    });
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment, onError });

    const result = await client.upload({
      attachments: [
        { name: 'ok', data: 'fine' },
        { name: '', data: 'x' },
        'junk',
        { name: 'x', data: 'y', fileName: 42 },
      ],
    } as never);

    expect(result.ok).toBe(true);
    const bundle = enqueue.mock.calls[0]?.[0] as Bundle;
    const files = unzipSync(bundle.body) as Record<string, Uint8Array>;
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array));
    const names = manifest.files
      .filter((f: { type: string }) => f.type === 'attachment')
      .map((f: { name: string }) => f.name);
    expect(names).toEqual(['ok', 'x']);
    expect(onError).toHaveBeenCalled();
  });

  it('a throwing onError and a FROZEN report (limits cannot be applied at submit) still deliver (R2P-6)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const onError = vi.fn(() => {
      throw new Error('the app\u2019s onError is broken');
    });
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment, onError });
    client.setReportHandler({
      before: (request) => {
        Object.freeze(request.report.userAttachments);
        Object.freeze(request.report);
        return request;
      },
    });

    const result = await client.upload({
      attachments: [
        { name: 'ok', data: 'fine' },
        { name: '', data: 'x' },
      ],
    } as never);

    expect(result.ok).toBe(true);
    const bundle = enqueue.mock.calls[0]?.[0] as Bundle;
    const files = unzipSync(bundle.body) as Record<string, Uint8Array>;
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array));
    expect(
      manifest.files
        .filter((f: { type: string }) => f.type === 'attachment')
        .map((f: { name: string }) => f.name),
    ).toEqual(['ok']);
  });

  it('delivers the report for a plain-JS attachment with a non-string fileName (P2)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const onError = vi.fn();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment, onError });

    const result = await client.upload({
      attachments: [{ name: 'x', data: 'y', fileName: 42 }],
    } as never);

    expect(result.ok).toBe(true);
    const bundle = enqueue.mock.calls[0]?.[0] as Bundle;
    const files = unzipSync(bundle.body) as Record<string, Uint8Array>;
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array));
    const entry = manifest.files.find((f: { type: string }) => f.type === 'attachment');
    expect(entry.attrs.fileName).toBe('x');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('persists attachments in the recovery marker already limited and JSON-safe (P1)', async () => {
    const { uploadPipeline } = fakeUpload();
    const { store, put } = fakeMarkers();
    const onError = vi.fn();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      onError,
      reportMarkers: { store, generation: 1 },
    });
    const bytes = new Uint8Array([0, 7, 255]);

    await client.upload({
      attachments: [
        { name: 'bin', data: bytes },
        { name: 'huge', data: new Uint8Array(3 * 1024 * 1024 + 1) },
        { name: 'bad', data: 'x', fileName: 42 as never },
      ],
    });

    const marker = put.mock.calls[0]?.[0] as ReportMarker;
    const wire = JSON.stringify(marker);
    expect(wire.length).toBeLessThan(2000); // the 3 MB attachment never reached the marker
    const back = decodeRequestFromMarker(JSON.parse(wire).request, vi.fn());
    const names = back.report.userAttachments?.map((a) => a.name);
    expect(names).toEqual(['bin', 'bad']);
    expect(Array.from(back.report.userAttachments?.[0]?.data as Uint8Array)).toEqual([0, 7, 255]);
    expect(onError).toHaveBeenCalledTimes(2); // the oversize one and the bad fileName, once each
  });

  it('still delivers a report whose handler froze it (attachment normalisation cannot assign) (P2)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const onError = vi.fn();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment, onError });
    client.setReportHandler({
      before: (request) => {
        Object.freeze(request.report);
        return request;
      },
    });
    const result = await client.upload({ attachments: [{ name: 'a', data: 'x' }] });
    expect(result.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('what ReportHandler.after adds reaches the recovery marker: a recovered report equals the live one (R2P-7)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const { store, put } = fakeMarkers();
    const wires: string[] = []; // what a real store would have serialised AT each put
    put.mockImplementation((marker) => {
      wires.push(JSON.stringify(marker));
    });
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });
    client.setReportHandler({
      after: (request) => {
        request.report.summary = 'edited-by-after';
        request.report.labels.push('late-label');
        addReportAttachment(request.report, { name: 'late.bin', data: new Uint8Array([9, 8, 7]) });
        // Over the limit: the marker must stay bounded however late the attachment arrives.
        addReportAttachment(request.report, {
          name: 'huge',
          data: new Uint8Array(3 * 1024 * 1024 + 1),
        });
      },
    });

    client.setAttribute('k', 1);
    client.setUserIdentifier('u@e.com');
    await client.upload({ summary: 'original' });

    const live = (enqueue.mock.calls[0]?.[0] as Bundle).request;
    expect(live.summary).toBe('edited-by-after');
    const markers = wires.map((w) => JSON.parse(w) as ReportMarker);
    expect(markers).toHaveLength(2); // the submit-time marker, then the one carrying what `after` did
    const last = markers[1] as ReportMarker;
    expect(wires[1]?.length).toBeLessThan(2000); // 3 MB never reached the marker
    const recovered = decodeRequestFromMarker(last.request, vi.fn());
    expect(recovered.report.summary).toBe(live.summary);
    expect(recovered.report.labels).toEqual(live.labels);
    expect(recovered.report.userAttachments?.map((a) => a.name)).toEqual(['late.bin']);
    expect(last.attributes).toEqual(markers[0]?.attributes);
    expect(last.attributes).toEqual({ k: 1 });
    expect(last.userIdentifier).toBe('u@e.com');
    expect(markers[0]?.request.report.summary).toBe('original'); // what was persisted FIRST
  });

  it('does not rewrite the marker when there is no `after` handler, or the write throws (R2P-7)', async () => {
    const { uploadPipeline } = fakeUpload();
    const { store, put } = fakeMarkers();
    const onError = vi.fn();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      onError,
      reportMarkers: { store, generation: 1 },
    });
    await client.upload({ summary: 'plain' });
    expect(put).toHaveBeenCalledTimes(1);

    client.setReportHandler({
      after: (request) => {
        request.report.summary = 'edited';
      },
    });
    put.mockImplementationOnce(() => {}); // the submit-time write succeeds ...
    put.mockImplementationOnce(() => {
      throw new Error('disk full'); // ... the rewrite fails: reported, never fatal
    });
    const result = await client.upload({ summary: 'second' });
    expect(result.ok).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }));
  });

  it('an `after` handler that changes nothing leaves the marker written once (R3P-7)', async () => {
    const { uploadPipeline } = fakeUpload();
    const { store, put } = fakeMarkers();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });
    const after = vi.fn();
    client.setReportHandler({ after });
    await client.upload({
      summary: 's',
      description: 'd',
      labels: ['l'],
      attachments: [{ name: 'a', data: 'xyz' }],
    });
    expect(after).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('a binary attachment that changes size rewrites the marker (R3P-7)', async () => {
    const { uploadPipeline } = fakeUpload();
    const { store, put } = fakeMarkers();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });
    client.setReportHandler({
      after: (request) => {
        if (request.report.userAttachments) {
          const old = request.report.userAttachments[0] as ReportAttachmentInput;
          request.report.userAttachments[0] = { ...old, data: new Uint8Array(8) }; // same name/type, only the size differs
        }
      },
    });
    await client.upload({ summary: 's', attachments: [{ name: 'a', data: new Uint8Array(3) }] });
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('an unreadable report (signature throws) is treated as changed and rewritten (R3P-7)', async () => {
    const { uploadPipeline } = fakeUpload();
    const { store, put } = fakeMarkers();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      onError: () => {},
      reportMarkers: { store, generation: 1 },
    });
    client.setReportHandler({
      before: (request) => {
        request.report.attributes.big = BigInt(1) as never; // JSON.stringify throws on a BigInt
        return request;
      },
      after: () => {},
    });
    await client.upload({ summary: 's' });
    expect(put).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'summary',
      (r: Report) => {
        r.summary = 'changed';
      },
    ],
    [
      'description',
      (r: Report) => {
        r.description = 'changed';
      },
    ],
    [
      'labels',
      (r: Report) => {
        r.labels.push('new');
      },
    ],
    [
      'attributes',
      (r: Report) => {
        r.attributes.extra = 1;
      },
    ],
    [
      'attachment count',
      (r: Report) => {
        addReportAttachment(r, { name: 'b', data: 'q' });
      },
    ],
    [
      'attachment size',
      (r: Report) => {
        if (r.userAttachments) r.userAttachments[0] = { name: 'a', data: 'longer-data' };
      },
    ],
    [
      'severity',
      (r: Report) => {
        r.severity = 'low';
      },
    ],
    [
      'email',
      (r: Report) => {
        r.email = 'x@y.z';
      },
    ],
    [
      'type',
      (r: Report) => {
        r.type = 'crash';
      },
    ],
    [
      'attachment name',
      (r: Report) => {
        if (r.userAttachments)
          r.userAttachments[0] = {
            ...(r.userAttachments[0] as ReportAttachmentInput),
            name: 'renamed',
          };
      },
    ],
    [
      'attachment mimeType',
      (r: Report) => {
        if (r.userAttachments)
          r.userAttachments[0] = {
            ...(r.userAttachments[0] as ReportAttachmentInput),
            mimeType: 'text/x',
          };
      },
    ],
    [
      'attachment fileName',
      (r: Report) => {
        if (r.userAttachments)
          r.userAttachments[0] = {
            ...(r.userAttachments[0] as ReportAttachmentInput),
            fileName: 'f.txt',
          };
      },
    ],
    [
      'signatures',
      (r: Report) => {
        r.signatures.push('sig');
      },
    ],
    [
      'crash frame count',
      (r: Report) => {
        const crash = r.crash as { exception: { frames: unknown[] } };
        crash.exception.frames.pop();
      },
    ],
    [
      'crash frame locals',
      (r: Report) => {
        const crash = r.crash as { exception: { frames: { variables?: unknown }[] } };
        for (const f of crash.exception.frames) f.variables = { scrubbed: '1' };
      },
    ],
    [
      'crash cause chain frame locals (R5H-1)',
      (r: Report) => {
        const cause = (r.crash as { exception: { cause?: { frames: { variables?: unknown }[] } } })
          .exception.cause;
        for (const f of cause?.frames ?? []) delete f.variables;
      },
    ],
    [
      'crash cause reason (R5H-1)',
      (r: Report) => {
        (r.crash as { exception: { cause: { reason: string } } }).exception.cause.reason =
          'scrubbed';
      },
    ],
    [
      'crash exception name (R5H-1)',
      (r: Report) => {
        (r.crash as { exception: { name: string } }).exception.name = 'Scrubbed';
      },
    ],
    [
      'crash domain (R5H-1)',
      (r: Report) => {
        (r.crash as unknown as { domain: string }).domain = 'scrubbed';
      },
    ],
    [
      'same-length string attachment (masked with *) (R5H-2)',
      (r: Report) => {
        if (r.userAttachments)
          r.userAttachments[0] = {
            ...(r.userAttachments[0] as ReportAttachmentInput),
            data: '***',
          };
      },
    ],
    [
      'same-length binary attachment (fill(0)) (R5H-2)',
      (r: Report) => {
        const bin = r.userAttachments?.[1]?.data;
        if (bin instanceof Uint8Array) bin.fill(0);
      },
    ],
    [
      'SDK attachment removed (R5H-2)',
      (r: Report) => {
        r.attachments = undefined;
      },
    ],
    [
      'SDK attachment bytes zeroed in place, same length (R5H-2)',
      (r: Report) => {
        const dmp = r.attachments?.[0]?.data;
        if (dmp instanceof Uint8Array) dmp.fill(0);
      },
    ],
    [
      'crash exception message',
      (r: Report) => {
        (r.crash as { exception: { reason?: string } }).exception.reason = 'scrubbed';
      },
    ],
  ])('an `after` handler that changes the %s rewrites the marker (R3P-7)', async (_name, mutate) => {
    const { uploadPipeline } = fakeUpload();
    const { store, put } = fakeMarkers();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });
    client.setReportHandler({
      before: (request) => {
        // Every row starts from a report that carries a crash (the crash rows edit it in place).
        request.report.crash = {
          exception_type: 'error',
          ndkCrash: false,
          handled: true,
          exception: {
            name: 'Error',
            reason: 'boom',
            frames: [{ trace: 'at a' }, { trace: 'at b' }],
            cause: {
              name: 'Error',
              reason: 'inner',
              frames: [{ trace: 'at c', variables: { password: 'hunter2' } }],
            },
          },
          domain: 'orig',
        } as unknown as Report['crash'];
        request.report.attachments = [{ name: 'crash.dmp', data: new Uint8Array([7, 8, 9]) }];
        return request;
      },
      after: (request) => mutate(request.report),
    });
    await client.upload({
      summary: 's',
      description: 'd',
      labels: ['l'],
      attachments: [
        { name: 'a', data: 'xyz' },
        { name: 'b', data: new Uint8Array([1, 2, 3]) },
      ],
    });
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('a scrubbing `after` leaves the marker holding the SCRUBBED crash (R4H-1)', async () => {
    const { uploadPipeline } = fakeUpload();
    const { store, put } = fakeMarkers();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      reportMarkers: { store, generation: 1 },
    });
    client.setReportHandler({
      before: (request) => {
        request.report.crash = {
          exception_type: 'error',
          ndkCrash: false,
          handled: true,
          exception: {
            name: 'Error',
            reason: 'boom',
            frames: [{ trace: 'at f', variables: { password: 'hunter2' } }],
          },
        } as unknown as Report['crash'];
        return request;
      },
      after: (request) => {
        const crash = request.report.crash as {
          exception: { frames: { variables?: unknown }[] };
        };
        for (const f of crash.exception.frames) delete f.variables;
      },
    });
    await client.upload({ summary: 's' });
    expect(put).toHaveBeenCalledTimes(2);
    const last = put.mock.calls[1]?.[0] as ReportMarker;
    expect(JSON.stringify(last.request.report.crash)).not.toContain('hunter2');
  });

  it('a hostile report (throwing Proxy) never loses the report at the marker limit step (R3P-8)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const { store } = fakeMarkers();
    const onError = vi.fn();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      onError,
      reportMarkers: { store, generation: 1 },
    });
    client.setReportHandler({
      before: (request) => {
        // Frozen: normalisation cannot assign, so the marker falls back to limiting a COPY, which a
        // throwing ownKeys then breaks.
        Object.freeze(request.report);
        const hostile = new Proxy(request.report, {
          ownKeys: () => {
            throw new Error('hostile ownKeys');
          },
        });
        return { ...request, report: hostile };
      },
    });
    const result = await client.upload({
      summary: 'x',
      attachments: [{ name: 'a', data: 'x' }],
    });
    expect(result.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'hostile ownKeys' }));
  });

  it('a limit step that throws persists NO user attachments in the marker (fail closed, R4H-6)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const { store, put } = fakeMarkers();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      onError: () => {},
      reportMarkers: { store, generation: 1 },
    });
    client.setReportHandler({
      before: (request) => {
        Object.freeze(request.report);
        // Throws on the FIRST enumeration only (the limit step); encodable afterwards.
        let calls = 0;
        const flaky = new Proxy(request.report, {
          ownKeys: (target) => {
            calls += 1;
            if (calls === 1) throw new Error('flaky ownKeys');
            return Reflect.ownKeys(target);
          },
        });
        return { ...request, report: flaky };
      },
    });
    await client.upload({ summary: 'x', attachments: [{ name: 'a', data: 'secret-bytes' }] });
    const marker = put.mock.calls[0]?.[0] as ReportMarker;
    expect(marker.request.report.userAttachments).toEqual([]);
    expect(JSON.stringify(marker)).not.toContain('secret-bytes');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('a report that cannot even be copied persists no marker, and is still uploaded (R4H-6)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const onError = vi.fn();
    const { store, put } = fakeMarkers();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      onError,
      reportMarkers: { store, generation: 1 },
    });
    client.setReportHandler({
      before: (request) => {
        Object.freeze(request.report);
        const hostile = new Proxy(request.report, {
          ownKeys: () => {
            throw new Error('hostile ownKeys');
          },
        });
        return { ...request, report: hostile };
      },
    });
    await client.upload({ summary: 'x', attachments: [{ name: 'a', data: 'secret-bytes' }] });
    expect(put).not.toHaveBeenCalled();
    // normalise, limit, copy: nothing was ever handed to the encoder (it would add a 4th report)
    expect(onError).toHaveBeenCalledTimes(3);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('a report that cannot be copied (no marker persisted) still raises the unrecoverable warning when the upload fails (R5H-3)', async () => {
    const { store, put, remove } = fakeMarkers();
    const onError = vi.fn();
    const client = createClient({
      uploadPipeline: {
        enqueue: vi.fn<UploadPipeline['enqueue']>(async () => ({ ok: false })), // retryable, nothing retained
        flush: vi.fn(async () => true),
        drop: vi.fn(),
      },
      appToken: 'tok',
      getEnvironment,
      onError,
      reportMarkers: { store, generation: 1 },
    });
    client.setReportHandler({
      before: (request) => {
        Object.freeze(request.report);
        const hostile = new Proxy(request.report, {
          ownKeys: () => {
            throw new Error('hostile ownKeys');
          },
        });
        return { ...request, report: hostile };
      },
    });
    await client.upload({ summary: 'x', attachments: [{ name: 'a', data: 'secret-bytes' }] });
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('unrecoverable') }),
      ),
    );
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('a rejected asynchronous marker rewrite is reported, not unhandled (R2P-7)', async () => {
    const { uploadPipeline } = fakeUpload();
    const { store, put } = fakeMarkers();
    const onError = vi.fn();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      onError,
      reportMarkers: { store, generation: 1 },
    });
    client.setReportHandler({
      after: (request) => {
        request.report.summary = 'edited';
      },
    });
    put.mockResolvedValueOnce(undefined);
    put.mockRejectedValueOnce(new Error('idb quota'));
    const result = await client.upload({ summary: 'x' });
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(result.ok).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'idb quota' }));
  });

  it('a FROZEN report still gets its attachments limited before the marker encodes them (R2P-9)', async () => {
    const { uploadPipeline } = fakeUpload();
    const { store, put } = fakeMarkers();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      onError: () => {},
      reportMarkers: { store, generation: 1 },
    });
    client.setReportHandler({
      before: (request) => {
        Object.freeze(request.report);
        return request;
      },
    });

    await client.upload({
      attachments: [
        { name: 'a', data: new Uint8Array([1, 2, 3]) },
        { name: 'huge', data: new Uint8Array(3 * 1024 * 1024 + 1) },
        { name: 'b', data: 'two' },
        { name: 'c', data: 'three' },
        { name: 'd', data: 'four' },
      ],
    });

    const marker = put.mock.calls[0]?.[0] as ReportMarker;
    const wire = JSON.stringify(marker);
    expect(wire.length).toBeLessThan(2000); // 4 MB of base64 never reached the marker
    const back = decodeRequestFromMarker(JSON.parse(wire).request, vi.fn());
    expect(back.report.userAttachments?.map((a) => a.name)).toEqual(['a', 'b', 'c']);
  });

  it('lets ReportHandler.before add attachments with addReportAttachment', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });
    client.setReportHandler({
      before: (request) => {
        addReportAttachment(request.report, {
          name: 'state.json',
          data: '{"a":1}',
          mimeType: 'application/json',
        });
        return request;
      },
    });

    await client.upload();

    const bundle = enqueue.mock.calls[0]?.[0] as Bundle;
    const files = unzipSync(bundle.body) as Record<string, Uint8Array>;
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array));
    const entry = manifest.files.find((f: { type: string }) => f.type === 'attachment');
    expect(entry.attrs.mimeType).toBe('application/json');
    expect(strFromU8(files[entry.filename] as Uint8Array)).toBe('{"a":1}');
  });

  it('defaults to a high-severity bug with nothing else set', async () => {
    const { client, sent } = upload();

    await client.upload();

    expect(sent().type).toBe('bug');
    expect(sent().severity).toBe(3); // high
    expect(sent().summary).toBe('Bug Report'); // the assembler's default title, not an empty one
  });

  it('marks a report from the dialog with the code_dialog trigger', async () => {
    const { client, sent } = upload();

    await asInternalClient(client).upload({ trigger: 'code_dialog', summary: 's' });

    expect(sent().source.type).toBe('code_dialog');
  });

  it('asInternalClient reaches the wire-level trigger through the public type', async () => {
    const { client, sent } = upload();
    const publicClient: BugseeClient = client;

    await asInternalClient(publicClient).upload({ trigger: 'code_dialog', summary: 's' });

    expect(sent().source.type).toBe('code_dialog');
  });

  it('is not instance-deduped or rate-limited: every explicit request is a report', async () => {
    const { client, enqueue } = upload();

    for (let i = 0; i < 25; i += 1) {
      await client.upload({ summary: `report ${i}` });
    }

    expect(enqueue).toHaveBeenCalledTimes(25);
  });

  it('runs the report handler: before can mutate the report or veto it', async () => {
    const { client, enqueue, sent } = upload();
    client.setReportHandler({
      before: (r) => {
        r.report.summary = 'masked';
        return r;
      },
    });
    await client.upload({ summary: 'private' });
    expect(sent().summary).toBe('masked');

    client.setReportHandler({ before: () => null });
    expect(await client.upload({ summary: 'vetoed' })).toEqual({ ok: false });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('is a silent no-op after stop()', async () => {
    const { client, enqueue } = upload();
    client.launch();
    await client.stop();

    expect(await client.upload({ summary: 'late' })).toEqual({ ok: false });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('createClient — prepareUpload (capture frozen at preparation)', () => {
  const setup = () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({
      captureStore: store,
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
    });
    const log = (msg: string, at: number) =>
      client.captureAggregator.addEntry(new CaptureDataEntryBase('log', at, { msg }));
    const sentLogs = (): string[] => {
      const files = unzipSync((enqueue.mock.calls[0]?.[0] as Bundle).body);
      const raw = files['logs.json'];
      return raw === undefined
        ? []
        : (JSON.parse(strFromU8(raw)) as Array<{ msg: string }>).map((e) => e.msg);
    };
    return { client, enqueue, log, sentLogs };
  };

  it('sends the capture as it was when prepared, not as it is when sent', async () => {
    const { client, log, sentLogs } = setup();
    log('before the dialog', 1);

    const prepared = client.prepareUpload();
    log('typed into the dialog', 2);
    await prepared?.send({ summary: 'bug', trigger: 'code_dialog' });

    expect(sentLogs()).toEqual(['before the dialog']);
  });

  it('builds the same report fields as upload()', async () => {
    const { client, enqueue } = setup();
    const prepared = asInternalClient(client).prepareUpload();

    await prepared?.send({
      summary: 's',
      description: 'd',
      severity: 'critical',
      labels: ['x'],
      email: 'a@b.co',
      trigger: 'code_dialog',
    });

    const request = JSON.parse(
      strFromU8(
        unzipSync((enqueue.mock.calls[0]?.[0] as Bundle).body)['request.json'] as Uint8Array,
      ),
    ) as Record<string, unknown>;
    expect(request).toMatchObject({
      summary: 's',
      description: 'd',
      severity: 4,
      labels: ['x'],
      email: 'a@b.co',
    });
    expect((request.source as { type: string }).type).toBe('code_dialog');
  });

  it('runs the report handler at send time, and a veto still vetoes', async () => {
    const { client, enqueue } = setup();
    client.setReportHandler({ before: () => null });
    const prepared = client.prepareUpload();

    expect(await prepared?.send({ summary: 'x' })).toEqual({ ok: false });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('sends at most once, and not after a discard', async () => {
    const { client, enqueue } = setup();
    const first = client.prepareUpload();
    await first?.send();
    expect(await first?.send()).toEqual({ ok: false });
    expect(enqueue).toHaveBeenCalledTimes(1);

    const second = client.prepareUpload();
    second?.discard();
    expect(await second?.send()).toEqual({ ok: false });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('is unavailable after stop()', async () => {
    const { client } = setup();
    client.launch();
    await client.stop();

    expect(client.prepareUpload()).toBeNull();
  });

  it('still prepares and reports ok:false on a client with no upload pipeline', async () => {
    const client = createClient();

    expect(await client.prepareUpload()?.send({ summary: 'nowhere to go' })).toEqual({ ok: false });
  });

  it('prepares even when the context provider throws (a broken binding never breaks reporting)', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
      contextProvider: {
        getCurrent: () => {
          throw new Error('binding broke');
        },
      },
    });

    expect(await client.prepareUpload()?.send({ summary: 'ok' })).toEqual({ ok: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('falls back to a live drain when the frozen capture could not be read', async () => {
    const { client, enqueue } = setup();
    const store = client.getService(CaptureStoreToken);
    vi.spyOn(store, 'snapshot').mockImplementationOnce(() => {
      throw new Error('snapshot failed');
    });
    const prepared = client.prepareUpload();

    const result = await prepared?.send({ summary: 'still sent' });

    expect(result).toEqual({ ok: true });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('createClient — blackout', () => {
  it('starts not blacked out', () => {
    expect(createClient().isBlackout()).toBe(false);
  });

  it('startBlackout()/endBlackout() toggle isBlackout()', () => {
    const client = createClient();
    client.launch();
    client.startBlackout();
    expect(client.isBlackout()).toBe(true);
    client.endBlackout();
    expect(client.isBlackout()).toBe(false);
  });

  it('is idempotent and not counted (one end clears any number of starts)', () => {
    const client = createClient();
    client.launch();
    client.startBlackout();
    client.startBlackout();
    client.endBlackout();
    expect(client.isBlackout()).toBe(false);
  });

  it('publishes the state through the container so providers can subscribe (internal onBlackoutChange)', () => {
    const client = createClient();
    client.launch();
    const seen: boolean[] = [];
    client.getService(BlackoutToken).onChange((active) => seen.push(active));
    client.startBlackout();
    client.startBlackout();
    client.endBlackout();
    expect(seen).toEqual([true, false]);
  });

  it('routes a throwing subscriber to onError without breaking the toggle', () => {
    const onError = vi.fn();
    const client = createClient({ onError });
    client.launch();
    const boom = new Error('boom');
    client.getService(BlackoutToken).onChange(() => {
      throw boom;
    });
    client.startBlackout();
    expect(client.isBlackout()).toBe(true);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('does not suppress non-visual capture (logs/events/traces continue)', async () => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const client = createClient({ captureStore: store });
    client.launch();
    client.startBlackout();
    client.log('still logged');
    client.event('still-evented');
    client.trace('still-traced', 1);
    const drained = await createCaptureExporter(store).drain();
    expect(drained.get('log')).toHaveLength(1);
    expect(drained.get('events.user')).toHaveLength(1);
    expect(drained.get('traces.user')).toHaveLength(1);
  });
});

describe('createClient — mobile-parity options (T6)', () => {
  const memStore = () => createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
  const drain = async (store: CaptureStore, type: FileType) =>
    (await createCaptureExporter(store).drain()).get(type);
  const noScheduler = { setInterval: () => 'h', clearInterval: () => {} };

  describe('captureBreadcrumbs', () => {
    it('drops addBreadcrumb when the option is switched off', async () => {
      const store = memStore();
      const client = createClient({
        captureStore: store,
        clock: fixedClock(1000),
        isEnabled: (key) => key !== 'com.bugsee.option.capture.breadcrumbs',
      });
      client.addBreadcrumb({ message: 'clicked' });
      expect(await drain(store, 'breadcrumbs')).toBeUndefined();
    });

    it('keeps capturing when the option is on (the JS default)', async () => {
      const store = memStore();
      const client = createClient({ captureStore: store, clock: fixedClock(1000) });
      client.addBreadcrumb({ message: 'clicked' });
      expect(await drain(store, 'breadcrumbs')).toHaveLength(1);
    });
  });

  describe('captureLogsLevel', () => {
    const levelled = (level: unknown, onError?: (e: unknown) => void) => {
      const store = memStore();
      const client = createClient({
        captureStore: store,
        clock: fixedClock(1000),
        launchOptions: createOptionsContainer({ 'com.bugsee.option.capture.logs.level': level }),
        ...(onError !== undefined ? { onError } : {}),
      });
      return { store, client };
    };

    it('drops client.log records below the level and keeps the rest', async () => {
      const { store, client } = levelled('warning');
      client.log('chatty', 'info');
      client.log('verbose-ish', 'debug');
      client.log('bad', 'error');
      client.log('careful', 'warning');
      const messages = (await drain(store, 'log'))?.map(
        (e) => (e.data as { message: string }).message,
      );
      expect(messages).toEqual(['bad', 'careful']);
    });

    it('also applies to a numeric wire level', async () => {
      const { store, client } = levelled('error');
      client.log('x', 3 as unknown as 'info');
      expect(await drain(store, 'log')).toBeUndefined();
    });

    it('captures everything by default (verbose)', async () => {
      const store = memStore();
      const client = createClient({ captureStore: store, clock: fixedClock(1000) });
      client.log('v', 'verbose');
      expect(await drain(store, 'log')).toHaveLength(1);
    });

    it('warns through onError and falls back to verbose on an unknown level', async () => {
      const onError = vi.fn();
      const { store, client } = levelled('chatty', onError);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(String((onError.mock.calls[0]?.[0] as Error).message)).toBe(
        'captureLogsLevel must be one of error | warning | info | debug | verbose (got chatty); using verbose',
      );
      client.log('v', 'verbose');
      expect(await drain(store, 'log')).toHaveLength(1);
    });
  });

  describe('reportDefaultCrashPriority / reportDefaultErrorPriority', () => {
    const configured = (values: Record<string, unknown>, onError?: (e: unknown) => void) => {
      const report = vi.fn<TriggerPipeline['report']>(async () => ({ ok: true }));
      const provider = detectionProvider('d');
      const client = createClient({
        triggerPipeline: { report } as TriggerPipeline,
        launchOptions: createOptionsContainer(values),
        scheduler: noScheduler,
        ...(onError !== undefined ? { onError } : {}),
      });
      client.addDetectionProvider(provider);
      client.launch();
      const sink = (provider.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as (
        r: ReportingRequest,
      ) => void;
      return { client, report, sink };
    };
    const CRASH = 'com.bugsee.option.reporting.defaults.crash-priority';
    const ERROR = 'com.bugsee.option.reporting.defaults.error-priority';
    const severities = (report: { mock: { calls: unknown[][] } }) =>
      report.mock.calls.map((c) => (c[0] as ReportingRequest).report.severity);

    it('applies the configured crash priority to a detected crash with no explicit severity', () => {
      const { report, sink } = configured({ [CRASH]: 'critical' });
      sink(createReportingRequest({ source: { type: 'crash', mechanism: 'uncaught' } }));
      expect(severities(report)).toEqual(['critical']);
    });

    it('applies the configured error priority to a detected error and to logException', async () => {
      const { client, report, sink } = configured({ [ERROR]: 'low' });
      sink(createReportingRequest({ source: { type: 'error' } }));
      await client.logException(new Error('x'));
      expect(severities(report)).toEqual(['low', 'low']);
    });

    it('lets an explicit per-call severity win over the configured default', async () => {
      const { client, report, sink } = configured({ [ERROR]: 'low', [CRASH]: 'low' });
      sink(createReportingRequest({ source: { type: 'crash' }, severity: 'blocker' }));
      await client.logException(new Error('x'), { severity: 'critical' });
      expect(severities(report)).toEqual(['blocker', 'critical']);
    });

    it('keeps the mobile defaults (crash blocker, error high) when unconfigured', async () => {
      const { client, report, sink } = configured({});
      sink(createReportingRequest({ source: { type: 'crash' } }));
      await client.logException(new Error('x'));
      expect(severities(report)).toEqual(['blocker', 'high']);
    });

    it('does not touch a bug-type report (that default is reportDefaultBugPriority)', async () => {
      const { client, report } = configured({ [CRASH]: 'low', [ERROR]: 'low' });
      await client.upload({});
      expect(severities(report)).toEqual(['high']);
    });

    // Android applies ReportingDefaultBugPriority to EVERY bug report, not only the browser dialog's.
    const BUG = 'com.bugsee.option.reporting.defaults.bug-priority';

    it('applies reportDefaultBugPriority to client.upload() and to a detected bug-type report', async () => {
      const { client, report, sink } = configured({ [BUG]: 'critical' });
      await client.upload({});
      sink(createReportingRequest({ source: { type: 'shake' } }));
      expect(severities(report)).toEqual(['critical', 'critical']);
    });

    it('does not apply the bug priority to crash / error reports', async () => {
      const { client, report, sink } = configured({ [BUG]: 'low' });
      sink(createReportingRequest({ source: { type: 'crash' } }));
      await client.logException(new Error('x'));
      expect(severities(report)).toEqual(['blocker', 'high']);
    });

    it('an explicit upload severity beats the bug priority; the handler still rewrites it', async () => {
      const { client, report } = configured({ [BUG]: 'low' });
      await client.upload({ severity: 'blocker' });
      client.setReportHandler({
        before: (request) => {
          request.report.severity = 'medium';
          return request;
        },
      });
      await client.upload({});
      expect(severities(report)).toEqual(['blocker', 'medium']);
    });

    it('an invalid bug priority reports once (naming verylow) and uses high', async () => {
      const onError = vi.fn();
      const { client, report } = configured({ [BUG]: 'urgent' }, onError);
      expect(onError.mock.calls.map((c) => String((c[0] as Error).message))).toEqual([
        'reportDefaultBugPriority must be one of verylow | low | medium | high | critical | blocker (got urgent); using high',
      ]);
      await client.upload({});
      expect(severities(report)).toEqual(['high']);
    });

    it('lets the report handler still rewrite the severity afterwards', () => {
      const { client, report, sink } = configured({ [CRASH]: 'low' });
      client.setReportHandler({
        before: (request) => {
          request.report.severity = 'medium';
          return request;
        },
      });
      sink(createReportingRequest({ source: { type: 'crash' } }));
      expect(severities(report)).toEqual(['medium']);
    });

    it('warns through onError and falls back to the mobile default for an invalid value', () => {
      const onError = vi.fn();
      const { report, sink } = configured({ [CRASH]: 'urgent', [ERROR]: 7 }, onError);
      const messages = onError.mock.calls.map((c) => String((c[0] as Error).message));
      expect(messages).toEqual([
        'reportDefaultCrashPriority must be one of verylow | low | medium | high | critical | blocker (got urgent); using blocker',
        'reportDefaultErrorPriority must be one of verylow | low | medium | high | critical | blocker (got 7); using high',
      ]);
      sink(createReportingRequest({ source: { type: 'crash' } }));
      expect(severities(report)).toEqual(['blocker']);
    });
  });
});

describe('createClient — wire-level options are not reachable from the public surface (review O12)', () => {
  const setup = () => {
    // `upload` goes through the upload pipeline, `logException` through the trigger pipeline.
    const { uploadPipeline, enqueue } = fakeUpload();
    const report = vi.fn<TriggerPipeline['report']>(async () => ({ ok: true }));
    const client = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment,
    });
    const logClient = createClient({ triggerPipeline: { report } as TriggerPipeline });
    const sentSource = () => (enqueue.mock.calls[0]?.[0] as Bundle).request.source;
    const reportedSource = () => (report.mock.calls[0]?.[0] as ReportingRequest).source;
    return { client, logClient, sentSource, reportedSource };
  };
  // What plain JavaScript can do: the type system hides these options, the runtime must too.
  const forge = (value: unknown) => value as never;

  it('upload() ignores a forged `trigger` (plain JS cannot file a code_dialog report)', async () => {
    const { client, sentSource } = setup();
    await client.upload(forge({ trigger: 'code_dialog', summary: 's' }));
    expect(sentSource().type).toBe('code_upload');
  });

  it('upload() still honours every public field next to a forged trigger', async () => {
    const { client, enqueue } = (() => {
      const { uploadPipeline, enqueue: e } = fakeUpload();
      return {
        client: createClient({ uploadPipeline, appToken: 'tok', getEnvironment }),
        enqueue: e,
      };
    })();
    await client.upload(forge({ trigger: 'code_dialog', summary: 'kept', labels: ['a'] }));
    const request = (enqueue.mock.calls[0]?.[0] as Bundle).request;
    expect(request.summary).toBe('kept');
    expect(request.labels).toEqual(['a']);
  });

  it('logException() ignores a forged `mechanism`', async () => {
    const { logClient, reportedSource } = setup();
    await logClient.logException(new Error('x'), forge({ mechanism: 'uncaught' }));
    expect(reportedSource()).toEqual({ type: 'error', mechanism: 'programmatic' });
  });

  it('prepareUpload().send() ignores a forged `trigger`', async () => {
    const { client, sentSource } = setup();
    await client.prepareUpload()?.send(forge({ trigger: 'code_dialog' }));
    expect(sentSource().type).toBe('code_upload');
  });

  it('upload() / logException() tolerate a null or non-object options argument', async () => {
    const { client, logClient } = setup();
    await expect(client.upload(forge(null))).resolves.toBeDefined();
    await expect(logClient.logException(new Error('y'), forge('nope'))).resolves.toBeDefined();
  });

  it('asInternalClient keeps the wire-level options: trigger, mechanism and the dialog path', async () => {
    const { client, logClient, sentSource, reportedSource } = setup();
    await asInternalClient(client).upload({ trigger: 'code_dialog', summary: 's' });
    expect(sentSource().type).toBe('code_dialog');
    await asInternalClient(logClient).logException(new Error('z'), { mechanism: 'http-error' });
    expect(reportedSource()).toEqual({ type: 'error', mechanism: 'http-error' });
  });

  it('asInternalClient keeps prepareUpload().send({ trigger }) (the report dialog)', async () => {
    const { client, sentSource } = setup();
    await asInternalClient(client).prepareUpload()?.send({ trigger: 'code_dialog' });
    expect(sentSource().type).toBe('code_dialog');
  });

  it('prepareUpload() is null on a stopped client through both views', async () => {
    const { client } = setup();
    client.launch();
    await client.stop();
    expect(client.prepareUpload()).toBeNull();
    expect(asInternalClient(client).prepareUpload()).toBeNull();
  });

  it('the internal view survives a platform wrapper that spreads the public client', async () => {
    const { client, sentSource } = setup();
    const wrapped: BugseeClient = { ...client, stop: client.stop };
    await asInternalClient(wrapped).upload({ trigger: 'code_dialog', summary: 's' });
    expect(sentSource().type).toBe('code_dialog');
    // ...while the wrapper's own public methods stay stripped.
    await wrapped.upload(forge({ trigger: 'code_dialog' }));
  });

  it('a client that was not created by createClient is returned as is (no brand to unwrap)', () => {
    const plain = { upload: vi.fn() } as unknown as BugseeClient;
    expect(asInternalClient(plain)).toBe(plain);
  });

  it('the public methods do not mutate the caller options object', async () => {
    const { client } = setup();
    const options = { trigger: 'code_dialog', summary: 's' };
    await client.upload(forge(options));
    expect(options).toEqual({ trigger: 'code_dialog', summary: 's' });
  });
});
