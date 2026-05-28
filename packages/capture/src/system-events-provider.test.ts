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
  type MultiKeyEmitter,
  type OptionsContainer,
} from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { createSystemEventsProvider, type SystemEvent } from './system-events-provider';

const mkStore = (): CaptureStore =>
  createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
const buildInit = (store: CaptureStore): CaptureProviderInit => ({
  operations: createOperationDispatcher(),
  captureAggregator: createCaptureAggregator(store),
});
const options: OptionsContainer = createOptionsContainer();
const mkSource = (): MultiKeyEmitter<{ event: SystemEvent }> => createMultiKeyEmitter();
const drainEvents = async (store: CaptureStore) =>
  (await createCaptureExporter(store).drain()).get('events.system');

describe('createSystemEventsProvider', () => {
  it('is named "events.system" and gated by captureSystemEvents', () => {
    const p = createSystemEventsProvider(mkSource());
    expect(p.name).toBe('events.system');
    expect(p.controllingOption).toBe('captureSystemEvents');
  });

  it('captures a source event as an events.system entry (timestamp from the clock)', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createSystemEventsProvider(source, { now: () => 1000 });
    p.init(buildInit(store));
    p.start(options);
    source.emit('event', { name: 'process_started' });
    source.emit('event', { name: 'process_warning', params: { name: 'DeprecationWarning' } });
    expect((await drainEvents(store))?.map((e) => e.data)).toEqual([
      { timestamp: 1000, name: 'process_started' },
      { timestamp: 1000, name: 'process_warning', params: { name: 'DeprecationWarning' } },
    ]);
  });

  it('stop unsubscribes: later source events are not captured', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createSystemEventsProvider(source, { now: () => 1 });
    p.init(buildInit(store));
    p.start(options);
    p.stop();
    source.emit('event', { name: 'after' });
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });

  it('uses the default clock (Date.now) when none is injected', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createSystemEventsProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('event', { name: 'x' });
    expect((await drainEvents(store))?.[0]?.timestamp).toBeGreaterThan(0);
  });

  it('integrates through the coordinator (enabled → captures; disabled → nothing)', async () => {
    const store = mkStore();
    const source = mkSource();
    const coordinator = createCaptureCoordinator(buildInit(store));
    coordinator.addProvider(createSystemEventsProvider(source, { now: () => 1 }));
    coordinator.start(options, (opt) => opt === 'captureSystemEvents');
    source.emit('event', { name: 'on' });
    expect(await drainEvents(store)).toHaveLength(1);

    const offStore = mkStore();
    const offSource = mkSource();
    const offCoordinator = createCaptureCoordinator(buildInit(offStore));
    offCoordinator.addProvider(createSystemEventsProvider(offSource));
    offCoordinator.start(options, () => false);
    offSource.emit('event', { name: 'off' });
    expect((await createCaptureExporter(offStore).drain()).size).toBe(0);
  });
});
