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
  type MultiKeyEmitter,
  type OptionsContainer,
  setCarrierClient,
} from '@bugsee/core';
import { BugseeOption, type NetworkEvent, type NetworkStage } from '@bugsee/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNetworkCaptureProvider } from './network-provider';

// Publish a filter store as the singleton client's `filters` service on the global carrier (the
// provider reads it via getFilters()); reset between tests.
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
const mkSource = (): MultiKeyEmitter<Record<NetworkStage, NetworkEvent>> => createMultiKeyEmitter();
const netEvent = (over: Partial<NetworkEvent> = {}): NetworkEvent => ({
  timestamp: 1,
  id: 'n1',
  sequence: 'n1',
  mechanism: 'fetch',
  url: 'https://api/x',
  method: 'GET',
  type: 'complete',
  ...over,
});
const drainNetwork = async (store: CaptureStore) =>
  (await createCaptureExporter(store).drain()).get('network');

describe('createNetworkCaptureProvider', () => {
  it('is named "network" and gated by the captureNetwork option', () => {
    const p = createNetworkCaptureProvider(mkSource());
    expect(p.name).toBe('network');
    expect(p.controllingOption).toBe(BugseeOption.CaptureNetwork);
  });

  it('captures events of every stage (onAny) as "network" entries', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('before', netEvent({ type: 'before', timestamp: 1 }));
    source.emit('complete', netEvent({ type: 'complete', timestamp: 2 }));
    const entries = await drainNetwork(store);
    expect(entries).toHaveLength(2);
    expect(entries?.map((e) => (e.data as NetworkEvent).type)).toEqual(['before', 'complete']);
    expect(entries?.[0]?.timestamp).toBe(1);
  });

  it('applies a user network filter (mutate) and that filter REPLACES the default sanitizer', async () => {
    const store = mkStore();
    const source = mkSource();
    const filters = createFilterStore(vi.fn());
    // Identity filter (no scrubbing): proves the default sanitizer is NOT also applied (Android XOR).
    filters.network = (e) => ({ ...e, url: 'REDACTED' });
    publishFilters(filters);
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('complete', netEvent({ custom: { headers: { authorization: 'secret' } } }));
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.url).toBe('REDACTED'); // filter ran
    expect(captured.custom?.headers).toEqual({ authorization: 'secret' }); // sanitizer NOT applied
  });

  it('drops a network event when the filter returns null', async () => {
    const store = mkStore();
    const source = mkSource();
    const filters = createFilterStore(vi.fn());
    filters.network = () => null;
    publishFilters(filters);
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('complete', netEvent());
    expect(await drainNetwork(store)).toBeUndefined();
  });

  it('drops the event and routes to the filter onError when a network filter throws', async () => {
    const store = mkStore();
    const source = mkSource();
    const onError = vi.fn();
    const filters = createFilterStore(onError);
    filters.network = () => {
      throw new Error('bad');
    };
    publishFilters(filters);
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('complete', netEvent());
    expect(await drainNetwork(store)).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('skips the default sanitizer when captureNetworkDefaultSanitizer is false', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(createOptionsContainer({ [BugseeOption.CaptureNetworkDefaultSanitizer]: false }));
    source.emit('complete', netEvent({ custom: { headers: { authorization: 'secret' } } }));
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.custom?.headers).toEqual({ authorization: 'secret' }); // raw, not redacted
  });

  it('sanitizes sensitive request/response headers per event (non-mutating)', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    const event = netEvent({
      custom: { headers: { authorization: 'secret-token', accept: 'json' } },
    });
    source.emit('complete', event);
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.custom?.headers).toEqual({ authorization: '<redacted>', accept: 'json' });
    // the original event object was not mutated
    expect(event.custom?.headers).toEqual({ authorization: 'secret-token', accept: 'json' });
  });

  it('sanitizes a JSON request/response body (key redaction) on the default path', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit(
      'complete',
      netEvent({
        custom: { headers: { 'content-type': 'application/json' }, body: '{"password":"x"}' },
      }),
    );
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.custom?.body).toBe('{"password":"<redacted>"}');
  });

  it('shape-scans a Content-Type-less body when captureNetworkBodyWithoutType is on', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(createOptionsContainer({ [BugseeOption.CaptureNetworkBodyWithoutType]: true }));
    source.emit('complete', netEvent({ custom: { body: `leak ghp_${'a'.repeat(36)}` } }));
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.custom?.body).toBe('leak <redacted>');
    expect(captured.custom?.no_body_reason).toBeUndefined();
  });

  it('drops an over-size body as size_too_large (gate runs before the sanitizer)', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(createOptionsContainer({ [BugseeOption.CaptureNetworkBodySizeLimit]: 5 }));
    source.emit(
      'complete',
      netEvent({ custom: { headers: { 'content-type': 'text/plain' }, body: 'way too long' } }),
    );
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.custom?.body).toBeNull();
    expect(captured.custom?.no_body_reason).toBe('size_too_large');
  });

  it('drops a Content-Type-less body as no_content_type by default', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('complete', netEvent({ custom: { body: 'no content type here' } }));
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.custom?.body).toBeNull();
    expect(captured.custom?.no_body_reason).toBe('no_content_type');
  });

  it('applies the body gate even when the default sanitizer is off', async () => {
    // The size/Content-Type gate runs independently of the redaction sanitizer: an over-size body is
    // dropped on the raw (sanitizer-off) path too.
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(
      createOptionsContainer({
        [BugseeOption.CaptureNetworkDefaultSanitizer]: false,
        [BugseeOption.CaptureNetworkBodySizeLimit]: 5,
      }),
    );
    source.emit(
      'complete',
      netEvent({ custom: { headers: { 'content-type': 'text/plain' }, body: 'way too long' } }),
    );
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.custom?.body).toBeNull();
    expect(captured.custom?.no_body_reason).toBe('size_too_large');
  });

  it('preserves an explicitly-null producer body + reason when captureNetworkBodies is off', async () => {
    // captureBodies off + body already null: the early-return leaves the producer's reason intact.
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(createOptionsContainer({ [BugseeOption.CaptureNetworkBodies]: false }));
    source.emit('complete', netEvent({ custom: { body: null, no_body_reason: 'cant_read_data' } }));
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.custom?.body).toBeNull();
    expect(captured.custom?.no_body_reason).toBe('cant_read_data');
  });

  it('strips the body (no reason) when captureNetworkBodies is off', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(createOptionsContainer({ [BugseeOption.CaptureNetworkBodies]: false }));
    source.emit(
      'complete',
      netEvent({
        custom: { headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
      }),
    );
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.custom?.body).toBeNull();
    expect(captured.custom?.no_body_reason).toBeUndefined();
  });

  it('leaves a bodiless event untouched when captureNetworkBodies is off (identity custom)', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(createOptionsContainer({ [BugseeOption.CaptureNetworkBodies]: false }));
    source.emit('complete', netEvent({ custom: { headers: { accept: 'json' } } }));
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.custom?.body).toBeUndefined();
    expect(captured.custom?.headers).toEqual({ accept: 'json' });
  });

  it('a user network filter receives the already body-gated event', async () => {
    const store = mkStore();
    const source = mkSource();
    let seenBody: string | null | undefined = 'unset';
    let seenReason: string | null | undefined = 'unset';
    const filters = createFilterStore(vi.fn());
    filters.network = (e) => {
      seenBody = e.custom?.body;
      seenReason = e.custom?.no_body_reason;
      return e;
    };
    publishFilters(filters);
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(createOptionsContainer({ [BugseeOption.CaptureNetworkBodySizeLimit]: 5 }));
    source.emit(
      'complete',
      netEvent({ custom: { headers: { 'content-type': 'text/plain' }, body: 'way too long' } }),
    );
    expect(seenBody).toBeNull(); // gate already nulled the over-size body before the filter saw it
    expect(seenReason).toBe('size_too_large');
  });

  it('returns a custom-bearing event untouched when there is nothing to redact', async () => {
    // custom present but no headers and no body → the default sanitizer has nothing to change.
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('timing', netEvent({ type: 'timing', custom: { timings: { dns: 5 } } }));
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.custom).toEqual({ timings: { dns: 5 } });
  });

  it('passes through an event with no headers untouched', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('error', netEvent({ type: 'error', customError: 'boom' }));
    expect((await drainNetwork(store))?.[0]?.data).toMatchObject({
      type: 'error',
      customError: 'boom',
    });
  });

  it('captures from multiple sources', async () => {
    const store = mkStore();
    const a = mkSource();
    const b = mkSource();
    const p = createNetworkCaptureProvider(a, b);
    p.init(buildInit(store));
    p.start(options);
    a.emit('complete', netEvent({ url: 'https://a/' }));
    b.emit('complete', netEvent({ url: 'https://b/' }));
    expect((await drainNetwork(store))?.map((e) => (e.data as NetworkEvent).url)).toEqual([
      'https://a/',
      'https://b/',
    ]);
  });

  it('stop unsubscribes from every source: later events are not captured', async () => {
    const store = mkStore();
    const a = mkSource();
    const b = mkSource();
    const p = createNetworkCaptureProvider(a, b);
    p.init(buildInit(store));
    p.start(options);
    p.stop();
    a.emit('complete', netEvent());
    b.emit('complete', netEvent());
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });

  it('stop before start is a safe no-op', () => {
    const p = createNetworkCaptureProvider(mkSource());
    p.init(buildInit(mkStore()));
    expect(() => p.stop()).not.toThrow();
  });

  it('integrates through the coordinator (enabled → captures; disabled → nothing)', async () => {
    const store = mkStore();
    const source = mkSource();
    const coordinator = createCaptureCoordinator(buildInit(store));
    coordinator.addProvider(createNetworkCaptureProvider(source));
    coordinator.start(options, (opt) => opt === BugseeOption.CaptureNetwork);
    source.emit('complete', netEvent());
    expect(await drainNetwork(store)).toHaveLength(1);

    const offStore = mkStore();
    const offSource = mkSource();
    const offCoordinator = createCaptureCoordinator(buildInit(offStore));
    offCoordinator.addProvider(createNetworkCaptureProvider(offSource));
    offCoordinator.start(options, () => false);
    offSource.emit('complete', netEvent());
    expect((await createCaptureExporter(offStore).drain()).size).toBe(0);
  });
});
