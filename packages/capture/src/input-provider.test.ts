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
  InputTool,
  type MultiKeyEmitter,
  type OptionsContainer,
} from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { createInputProvider, type InputEventDetail } from './input-provider';

const mkStore = (): CaptureStore =>
  createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
const buildInit = (store: CaptureStore): CaptureProviderInit => ({
  operations: createOperationDispatcher(),
  captureAggregator: createCaptureAggregator(store),
});
const options: OptionsContainer = createOptionsContainer();
const mkSource = (): MultiKeyEmitter<{ input: InputEventDetail }> => createMultiKeyEmitter();
const drainInput = async (store: CaptureStore) =>
  (await createCaptureExporter(store).drain()).get('input');

describe('createInputProvider', () => {
  // Ported from the retired `createUserEventsProvider` test. What it was protecting: the provider
  // declares the stream it writes and the option that gates it. Both still matter — but the stream
  // it names is the WHOLE point of this change, so the assertion moved from 'events.user' to 'input'.
  it('is named "input" and gated by captureInteractions', () => {
    const p = createInputProvider(mkSource());
    expect(p.name).toBe('input');
    expect(p.controllingOption).toBe(BugseeOption.CaptureInteractions);
  });

  it('captures a source event as an `input` entry, stamped from the clock', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createInputProvider(source, { now: () => 1000 });
    p.init(buildInit(store));
    p.start(options);
    source.emit('input', {
      id: 'p1',
      type: 'begin',
      x: 5,
      y: 9,
      tool: InputTool.Touch,
      view_tag: 'button',
    });
    const entries = await drainInput(store);
    expect(entries?.map((e) => e.data)).toStrictEqual([
      { timestamp: 1000, id: 'p1', type: 'begin', x: 5, y: 9, tool: 1, view_tag: 'button' },
    ]);
    // The entry's own (sort/index) timestamp is the SAME clock reading as the data timestamp.
    expect(entries?.[0]?.timestamp).toBe(1000);
  });

  // THE SEPARATION, at the provider seam: SDK-captured input must not reach a `user.*` stream.
  it('never writes into events.user (or any other stream)', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createInputProvider(source, { now: () => 3 });
    p.init(buildInit(store));
    p.start(options);
    source.emit('input', { type: 'begin', tool: InputTool.Mouse, x: 1, y: 2 });
    const drained = await createCaptureExporter(store).drain();
    expect([...drained.keys()]).toStrictEqual(['input']);
    expect(drained.get('events.user')).toBeUndefined();
  });

  // Ported: the source's own timestamp wins when it has one, so a replayed/buffered event keeps the
  // moment it HAPPENED rather than the moment it was drained.
  it('honours a timestamp the source already carries', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createInputProvider(source, { now: () => 1000 });
    p.init(buildInit(store));
    p.start(options);
    source.emit('input', { type: 'end', timestamp: 42 });
    const entries = await drainInput(store);
    expect(entries?.[0]?.data).toStrictEqual({ timestamp: 42, type: 'end' });
    expect(entries?.[0]?.timestamp).toBe(42);
  });

  // A source that spells the absent case out (`timestamp: undefined`) must still get a stamped entry:
  // an unstamped entry sorts and renders nowhere. This pins the WRITE ORDER — resolving the clock and
  // then letting the spread put `undefined` back is silently indistinguishable in every other test.
  it('stamps an explicitly-undefined source timestamp', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createInputProvider(source, { now: () => 1000 });
    p.init(buildInit(store));
    p.start(options);
    source.emit('input', { type: 'end', timestamp: undefined });
    const entries = await drainInput(store);
    expect(entries?.[0]?.data).toStrictEqual({ timestamp: 1000, type: 'end' });
  });

  // Ported verbatim in intent: unsubscribing on stop is a leak/liveness guarantee independent of
  // which stream the provider feeds, so this one only needed its emit channel re-pointed.
  it('stop unsubscribes: later source events are not captured', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createInputProvider(source, { now: () => 1 });
    p.init(buildInit(store));
    p.start(options);
    p.stop();
    source.emit('input', { type: 'begin' });
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });

  // Ported: proves the injectable clock has a real default rather than silently emitting NaN/0.
  it('uses the default clock (Date.now) when none is injected', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createInputProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('input', { type: 'begin' });
    expect((await drainInput(store))?.[0]?.timestamp).toBeGreaterThan(0);
  });

  // Ported: the coordinator, not the provider, decides activation — so the option really gates capture.
  it('integrates through the coordinator (enabled → captures; disabled → nothing)', async () => {
    const store = mkStore();
    const source = mkSource();
    const coordinator = createCaptureCoordinator(buildInit(store));
    coordinator.addProvider(createInputProvider(source, { now: () => 1 }));
    coordinator.start(options, (opt) => opt === BugseeOption.CaptureInteractions);
    source.emit('input', { type: 'begin' });
    expect(await drainInput(store)).toHaveLength(1);

    const offStore = mkStore();
    const offSource = mkSource();
    const offCoordinator = createCaptureCoordinator(buildInit(offStore));
    offCoordinator.addProvider(createInputProvider(offSource));
    offCoordinator.start(options, () => false);
    offSource.emit('input', { type: 'begin' });
    expect((await createCaptureExporter(offStore).drain()).size).toBe(0);
  });
});
