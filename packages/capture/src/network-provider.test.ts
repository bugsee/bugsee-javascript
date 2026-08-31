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
import { BugseeOption, type NetworkEvent, type NetworkStage, sanitizeUrl } from '@bugsee/protocol';
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

  // Wave 1.1. Every network source writes `event.url` verbatim and the provider is the ONE place that
  // redacts — so a secret in the URL reached disk on every transport, and on node:http too (it folds into
  // this same provider via `additionalSources`). Reproduced end-to-end in docs/review/capture.md SEV1 #4
  // and docs/review/node-B-http-server.md SEV1 #3.
  it('redacts a sensitive query value in the captured URL (non-mutating)', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    const event = netEvent({ url: 'https://api/x?api_key=QUERYAPIKEYSECRET&plain=v' });
    source.emit('complete', event);
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.url).toBe('https://api/x?api_key=%3Credacted%3E&plain=v');
    expect(event.url).toBe('https://api/x?api_key=QUERYAPIKEYSECRET&plain=v'); // input untouched
  });

  it('redacts URL userinfo credentials in the captured URL', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('complete', netEvent({ url: 'http://alice:URLUSERINFOSECRET@127.0.0.1/secure' }));
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.url).toBe('http://alice:%3Credacted%3E@127.0.0.1/secure');
  });

  it('redacts the URL even when the event carries NO custom payload', async () => {
    // ws/sse/webtransport events have no headers or body. Skipping such events entirely — the shape the
    // sanitizer had before the URL was part of its job — would leave `wss://…?token=…` in the clear.
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('complete', netEvent({ url: 'wss://rt/socket?token=WSSECRET', custom: undefined }));
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.url).toBe('wss://rt/socket?token=%3Credacted%3E');
  });

  it('redacts the URL on an event that ALSO carries headers and a body', async () => {
    // The fetch/xhr path always has a `custom` payload, so it takes a different branch from the ws/sse
    // case above. Testing only the no-custom shape leaves the branch that serves MOST traffic unproven.
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit(
      'complete',
      netEvent({
        url: 'https://api/x?api_key=QUERYAPIKEYSECRET',
        custom: { headers: { 'content-type': 'application/json' }, body: '{"password":"x"}' },
      }),
    );
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.url).toBe('https://api/x?api_key=%3Credacted%3E');
    expect(captured.custom?.body).toBe('{"password":"<redacted>"}');
  });

  it('redacts the URL when the custom payload has nothing of its own to redact', async () => {
    // headers and body both absent → the header/body comparison finds no change, and an early return
    // keyed on that alone would hand back the event with its raw URL.
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('complete', netEvent({ url: 'https://api/x?token=T', custom: {} }));
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.url).toBe('https://api/x?token=%3Credacted%3E');
  });

  it('redacts a URL embedded in the ERROR MESSAGE, on both error fields', async () => {
    // Found by the privacy e2e AFTER the url fix was in: undici reports "Request cannot be constructed
    // from a URL that includes credentials: <the whole URL>", so the credential shipped in `customError`
    // and `custom.error` while `url` itself was correctly redacted.
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    const message = 'failed: http://alice:PWSECRET@127.0.0.1/secure?api_key=QSECRET';
    source.emit(
      'error',
      netEvent({ type: 'error', customError: message, custom: { error: message } }),
    );
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    const expected = 'failed: http://alice:%3Credacted%3E@127.0.0.1/secure?api_key=%3Credacted%3E';
    expect(captured.customError).toBe(expected);
    expect(captured.custom?.error).toBe(expected);
  });

  it.each([
    ['statusText', 'Unauthorized: token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'],
    ['reason', 'closing: password=hunter2'],
    ['channel', 'refresh eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'],
  ])('redacts the free-text field `%s`, which is remote-controlled', async (field, raw) => {
    // These three carry text chosen by the SERVER, not the app: the HTTP reason phrase, the WebSocket
    // CloseEvent reason (up to 123 bytes, and `close(4001, 'invalid token …')` is the idiomatic use), and
    // the SSE event name. All three were copied through untouched while the comment above `sanitize()`
    // called this "the single redaction point for every transport".
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('complete', netEvent({ type: 'complete', [field]: raw }));
    const captured = (await drainNetwork(store))?.[0]?.data as unknown as Record<string, string>;
    expect(captured[field]).not.toContain('hunter2');
    expect(captured[field]).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(captured[field]).toContain('redacted');
  });

  it('leaves an ordinary status phrase byte-for-byte alone', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit(
      'complete',
      netEvent({ type: 'complete', statusText: 'Not Found', reason: 'going away' }),
    );
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.statusText).toBe('Not Found');
    expect(captured.reason).toBe('going away');
  });

  it('survives a non-string Content-Type and still redacts the body', async () => {
    // The XHR coercion fix built a sanitized header copy — and then the very next line read the CONTENT
    // TYPE off the RAW headers. `contentTypeOf({'Content-Type': 42})` returns the number, and
    // `sanitizeBody(body, 42)` throws on `.toLowerCase()`. The throw is swallowed by the emitter dispatch
    // and the whole entry disappears: the exact failure mode the coercion was written to eliminate,
    // reproduced one line later through the sibling accessor.
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit(
      'complete',
      netEvent({
        type: 'complete',
        custom: {
          headers: { 'Content-Type': 42 as unknown as string },
          body: 'password=hunter2',
        },
      }),
    );
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured).toBeDefined(); // the entry must still exist at all
    expect(captured.custom?.body).not.toContain('hunter2');
  });

  it('survives a non-string url without dropping the entry', async () => {
    // `sanitizeUrl(event.url)` is the one field with no `typeof` guard, where customError/body/error all
    // have one. No producer emits a non-string today; a sanitizer that deletes the data it was asked to
    // sanitize is the wrong way to find that out.
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('complete', netEvent({ type: 'complete', url: undefined as unknown as string }));
    expect((await drainNetwork(store))?.[0]?.data).toBeDefined();
  });

  it('redacts customError even when it is the ONLY field that changes', async () => {
    // With a clean url, no headers and no body, an unchanged-check that ignores customError returns the
    // raw event — so the redaction above would run and then be thrown away.
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit(
      'error',
      netEvent({ type: 'error', customError: 'failed http://u:PWSECRET@h/x', custom: {} }),
    );
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.customError).toBe('failed http://u:%3Credacted%3E@h/x');
  });

  it('leaves a null/absent error field alone', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('error', netEvent({ type: 'error', customError: null, custom: { error: null } }));
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.customError).toBeNull();
    expect(captured.custom?.error).toBeNull();
  });

  it('leaves the URL raw when the default sanitizer is disabled', async () => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(createOptionsContainer({ [BugseeOption.CaptureNetworkDefaultSanitizer]: false }));
    source.emit('complete', netEvent({ url: 'https://api/x?token=T' }));
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.url).toBe('https://api/x?token=T');
  });

  it('does not redact the URL when a user network filter supersedes the sanitizer (XOR)', async () => {
    const store = mkStore();
    const source = mkSource();
    const filters = createFilterStore(vi.fn());
    filters.network = (e) => e; // identity: the user owns redaction from here on
    publishFilters(filters);
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit('complete', netEvent({ url: 'https://api/x?token=T' }));
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.url).toBe('https://api/x?token=T');
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

// ---------------------------------------------------------------------------------------------------
// FINDING 2 (solid-spa F-1) — investigated, NOT changed. A user network filter's veto is applied per
// NetworkStage-ENTRY, not per logical request: vetoing the `complete` stage does not retroactively or
// prospectively veto the `before` stage of the SAME request (shared `id`), so `before`'s URL/request
// body still ships. Verified this is Android-canonical (CLAUDE.md's binding parity target), not a JS-only
// defect: Android's NetworkEventsProducer dispatches `postBeforeEvent`/`postCompleteEvent` as two
// SEPARATE NetworkEvent objects (sharing only `getId()`), each independently run through
// BugseeCaptureDataProviderNetwork#filterEntry — there is no id-based lookup/merge before filtering, so
// Android's own EventFilter<NetworkEvent> has exactly the same per-stage granularity this test documents.
// A filter author who wants a whole-request veto must recognize and drop every stage sharing an `id`
// themselves (this provider does not do it for them, matching Android).
// ---------------------------------------------------------------------------------------------------
describe('network filter veto granularity — per stage-entry, not per request (Android parity)', () => {
  it('vetoing the "complete" stage does NOT suppress the "before" stage of the same request', async () => {
    const store = mkStore();
    const source = mkSource();
    const filters = createFilterStore(vi.fn());
    // Vetoes ONLY the response/complete phase — e.g. "hide the response, but not what was sent".
    filters.network = (e) => (e.type === 'complete' ? null : e);
    publishFilters(filters);
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit(
      'before',
      netEvent({
        id: 'shared-req',
        type: 'before',
        url: 'https://api/x?token=SECRET',
        custom: { headers: { 'content-type': 'text/plain' }, body: 'request-body' },
      }),
    );
    source.emit('complete', netEvent({ id: 'shared-req', type: 'complete', status: 200 }));
    const entries = await drainNetwork(store);
    // The "complete" entry was vetoed…
    expect(entries?.map((e) => (e.data as NetworkEvent).type)).toEqual(['before']);
    // …but the "before" entry — same request id — still carries its URL and body verbatim (raw, since a
    // filter is installed and therefore supersedes the default sanitizer too, per the XOR rule).
    const before = entries?.[0]?.data as NetworkEvent;
    expect(before.id).toBe('shared-req');
    expect(before.url).toBe('https://api/x?token=SECRET');
    expect(before.custom?.body).toBe('request-body');
  });

  it('a filter CAN achieve a whole-request veto by tracking ids itself across stages', async () => {
    const store = mkStore();
    const source = mkSource();
    const filters = createFilterStore(vi.fn());
    const vetoedIds = new Set<string>();
    filters.network = (e) => {
      if (e.type === 'complete' && e.status === 403) {
        vetoedIds.add(e.id);
        return null;
      }
      return vetoedIds.has(e.id) ? null : e;
    };
    publishFilters(filters);
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    // Stage order matters for this hand-rolled example: the veto is only learned once `complete` (with
    // status 403) is SEEN, so a `before` stage arriving BEFORE it is not retroactively covered — which is
    // exactly the per-stage granularity the test above documents, just worked around by the caller.
    source.emit('complete', netEvent({ id: 'blocked-req', type: 'complete', status: 403 }));
    source.emit('before', netEvent({ id: 'blocked-req', type: 'before' }));
    const entries = await drainNetwork(store);
    expect(entries).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// FINDING 3 (solid-spa finding C) — documentation only, behaviour unchanged (deliberate Android XOR
// rule; see the doc comments on `onStart` and `createNetworkCaptureProvider` above). This test guards
// that the (now-documented) behaviour itself doesn't drift: installing ANY network filter — even a pure
// pass-through identity filter that redacts nothing — disables the default PII sanitizer, silently, for
// every network entry from then on.
// ---------------------------------------------------------------------------------------------------
describe('network filter XOR — installing a filter silently disables the default sanitizer (documented, not changed)', () => {
  it('a no-op passthrough filter still turns off the default sanitizer (PII ships unredacted)', async () => {
    const store = mkStore();
    const source = mkSource();
    const filters = createFilterStore(vi.fn());
    filters.network = (e) => e; // does NOT redact anything itself
    publishFilters(filters);
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit(
      'complete',
      netEvent({
        url: 'https://api/x?api_key=QUERYAPIKEYSECRET',
        custom: {
          headers: { authorization: 'secret-token', 'content-type': 'application/json' },
          body: '{"password":"x"}',
        },
      }),
    );
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    // None of the default redactions ran: URL, headers, and body all ship exactly as captured.
    expect(captured.url).toBe('https://api/x?api_key=QUERYAPIKEYSECRET');
    expect(captured.custom?.headers).toEqual({
      authorization: 'secret-token',
      'content-type': 'application/json',
    });
    expect(captured.custom?.body).toBe('{"password":"x"}');
  });
});

describe('network sanitize — custom.error as the ONLY dirty field', () => {
  it('redacts it even when url, headers and body are all clean', async () => {
    // Review finding: no test covered `custom.error` being the sole field needing redaction, and the
    // unchanged-check could have returned the raw event. A probe emitted `u:PWSECRET@h/x` verbatim.
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(options);
    source.emit(
      'error',
      netEvent({
        type: 'error',
        url: 'https://api/clean',
        custom: { error: 'failed http://u:PWSECRET@h/x' },
      }),
    );
    const captured = (await drainNetwork(store))?.[0]?.data as NetworkEvent;
    expect(captured.custom?.error).toBe('failed http://u:%3Credacted%3E@h/x');
  });
});

// ---------------------------------------------------------------------------------------------------
// URL ABSOLUTIZATION. Sources record whatever the caller passed, so a same-origin `fetch('/api/x')` was
// stored as `/api/x` while a cross-origin call was stored in full. The provider is the ONE choke point
// every mechanism passes through (fetch/xhr/sse/sendBeacon/ws/webtransport, and node:http via
// `additionalSources`), so absolutizing here covers all of them and anything added later.
//
// These tests drive the REAL integration path — the provider reads the ambient globals, exactly as it
// does in a browser — so the realm is installed on `globalThis` and torn down after. `absolutize-url.
// test.ts` covers realm SELECTION against injected realm objects; what is proven here is the WIRING:
// which branch it runs on, and where it sits relative to the sanitizer and the user filter.
// ---------------------------------------------------------------------------------------------------
const withPageRealm = async <T>(baseURI: string, run: () => Promise<T>): Promise<T> => {
  const g = globalThis as unknown as { document?: unknown };
  const had = 'document' in g;
  const prev = g.document;
  g.document = { baseURI };
  try {
    return await run();
  } finally {
    if (had) {
      g.document = prev;
    } else {
      delete g.document;
    }
  }
};

describe('network URL absolutization', () => {
  const emitAndDrain = async (
    event: NetworkEvent,
    opts: OptionsContainer = options,
  ): Promise<NetworkEvent> => {
    const store = mkStore();
    const source = mkSource();
    const p = createNetworkCaptureProvider(source);
    p.init(buildInit(store));
    p.start(opts);
    source.emit('complete', event);
    return (await drainNetwork(store))?.[0]?.data as NetworkEvent;
  };

  it('stores a same-origin relative URL with protocol, host and port', async () => {
    const captured = await withPageRealm('http://localhost:5398/index.html', () =>
      emitAndDrain(netEvent({ url: '/api/scenario/get' })),
    );
    expect(captured.url).toBe('http://localhost:5398/api/scenario/get');
  });

  it('does not mutate the source event', async () => {
    const event = netEvent({ url: '/api/scenario/get' });
    await withPageRealm('http://localhost:5398/index.html', () => emitAndDrain(event));
    expect(event.url).toBe('/api/scenario/get');
  });

  it('leaves an already-absolute cross-origin URL byte-identical', async () => {
    const captured = await withPageRealm('http://localhost:5398/index.html', () =>
      emitAndDrain(netEvent({ url: 'http://localhost:5399/nope' })),
    );
    expect(captured.url).toBe('http://localhost:5399/nope');
  });

  it('applies on the branch where the default sanitizer is DISABLED', async () => {
    // Absolutization is normalization, not redaction, so it runs before the filter/sanitizer XOR rather
    // than inside `sanitize()`. Putting it inside would leave this branch storing bare paths.
    const captured = await withPageRealm('https://app.example.com/', () =>
      emitAndDrain(
        netEvent({ url: '/api/x' }),
        createOptionsContainer({ [BugseeOption.CaptureNetworkDefaultSanitizer]: false }),
      ),
    );
    expect(captured.url).toBe('https://app.example.com/api/x');
  });

  it('hands the ABSOLUTE url to a user network filter', async () => {
    // The filter supersedes the sanitizer (XOR), so if absolutization sat inside `sanitize()` a user
    // filter would both see and store a bare path — and origin-based allow/deny rules could not work.
    const seen: string[] = [];
    const filters = createFilterStore(vi.fn());
    filters.network = (e) => {
      seen.push(e.url as string);
      return e;
    };
    publishFilters(filters);
    const captured = await withPageRealm('https://app.example.com/', () =>
      emitAndDrain(netEvent({ url: '/api/x' })),
    );
    expect(seen).toEqual(['https://app.example.com/api/x']);
    expect(captured.url).toBe('https://app.example.com/api/x');
  });

  it('leaves the URL relative on a location-less host (node/bun/deno server capture)', async () => {
    // node:http incoming requests fold into this same provider via `additionalSources` and carry a
    // path-only target. There is no client origin on a server, and inventing one would be a worse
    // defect than the missing one — so `/api/x` must stay `/api/x`.
    expect((globalThis as unknown as { document?: unknown }).document).toBeUndefined();
    expect((globalThis as unknown as { location?: unknown }).location).toBeUndefined();
    expect((await emitAndDrain(netEvent({ url: '/api/x' }))).url).toBe('/api/x');
  });

  it('survives a non-string url without dropping the entry', async () => {
    const captured = await withPageRealm('https://app.example.com/', () =>
      emitAndDrain(netEvent({ url: undefined as unknown as string })),
    );
    expect(captured).toBeDefined();
    expect(captured.url).toBeUndefined();
  });

  // PRIVACY ORDERING — the reason absolutization runs BEFORE `sanitizeUrl` and not after.
  // `sanitizeUrl` scans the PATH for `;`-delimited matrix parameters, and it locates the path as "the
  // first `/` at or after the authority". On a schemeless, path-relative target the authority window is
  // empty, so the path is taken to start at the first `/` IN THE STRING — which is AFTER the matrix
  // parameter. The secret then falls outside the scan window and ships in the clear. Absolutizing first
  // gives the sanitizer a real authority, the path window starts where the path really starts, and the
  // secret is redacted. Verified against the current sanitizer:
  //   sanitizeUrl('products;api_key=S/list')                     -> unchanged (LEAK)
  //   sanitizeUrl('https://app.example.com/products;api_key=S/list') -> api_key=<redacted>
  it('redacts a path secret that the sanitizer could not see while the URL was relative', async () => {
    const raw = 'products;api_key=MATRIXPATHSECRET/list';
    // Establish the "before" behaviour as part of the test, so this cannot quietly stop being a proof.
    expect(sanitizeUrl(raw)).toBe(raw); // the sanitizer alone does NOT catch it
    const captured = await withPageRealm('https://app.example.com/shop/', () =>
      emitAndDrain(netEvent({ url: raw })),
    );
    expect(captured.url).toBe('https://app.example.com/shop/products;api_key=%3Credacted%3E/list');
    expect(captured.url).not.toContain('MATRIXPATHSECRET');
  });
});
