import {
  type CaptureProviderInit,
  type CaptureStore,
  createCaptureAggregator,
  createCaptureCoordinator,
  createCaptureExporter,
  createEventHubs,
  createMemoryCaptureStore,
  createOperationDispatcher,
  createOptionsContainer,
  type LogEvent,
  type OptionsContainer,
} from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { createLogCaptureProvider } from './log-provider';

const mkStore = (): CaptureStore =>
  createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
const buildInit = (store: CaptureStore): CaptureProviderInit => ({
  hubs: createEventHubs(),
  operations: createOperationDispatcher(),
  captureAggregator: createCaptureAggregator(store),
});
const options: OptionsContainer = createOptionsContainer();
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
    const p = createLogCaptureProvider();
    expect(p.name).toBe('log');
    expect(p.controllingOption).toBe('captureLogs');
  });

  it('routes a log hub event to the aggregator as a "log" entry (type/timestamp/data)', async () => {
    const store = mkStore();
    const init = buildInit(store);
    const p = createLogCaptureProvider();
    p.init(init);
    p.start(options);
    const event = logEvent(5, 'hi');
    init.hubs.log.emit(event);
    const entries = await drainLog(store);
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.type).toBe('log');
    expect(entries?.[0]?.timestamp).toBe(5);
    expect(entries?.[0]?.data).toEqual(event);
  });

  it('captures multiple events in order', async () => {
    const store = mkStore();
    const init = buildInit(store);
    const p = createLogCaptureProvider();
    p.init(init);
    p.start(options);
    init.hubs.log.emit(logEvent(1, 'a'));
    init.hubs.log.emit(logEvent(2, 'b'));
    expect((await drainLog(store))?.map((e) => (e.data as LogEvent).message)).toEqual(['a', 'b']);
  });

  it('stop unsubscribes: later hub events are not captured', async () => {
    const store = mkStore();
    const init = buildInit(store);
    const p = createLogCaptureProvider();
    p.init(init);
    p.start(options);
    p.stop();
    init.hubs.log.emit(logEvent(9, 'after-stop'));
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });

  it('stop before start is a safe no-op', () => {
    const p = createLogCaptureProvider();
    p.init(buildInit(mkStore()));
    expect(() => p.stop()).not.toThrow();
  });

  it('integrates through the coordinator (enabled → captures; disabled → nothing)', async () => {
    const store = mkStore();
    const init = buildInit(store);
    const coordinator = createCaptureCoordinator(init);
    coordinator.addProvider(createLogCaptureProvider());
    coordinator.start(options, (opt) => opt === 'captureLogs');
    init.hubs.log.emit(logEvent(1, 'on'));
    expect(await drainLog(store)).toHaveLength(1);

    const offStore = mkStore();
    const offInit = buildInit(offStore);
    const offCoordinator = createCaptureCoordinator(offInit);
    offCoordinator.addProvider(createLogCaptureProvider());
    offCoordinator.start(options, () => false);
    offInit.hubs.log.emit(logEvent(1, 'off'));
    expect((await createCaptureExporter(offStore).drain()).size).toBe(0);
  });
});
