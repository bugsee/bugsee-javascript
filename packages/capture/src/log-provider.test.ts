import {
  type CaptureProviderInit,
  type CaptureStore,
  createCaptureAggregator,
  createCaptureCoordinator,
  createCaptureExporter,
  createFilterStore,
  createMemoryCaptureStore,
  createMultiKeyEmitter,
  createOperationDispatcher,
  createOptionsContainer,
  type FilterStore,
  type LogEvent,
  type MultiKeyEmitter,
  type OptionsContainer,
  setCarrierClient,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogCaptureProvider } from './log-provider';

const publishFilters = (store: FilterStore): void => {
  setCarrierClient({
    getService: (token: { name: string }) => (token.name === 'filters' ? store : undefined),
    getServiceProvider: () => undefined as never,
  });
};
afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const mkStore = (): CaptureStore =>
  createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
const buildInit = (store: CaptureStore): CaptureProviderInit => ({
  operations: createOperationDispatcher(),
  captureAggregator: createCaptureAggregator(store),
});
const options: OptionsContainer = createOptionsContainer();
// A standalone log source the test drives via emit (the console interceptor is one such source).
const mkSource = (): MultiKeyEmitter<{ log: LogEvent }> => createMultiKeyEmitter();
const logEvent = (timestamp: number, message: string): LogEvent => ({
  timestamp,
  level: 'warning',
  source: 'console',
  message,
});
const drainLog = async (store: CaptureStore) =>
  (await createCaptureExporter(store).drain()).get('log');

describe('createLogCaptureProvider', () => {
  it('is named "log" and gated by the captureLogs option', () => {
    const p = createLogCaptureProvider(mkSource());
    expect(p.name).toBe('log');
    expect(p.controllingOption).toBe(BugseeOption.CaptureLogs);
  });

  it('routes a source log event to the aggregator as a "log" entry (type/timestamp/data)', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createLogCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    const event = logEvent(5, 'hi');
    source.emit('log', event);
    const entries = await drainLog(store);
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.type).toBe('log');
    expect(entries?.[0]?.timestamp).toBe(5);
    // The entry carries the NUMERIC wire level (Wave 5.1) while the emitted event keeps its friendly
    // name, so this compares against the encoded form rather than the raw event.
    expect(entries?.[0]?.data).toEqual({ ...event, level: 2 });
  });

  it('applies a user log filter (mutate) and drops on null', async () => {
    const store = mkStore();
    const source = mkSource();
    const filters = createFilterStore(vi.fn());
    filters.log = (e) => (e.message.includes('drop') ? null : { ...e, message: 'X' });
    publishFilters(filters);
    const p = createLogCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('log', logEvent(1, 'keep'));
    source.emit('log', logEvent(2, 'please drop'));
    const entries = await drainLog(store);
    expect(entries).toHaveLength(1);
    expect((entries?.[0]?.data as LogEvent).message).toBe('X');
  });

  it('captures multiple events in order', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createLogCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('log', logEvent(1, 'a'));
    source.emit('log', logEvent(2, 'b'));
    expect((await drainLog(store))?.map((e) => (e.data as LogEvent).message)).toEqual(['a', 'b']);
  });

  it('stop unsubscribes: later source events are not captured', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createLogCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    p.stop();
    source.emit('log', logEvent(9, 'after-stop'));
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });

  it('stop before start is a safe no-op', () => {
    const p = createLogCaptureProvider(mkSource());
    p.init(buildInit(mkStore()));
    expect(() => p.stop()).not.toThrow();
  });

  it('integrates through the coordinator (enabled → captures; disabled → nothing)', async () => {
    const store = mkStore();
    const source = mkSource();
    const coordinator = createCaptureCoordinator(buildInit(store));
    coordinator.addProvider(createLogCaptureProvider(source));
    coordinator.start(options, (opt) => opt === BugseeOption.CaptureLogs);
    source.emit('log', logEvent(1, 'on'));
    expect(await drainLog(store)).toHaveLength(1);

    const offStore = mkStore();
    const offSource = mkSource();
    const offCoordinator = createCaptureCoordinator(buildInit(offStore));
    offCoordinator.addProvider(createLogCaptureProvider(offSource));
    offCoordinator.start(options, () => false);
    offSource.emit('log', logEvent(1, 'off'));
    expect((await createCaptureExporter(offStore).drain()).size).toBe(0);
  });
});

// WAVE 5.1 — `logs.json` shipped STRING levels where the viewer expects numerics.
//
// `logLevelToWire` has existed in @bugsee/protocol, exported and unit-tested, with ZERO callers outside its
// own test. `LogEvent.level` is typed `LogLevelName | LogLevel`, the console interceptor emits names, and
// nothing converted before upload — so every console-captured line reached the backend as "error" rather
// than 1. Mobile SDKs send the numeric, so this is also an Android-parity break on the wire.
//
// Converted at the PROVIDER, which is the single point every log entry passes through, and AFTER the user
// filter so a `logFilter` still sees the friendly name it was written against.
describe('log level reaches the wire as a NUMERIC (Wave 5.1)', () => {
  const named = (level: string): LogEvent =>
    ({ timestamp: 1, level, source: 'console', message: 'm' }) as LogEvent;

  it.each([
    ['error', 1],
    ['warning', 2],
    ['info', 3],
    ['debug', 4],
    ['verbose', 5],
  ])('encodes %s as %d', async (name, wire) => {
    const store = mkStore();
    const source = mkSource();
    const p = createLogCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('log', named(name));
    const entry = (await drainLog(store))?.[0]?.data as { level: unknown };
    expect(entry.level).toBe(wire);
  });

  it('leaves an ALREADY-numeric level alone', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createLogCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('log', { timestamp: 1, level: 3, source: 'api', message: 'm' } as LogEvent);
    const entry = (await drainLog(store))?.[0]?.data as { level: unknown };
    expect(entry.level).toBe(3);
  });

  it('shows the user filter the NAME, and still ships the numeric', async () => {
    // A `logFilter` is user code written against the documented string levels. Converting before the
    // filter would silently break every filter that matches on 'error'.
    const store = mkStore();
    const source = mkSource();
    const seen: unknown[] = [];
    const filters = createFilterStore(() => {});
    filters.log = (e) => {
      seen.push(e.level);
      return e;
    };
    publishFilters(filters);
    const p = createLogCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('log', named('error'));
    expect(seen).toEqual(['error']);
    const entry = (await drainLog(store))?.[0]?.data as { level: unknown };
    expect(entry.level).toBe(1);
  });

  it('does not mutate the caller’s event object', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createLogCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    const event = named('warning');
    source.emit('log', event);
    await drainLog(store);
    expect(event.level).toBe('warning'); // the hub event other subscribers see stays as emitted
  });
});
