import {
  type CaptureProviderInit,
  type CaptureStore,
  createCaptureAggregator,
  createCaptureExporter,
  createFilterStore,
  createMemoryCaptureStore,
  createMultiKeyEmitter,
  createOperationDispatcher,
  createOptionsContainer,
  type FilterStore,
  getCarrier,
  type MultiKeyEmitter,
  type OptionsContainer,
  setCarrierClient,
} from '@bugsee/core';
import { BugseeOption, type NetworkEvent, type NetworkStage } from '@bugsee/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FetchTarget } from './fetch-interceptor';
import { installNetworkCapture } from './install-network-capture';
import type { SendBeaconTarget } from './send-beacon-interceptor';

// installNetworkCapture now registers its network leaves on the process Carrier (default the real
// globalThis). Reset it between tests so each gets fresh interceptors (no cross-test reuse).
afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

type FetchFn = (input: unknown, init?: unknown) => Promise<unknown>;
const mkStore = (): CaptureStore =>
  createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
const buildInit = (store: CaptureStore): CaptureProviderInit => ({
  operations: createOperationDispatcher(),
  captureAggregator: createCaptureAggregator(store),
});
const options: OptionsContainer = createOptionsContainer();
const drainNetwork = async (store: CaptureStore) =>
  (await createCaptureExporter(store).drain()).get('network');
const netEvent = (over: Partial<NetworkEvent> = {}): NetworkEvent => ({
  timestamp: 1,
  id: 'n',
  sequence: 'n',
  mechanism: 'fetch',
  url: 'u',
  method: 'GET',
  type: 'complete',
  ...over,
});

