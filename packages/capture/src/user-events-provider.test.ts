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
import { BugseeOption } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { createUserEventsProvider, type UserEvent } from './user-events-provider';

const mkStore = (): CaptureStore =>
  createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
const buildInit = (store: CaptureStore): CaptureProviderInit => ({
  operations: createOperationDispatcher(),
  captureAggregator: createCaptureAggregator(store),
});
const options: OptionsContainer = createOptionsContainer();
const mkSource = (): MultiKeyEmitter<{ event: UserEvent }> => createMultiKeyEmitter();
const drainEvents = async (store: CaptureStore) =>
  (await createCaptureExporter(store).drain()).get('events.user');

describe('createUserEventsProvider', () => {
  it('is named "events.user" and gated by captureInteractions', () => {
    const p = createUserEventsProvider(mkSource());
    expect(p.name).toBe('events.user');
    expect(p.controllingOption).toBe(BugseeOption.CaptureInteractions);
  });

  it('captures a source event as an events.user entry (timestamp from the clock)', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createUserEventsProvider(source, { now: () => 1000 });
    p.init(buildInit(store));
    p.start(options);
    source.emit('event', { name: 'click', params: { target: { tag: 'button' }, x: 5, y: 9 } });
    source.emit('event', { name: 'submit' });
    const entries = await drainEvents(store);
    // toStrictEqual so a paramless event must NOT carry a `params: undefined` key.
    expect(entries?.map((e) => e.data)).toStrictEqual([
      { timestamp: 1000, name: 'click', params: { target: { tag: 'button' }, x: 5, y: 9 } },
      { timestamp: 1000, name: 'submit' },
    ]);
    // The entry's own (sort/index) timestamp is the SAME clock reading as the data timestamp.
    expect(entries?.every((e) => e.timestamp === (e.data as { timestamp: number }).timestamp)).toBe(
      true,
    );
    expect(entries?.[0]?.timestamp).toBe(1000);
  });

  it('stop unsubscribes: later source events are not captured', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createUserEventsProvider(source, { now: () => 1 });
    p.init(buildInit(store));
    p.start(options);
    p.stop();
    source.emit('event', { name: 'after' });
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });

  it('uses the default clock (Date.now) when none is injected', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createUserEventsProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('event', { name: 'x' });
    expect((await drainEvents(store))?.[0]?.timestamp).toBeGreaterThan(0);
  });

  it('integrates through the coordinator (enabled → captures; disabled → nothing)', async () => {
    const store = mkStore();
    const source = mkSource();
    const coordinator = createCaptureCoordinator(buildInit(store));
    coordinator.addProvider(createUserEventsProvider(source, { now: () => 1 }));
    coordinator.start(options, (opt) => opt === BugseeOption.CaptureInteractions);
    source.emit('event', { name: 'on' });
    expect(await drainEvents(store)).toHaveLength(1);

    const offStore = mkStore();
    const offSource = mkSource();
    const offCoordinator = createCaptureCoordinator(buildInit(offStore));
    offCoordinator.addProvider(createUserEventsProvider(offSource));
    offCoordinator.start(options, () => false);
    offSource.emit('event', { name: 'off' });
    expect((await createCaptureExporter(offStore).drain()).size).toBe(0);
  });
});
