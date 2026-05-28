import {
  type CaptureProviderInit,
  type CaptureStore,
  createCaptureAggregator,
  createCaptureCoordinator,
  createCaptureExporter,
  createMemoryCaptureStore,
  createMultiKeyEmitter,
  createOperationDispatcher,
  createOptionsContainer,
  type LogEvent,
  type MultiKeyEmitter,
  type OptionsContainer,
} from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { createLogCaptureProvider } from './log-provider';

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
    expect(p.controllingOption).toBe('captureLogs');
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
    expect(entries?.[0]?.data).toEqual(event);
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
    coordinator.start(options, (opt) => opt === 'captureLogs');
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