describe('installNetworkCapture', () => {
  it('returns the umbrella interceptor + the network provider', () => {
    const { interceptor, provider } = installNetworkCapture();
    expect(interceptor.name).toBe('network');
    expect(provider.name).toBe('network');
    expect(provider.controllingOption).toBe(BugseeOption.CaptureNetwork);
  });

  it('captures end-to-end: starting the provider activates fetch and records before+complete', async () => {
    const store = mkStore();
    const resp = { status: 200, statusText: 'OK', redirected: false, headers: {} };
    let current: FetchFn = async () => resp;
    const fetchTarget: FetchTarget = {
      get: () => current,
      set: (fn) => {
        current = fn;
      },
    };
    const { provider } = installNetworkCapture({ now: () => 1, fetchTarget });
    provider.init(buildInit(store));
    provider.start(options); // provider → umbrella → fetch sub activates → wraps the target
    await current('https://api/x'); // the now-wrapped fetch
    const entries = await drainNetwork(store);
    expect(entries?.map((e) => (e.data as NetworkEvent).type)).toEqual(['before', 'complete']);
    expect(entries?.[0]?.type).toBe('network');
  });

  it('threads isInternal through to the request interceptors (self-isolated requests skipped)', async () => {
    const store = mkStore();
    const resp = { status: 200, statusText: 'OK', redirected: false, headers: {} };
    let current: FetchFn = async () => resp;
    const fetchTarget: FetchTarget = {
      get: () => current,
      set: (fn) => {
        current = fn;
      },
    };
    const { provider } = installNetworkCapture({
      now: () => 1,
      fetchTarget,
      isInternal: () => true,
    });
    provider.init(buildInit(store));
    provider.start(options);
    await current('https://api/x'); // isInternal → true → not captured
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });

  it('captures response bodies through the fetch interceptor by default (interceptor default-on)', async () => {
    const store = mkStore();
    const TE = (
      globalThis as unknown as { TextEncoder: new () => { encode: (s: string) => Uint8Array } }
    ).TextEncoder;
    const RS = (globalThis as unknown as { ReadableStream: new (s: object) => unknown })
      .ReadableStream;
    const bodyResp = () => ({
      status: 200,
      statusText: 'OK',
      redirected: false,
      headers: {
        forEach: (cb: (v: string, k: string) => void) => cb('text/plain', 'content-type'),
      },
      clone: () => ({
        body: new RS({
          pull(c: { enqueue: (x: unknown) => void; close: () => void }) {
            c.enqueue(new TE().encode('hello'));
            c.close();
          },
        }),
      }),
    });
    let current: FetchFn = async () => bodyResp();
    const fetchTarget: FetchTarget = {
      get: () => current,
      set: (fn) => {
        current = fn;
      },
    };
    const { provider } = installNetworkCapture({ now: () => 1, fetchTarget });
    provider.init(buildInit(store));
    provider.start(options);
    await current('https://api/x');
    await new Promise<void>((r) =>
      (globalThis as unknown as { setTimeout: (cb: () => void, ms: number) => void }).setTimeout(
        r,
        0,
      ),
    );
    const bodies = (await drainNetwork(store))?.map((e) => (e.data as NetworkEvent).custom?.body);
    expect(bodies).toContain('hello'); // the response body was captured (override amendment), gated+kept
  });

  it('threads captureBodies:false through so no response body is read', async () => {
    const store = mkStore();
    let cloned = 0;
    const bodyResp = () => ({
      status: 200,
      statusText: 'OK',
      redirected: false,
      headers: {},
      clone: () => {
        cloned += 1;
        return { body: null };
      },
    });
    let current: FetchFn = async () => bodyResp();
    const fetchTarget: FetchTarget = {
      get: () => current,
      set: (fn) => {
        current = fn;
      },
    };
    const { provider } = installNetworkCapture({ now: () => 1, fetchTarget, captureBodies: false });
    provider.init(buildInit(store));
    provider.start(options);
    await current('https://api/x');
    await new Promise<void>((r) =>
      (globalThis as unknown as { setTimeout: (cb: () => void, ms: number) => void }).setTimeout(
        r,
        0,
      ),
    );
    expect(cloned).toBe(0); // captureBodies:false → interceptor never clones/reads
  });

  it('threads maxBodyBytes through to the fetch interceptor (over-cap body → size_too_large)', async () => {
    const store = mkStore();
    const TE = (
      globalThis as unknown as { TextEncoder: new () => { encode: (s: string) => Uint8Array } }
    ).TextEncoder;
    const RS = (globalThis as unknown as { ReadableStream: new (s: object) => unknown })
      .ReadableStream;
    const bodyResp = () => ({
      status: 200,
      statusText: 'OK',
      redirected: false,
      headers: {
        forEach: (cb: (v: string, k: string) => void) => cb('text/plain', 'content-type'),
      },
      clone: () => ({
        body: new RS({
          pull(c: { enqueue: (x: unknown) => void; close: () => void }) {
            c.enqueue(new TE().encode('hello')); // 5 bytes > the 3-byte cap below
            c.close();
          },
        }),
      }),
    });
    let current: FetchFn = async () => bodyResp();
    const fetchTarget: FetchTarget = {
      get: () => current,
      set: (fn) => {
        current = fn;
      },
    };
    const { provider } = installNetworkCapture({ now: () => 1, fetchTarget, maxBodyBytes: 3 });
    provider.init(buildInit(store));
    provider.start(options);
    await current('https://api/x');
    await new Promise<void>((r) =>
      (globalThis as unknown as { setTimeout: (cb: () => void, ms: number) => void }).setTimeout(
        r,
        0,
      ),
    );
    const reasons = (await drainNetwork(store))?.map(
      (e) => (e.data as NetworkEvent).custom?.no_body_reason,
    );
    expect(reasons).toContain('size_too_large'); // the 3-byte cap was applied → body dropped
  });

  it('threads captureBodies through to the xhr interceptor (off → no response body)', async () => {
    // A fake XMLHttpRequest class wired via xhrTarget; with captureBodies:false the complete event must
    // carry no response body even though responseText is set.
    class FakeXhr {
      status = 200;
      statusText = 'OK';
      responseType = 'text';
      responseText = 'secret response';
      response: unknown = undefined;
      readonly #listeners = new Map<string, Array<() => void>>();
      open(): void {}
      send(): void {}
      setRequestHeader(): void {}
      addEventListener(type: string, cb: () => void): void {
        const a = this.#listeners.get(type) ?? [];
        a.push(cb);
        this.#listeners.set(type, a);
      }
      getAllResponseHeaders(): string {
        return 'content-type: text/plain\r\n';
      }
      fire(type: string): void {
        for (const cb of this.#listeners.get(type) ?? []) cb();
      }
    }
    const store = mkStore();
    const { provider } = installNetworkCapture({
      now: () => 1,
      xhrTarget: { get: () => FakeXhr },
      captureBodies: false,
    });
    provider.init(buildInit(store));
    provider.start(options);
    const xhr = new FakeXhr();
    xhr.open();
    xhr.send();
    xhr.fire('load');
    const completeBodies = (await drainNetwork(store))
      ?.filter((e) => (e.data as NetworkEvent).type === 'complete')
      .map((e) => (e.data as NetworkEvent).custom?.body);
    expect(completeBodies).toEqual([undefined]); // captureBodies:false threaded → no response body
  });

  it('threads maxBodyBytes through to the xhr interceptor (over-cap response → size_too_large)', async () => {
    class FakeXhr {
      status = 200;
      statusText = 'OK';
      responseType = 'text';
      responseText = 'way too long'; // > the 3-byte cap below
      response: unknown = undefined;
      readonly #listeners = new Map<string, Array<() => void>>();
      open(): void {}
      send(): void {}
      setRequestHeader(): void {}
      addEventListener(type: string, cb: () => void): void {
        const a = this.#listeners.get(type) ?? [];
        a.push(cb);
        this.#listeners.set(type, a);
      }
      getAllResponseHeaders(): string {
        return 'content-type: text/plain\r\n';
      }
      fire(type: string): void {
        for (const cb of this.#listeners.get(type) ?? []) cb();
      }
    }
    const store = mkStore();
    const { provider } = installNetworkCapture({
      now: () => 1,
      xhrTarget: { get: () => FakeXhr },
      maxBodyBytes: 3,
    });
    provider.init(buildInit(store));
    provider.start(options);
    const xhr = new FakeXhr();
    xhr.open();
    xhr.send();
    xhr.fire('load');
    const reasons = (await drainNetwork(store))
      ?.filter((e) => (e.data as NetworkEvent).type === 'complete')
      .map((e) => (e.data as NetworkEvent).custom?.no_body_reason);
    expect(reasons).toEqual(['size_too_large']); // maxBodyBytes:3 threaded to the xhr leaf
  });

  it('aggregates additionalSources (e.g. a node:http interceptor) into the umbrella', async () => {
    const store = mkStore();
    const extra: MultiKeyEmitter<Record<NetworkStage, NetworkEvent>> = createMultiKeyEmitter();
    const { provider } = installNetworkCapture({ additionalSources: [extra] });
    provider.init(buildInit(store));
    provider.start(options);
    extra.emit('complete', netEvent({ url: 'https://extra/' }));
    expect((await drainNetwork(store))?.map((e) => (e.data as NetworkEvent).url)).toEqual([
      'https://extra/',
    ]);
  });

  it('does not capture before the provider starts (subscriber-presence)', async () => {
    const store = mkStore();
    const extra: MultiKeyEmitter<Record<NetworkStage, NetworkEvent>> = createMultiKeyEmitter();
    const { provider } = installNetworkCapture({ additionalSources: [extra] });
    provider.init(buildInit(store));
    extra.emit('complete', netEvent()); // provider not started → umbrella idle → not forwarded
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });
});

// navigator.sendBeacon does not exist in the node test runtime, so the beacon leaf is driven through an
// injected target (the same seam fetchTarget/xhrTarget use). Calling `nav.sendBeacon(...)` after the
// provider starts exercises the installed wrapper exactly as an application would.
type BeaconFn = (url: unknown, data?: unknown) => boolean;
const beaconHost = (result = true) => {
  const nav = { sendBeacon: ((): boolean => result) as BeaconFn };
  const target: SendBeaconTarget = {
    get: () => nav.sendBeacon,
    set: (fn) => {
      nav.sendBeacon = fn;
    },
  };
  return { nav, target };
};
// Publish a filter store as the singleton client's `filters` service (the provider reads getFilters()).
const publishFilters = (store: FilterStore): void => {
  setCarrierClient({
    getService: (token: { name: string }) => (token.name === 'filters' ? store : undefined),
    getServiceProvider: () => undefined as never,
  });
};

describe('installNetworkCapture — sendBeacon', () => {
  it('captures a beacon end-to-end: before + complete carrying mechanism "sendBeacon"', async () => {
    const store = mkStore();
    const { nav, target } = beaconHost();
    const { provider } = installNetworkCapture({ now: () => 1, sendBeaconTarget: target });
    provider.init(buildInit(store));
    provider.start(options); // provider → umbrella → sendbeacon sub activates → wraps the target
    expect(nav.sendBeacon('https://api/collect', 'a=1')).toBe(true);
    const events = (await drainNetwork(store))?.map((e) => e.data as NetworkEvent);
    expect(events?.map((e) => e.type)).toEqual(['before', 'complete']);
    expect(events?.map((e) => e.mechanism)).toEqual(['sendBeacon', 'sendBeacon']);
    expect(events?.[0]?.method).toBe('POST');
    expect(events?.[0]?.custom?.body).toBe('a=1');
  });

  it('redacts a beacon URL and body with the built-in sanitizer (the privacy half of the gap)', async () => {
    const store = mkStore();
    const { nav, target } = beaconHost();
    const { provider } = installNetworkCapture({ now: () => 1, sendBeaconTarget: target });
    provider.init(buildInit(store));
    provider.start(options);
    nav.sendBeacon(
      'https://api/collect?token=super-secret',
      new (
        globalThis as unknown as { URLSearchParams: new (i: Record<string, string>) => object }
      ).URLSearchParams({ user: 'bob', password: 'hunter2' }),
    );
    const before = (await drainNetwork(store))?.map((e) => e.data as NetworkEvent)[0];
    expect(before?.url).not.toContain('super-secret'); // the URL went through sanitizeUrl
    expect(before?.custom?.body).not.toContain('hunter2'); // …and the body through sanitizeBody
    expect(before?.custom?.body).toContain('user=bob'); // non-sensitive fields survive
  });

  it('lets a user network filter REPLACE the sanitizer for beacon entries (Android XOR rule)', async () => {
    const store = mkStore();
    const { nav, target } = beaconHost();
    const filters = createFilterStore(vi.fn());
    let seen: NetworkEvent | undefined;
    filters.network = (e) => {
      seen = e; // identity: from here on the user owns redaction of beacon traffic
      return e;
    };
    publishFilters(filters);
    const { provider } = installNetworkCapture({ now: () => 1, sendBeaconTarget: target });
    provider.init(buildInit(store));
    provider.start(options);
    nav.sendBeacon('https://api/collect?token=super-secret', 'x');
    const before = (await drainNetwork(store))?.map((e) => e.data as NetworkEvent)[0];
    expect(seen?.mechanism).toBe('sendBeacon'); // the user filter saw the beacon…
    // …and the default sanitizer did NOT also run: the secret the identity filter kept is still there.
    expect(before?.url).toBe('https://api/collect?token=super-secret');
  });

  it('drops a beacon entry the user network filter vetoes', async () => {
    const store = mkStore();
    const { nav, target } = beaconHost();
    const filters = createFilterStore(vi.fn());
    filters.network = () => null;
    publishFilters(filters);
    const { provider } = installNetworkCapture({ now: () => 1, sendBeaconTarget: target });
    provider.init(buildInit(store));
    provider.start(options);
    expect(nav.sendBeacon('https://api/collect', 'x')).toBe(true); // still sent
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });

  it('applies the shared body policy to beacon bodies (size limit → size_too_large)', async () => {
    const store = mkStore();
    const { nav, target } = beaconHost();
    const { provider } = installNetworkCapture({ now: () => 1, sendBeaconTarget: target });
    provider.init(buildInit(store));
    provider.start(createOptionsContainer({ [BugseeOption.CaptureNetworkBodySizeLimit]: 3 }));
    nav.sendBeacon('https://api/collect', 'way too long');
    const before = (await drainNetwork(store))?.map((e) => e.data as NetworkEvent)[0];
    expect(before?.custom?.body).toBeNull();
    expect(before?.custom?.no_body_reason).toBe('size_too_large');
  });

  it('applies the master body toggle to beacon bodies (captureNetworkBodies off → null)', async () => {
    const store = mkStore();
    const { nav, target } = beaconHost();
    const { provider } = installNetworkCapture({ now: () => 1, sendBeaconTarget: target });
    provider.init(buildInit(store));
    provider.start(createOptionsContainer({ [BugseeOption.CaptureNetworkBodies]: false }));
    nav.sendBeacon('https://api/collect', 'a=1');
    const before = (await drainNetwork(store))?.map((e) => e.data as NetworkEvent)[0];
    expect(before?.custom?.body).toBeNull();
  });

  it('threads isInternal through to the sendBeacon leaf (self-isolated beacons skipped)', async () => {
    const store = mkStore();
    const { nav, target } = beaconHost();
    const { provider } = installNetworkCapture({
      now: () => 1,
      sendBeaconTarget: target,
      isInternal: (url) => url.includes('bugsee'),
    });
    provider.init(buildInit(store));
    provider.start(options);
    expect(nav.sendBeacon('https://collector.bugsee.com/upload', 'x')).toBe(true); // still sent
    expect((await createCaptureExporter(store).drain()).size).toBe(0);
  });

  it('does not patch sendBeacon before the provider starts, and unpatches when it stops', () => {
    const { nav, target } = beaconHost();
    const original = nav.sendBeacon;
    const { provider } = installNetworkCapture({ sendBeaconTarget: target });
    provider.init(buildInit(mkStore()));
    expect(nav.sendBeacon).toBe(original); // idle → the global is untouched
    provider.start(options);
    expect(nav.sendBeacon).not.toBe(original);
    provider.stop();
    expect(nav.sendBeacon).toBe(original);
  });
});

describe('installNetworkCapture — carrier (process-global leaf singletons)', () => {
  const LEAF_NAMES = ['fetch', 'sendbeacon', 'sse', 'websocket', 'webtransport', 'xhr'];

  it('registers each network leaf on the carrier by name', () => {
    const carrier = {};
    installNetworkCapture({ carrier });
    expect([...getCarrier(carrier).interceptors.keys()].sort()).toEqual(LEAF_NAMES);
  });

  it('reuses the SAME leaf instances on a second install sharing the carrier (one patch)', () => {
    const carrier = {}; // a single process global both "module copies" see
    installNetworkCapture({ carrier });
    const first = getCarrier(carrier).interceptors.get('fetch');
    installNetworkCapture({ carrier }); // a duplicated copy installs again
    expect(getCarrier(carrier).interceptors.get('fetch')).toBe(first); // not a second instance
    expect(getCarrier(carrier).interceptors.size).toBe(6); // leaves not doubled
  });

  it('builds fresh leaves for a different carrier', () => {
    const a = {};
    const b = {};
    installNetworkCapture({ carrier: a });
    installNetworkCapture({ carrier: b });
    expect(getCarrier(a).interceptors.get('fetch')).not.toBe(
      getCarrier(b).interceptors.get('fetch'),
    );
  });
});
