import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUGSEE_SDK_VERSION,
  type BugseeCarrier,
  clearCarrierClient,
  contributeServiceManifest,
  getCarrier,
  getCarrierBlackout,
  getCarrierClient,
  getCarrierLifecycleSlot,
  getCarrierPendingLaunch,
  getCarrierStatus,
  getFilters,
  getInternal,
  getOrCreateInterceptor,
  getProcessStatus,
  getServiceManifests,
  type ServiceManifest,
  sealCarrierLifecycleSlot,
  setCarrierBlackout,
  setCarrierClient,
  setCarrierLastLaunch,
  setCarrierPendingLaunch,
  setCarrierStatus,
  setProcessLifecycleEventsListener,
} from './carrier';
import type { Interceptor } from './contracts';
import { BugseeStatus } from './launch-status';

// A minimal Interceptor stand-in: the carrier only stores/returns the instance (never calls its
// methods), so identity is all that matters.
const fakeInterceptor = (name: string): Interceptor<unknown> =>
  ({ name }) as unknown as Interceptor<unknown>;

// The real globalThis must be left pristine — default-arg paths write to globalThis.__BUGSEE__.
afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('getCarrier', () => {
  it('creates a version-keyed slot on a fresh global', () => {
    const g = {};
    const carrier = getCarrier(g);
    expect(carrier.version).toBe(BUGSEE_SDK_VERSION);
    expect(carrier.interceptors).toBeInstanceOf(Map);
    expect(carrier.interceptors.size).toBe(0);
    // Stored under globalObj.__BUGSEE__[version].
    const host = g as { __BUGSEE__: Record<string, BugseeCarrier> };
    expect(host.__BUGSEE__[BUGSEE_SDK_VERSION]).toBe(carrier);
  });

  it('returns the SAME slot on repeated calls (the module-duplication convergence point)', () => {
    const g = {};
    const first = getCarrier(g);
    const second = getCarrier(g);
    expect(second).toBe(first); // identity — two "copies" sharing one global converge
    expect(second.interceptors).toBe(first.interceptors);
  });

  it('reuses a pre-existing registry rather than overwriting it', () => {
    const g = {};
    const a = getCarrier(g);
    a.interceptors.set('marker', fakeInterceptor('marker'));
    const b = getCarrier(g);
    expect(b.interceptors.get('marker')?.name).toBe('marker'); // not wiped
  });

  it('uses a null-prototype registry (no prototype pollution from a version-like key)', () => {
    const g = {};
    getCarrier(g);
    const host = g as { __BUGSEE__: object };
    expect(Object.getPrototypeOf(host.__BUGSEE__)).toBeNull();
  });

  it('defaults to the real globalThis when no global is supplied', () => {
    const carrier = getCarrier();
    expect(carrier.version).toBe(BUGSEE_SDK_VERSION);
    expect(
      (globalThis as { __BUGSEE__?: Record<string, unknown> }).__BUGSEE__?.[BUGSEE_SDK_VERSION],
    ).toBe(carrier);
  });
});

describe('getOrCreateInterceptor', () => {
  it('creates the interceptor via the factory on first request and stores it on the carrier', () => {
    const g = {};
    const made = fakeInterceptor('fetch');
    const result = getOrCreateInterceptor('fetch', () => made, g);
    expect(result).toBe(made);
    expect(getCarrier(g).interceptors.get('fetch')).toBe(made);
  });

  it('returns the SAME instance and does NOT re-invoke the factory on a later request', () => {
    const g = {};
    const first = fakeInterceptor('fetch');
    const secondFactory = vi.fn(() => fakeInterceptor('fetch-2'));
    getOrCreateInterceptor('fetch', () => first, g);
    const result = getOrCreateInterceptor('fetch', secondFactory, g);
    expect(result).toBe(first); // shared singleton — first config wins
    expect(secondFactory).not.toHaveBeenCalled();
  });

  it('keeps distinct names as distinct instances', () => {
    const g = {};
    const fetch = getOrCreateInterceptor('fetch', () => fakeInterceptor('fetch'), g);
    const xhr = getOrCreateInterceptor('xhr', () => fakeInterceptor('xhr'), g);
    expect(xhr).not.toBe(fetch);
    expect(getCarrier(g).interceptors.size).toBe(2);
  });

  it('converges two module copies on one instance via a shared global', () => {
    const sharedGlobal = {}; // both "copies" see the same globalThis
    const copyA = getOrCreateInterceptor(
      'console',
      () => fakeInterceptor('console-A'),
      sharedGlobal,
    );
    const copyBFactory = vi.fn(() => fakeInterceptor('console-B'));
    const copyB = getOrCreateInterceptor('console', copyBFactory, sharedGlobal);
    expect(copyB).toBe(copyA); // one patch, not two
    expect(copyBFactory).not.toHaveBeenCalled();
  });

  it('defaults to the real globalThis when no global is supplied', () => {
    const made = fakeInterceptor('console');
    const result = getOrCreateInterceptor('console', () => made);
    expect(result).toBe(made);
    expect(getCarrier().interceptors.get('console')).toBe(made);
  });
});

describe('getCarrierClient / setCarrierClient (per-process singleton slot)', () => {
  it('is undefined until a client is set', () => {
    const g = {};
    expect(getCarrierClient(g)).toBeUndefined();
  });

  it('stores and returns the client, and clears it with undefined', () => {
    const g = {};
    const client = { id: 'the-client' };
    setCarrierClient(client, g);
    expect(getCarrierClient(g)).toBe(client);
    expect(getCarrier(g).client).toBe(client); // stored on the slot
    setCarrierClient(undefined, g);
    expect(getCarrierClient(g)).toBeUndefined();
  });

  it('defaults to the real globalThis when no global is supplied', () => {
    const client = { id: 'global-client' };
    setCarrierClient(client);
    expect(getCarrierClient()).toBe(client);
  });
});

describe('clearCarrierClient (release only your own slot)', () => {
  it('clears the slot when it still holds the given client', () => {
    const g = {};
    const client = { id: 'a' };
    setCarrierClient(client, g);
    clearCarrierClient(client, g);
    expect(getCarrierClient(g)).toBeUndefined();
  });

  it('leaves a NEWER client in the slot (a stale stop() must not evict a relaunch)', () => {
    const g = {};
    const oldClient = { id: 'old' };
    const newClient = { id: 'new' };
    setCarrierClient(newClient, g);
    clearCarrierClient(oldClient, g);
    expect(getCarrierClient(g)).toBe(newClient);
  });

  it('defaults to the real globalThis', () => {
    const client = { id: 'g' };
    setCarrierClient(client);
    clearCarrierClient(client);
    expect(getCarrierClient()).toBeUndefined();
  });
});

describe('getCarrierStatus / setCarrierStatus (process lifecycle state)', () => {
  it('is Stopped until set, and stores each status', () => {
    const g = {};
    expect(getCarrierStatus(g)).toBe(BugseeStatus.Stopped);
    setCarrierStatus(BugseeStatus.Launching, g);
    expect(getCarrierStatus(g)).toBe(BugseeStatus.Launching);
    setCarrierStatus(BugseeStatus.Launched, g);
    expect(getCarrier(g).status).toBe(BugseeStatus.Launched);
  });

  it('defaults to the real globalThis', () => {
    setCarrierStatus(BugseeStatus.Stopping);
    expect(getCarrierStatus()).toBe(BugseeStatus.Stopping);
  });
});

describe('getProcessStatus', () => {
  it("reports the launched client's own status over the carrier's", () => {
    const g = {};
    setCarrierStatus(BugseeStatus.Launching, g);
    setCarrierClient({ getStatus: () => BugseeStatus.Stopped }, g); // e.g. a killed SDK
    expect(getProcessStatus(g)).toBe(BugseeStatus.Stopped);
    setCarrierClient({ getStatus: () => BugseeStatus.Launched }, g);
    expect(getProcessStatus(g)).toBe(BugseeStatus.Launched);
  });

  it("falls back to the carrier's status with no client (Launching / Stopping / Stopped)", () => {
    const g = {};
    expect(getProcessStatus(g)).toBe(BugseeStatus.Stopped);
    setCarrierStatus(BugseeStatus.Launching, g);
    expect(getProcessStatus(g)).toBe(BugseeStatus.Launching);
  });

  it('defaults to the real globalThis', () => {
    setCarrierStatus(BugseeStatus.Stopping);
    expect(getProcessStatus()).toBe(BugseeStatus.Stopping);
  });
});

describe('setCarrierLastLaunch', () => {
  it('stores the token on the carrier slot', () => {
    const g = {};
    setCarrierLastLaunch('tok', { a: 1 }, g);
    expect(getCarrier(g).lastLaunch?.appToken).toBe('tok');
  });

  // L18: the slot lives on globalThis, readable by any script in the process. It keeps only what
  // relaunch() needs to find its way back, never the host's options wholesale.
  it('keeps the integration seams relaunch needs, never a host Bugsee option, header or identifier', () => {
    const g = {};
    const clock = { now: () => 1 };
    const scheduler = { setInterval: () => 'h' };
    setCarrierLastLaunch(
      'tok',
      {
        carrier: g,
        clock,
        scheduler,
        transport: () => 'bearer',
        onError: () => {},
        headers: { authorization: 'Bearer SECRET' },
        endpoint: 'https://x.test',
        captureLogs: false,
        userIdentifier: 'a@b.c',
      },
      g,
    );
    const retained = getCarrier(g).lastLaunch?.options as Record<string, unknown>;
    expect(Object.keys(retained).sort()).toEqual([
      'carrier',
      'clock',
      'endpoint', // deployment identity (R2P-3): a relaunch must not fall back to the production endpoint
      'onError',
      'scheduler',
      'transport',
    ]);
    expect(retained.carrier).toBe(g);
    expect(retained.clock).toBe(clock);
    expect(retained.scheduler).toBe(scheduler);
  });

  it('remembers a custom carrier host on the default slot, and forgets it on the next default launch (R2L-12)', () => {
    const x = {};
    setCarrierLastLaunch('tok', { carrier: x }, x);
    expect(getCarrier().lastHost).toBe(x);
    setCarrierLastLaunch('tok', {}, undefined);
    expect(getCarrier().lastHost).toBeUndefined();
    setCarrierLastLaunch('tok', { carrier: globalThis }, globalThis);
    expect(getCarrier().lastHost).toBeUndefined();
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  });

  it('retains nothing for absent or non-object options', () => {
    const g = {};
    setCarrierLastLaunch('tok', undefined, g);
    expect(getCarrier(g).lastLaunch?.options).toEqual({});
    setCarrierLastLaunch('tok', 'not-an-object', g);
    expect(getCarrier(g).lastLaunch?.options).toEqual({});
    setCarrierLastLaunch('tok', null, g);
    expect(getCarrier(g).lastLaunch?.options).toEqual({});
  });

  it('omits a seam the host did not set (no explicit undefined keys)', () => {
    const g = {};
    setCarrierLastLaunch('tok', { clock: undefined }, g);
    expect('clock' in (getCarrier(g).lastLaunch?.options as object)).toBe(false);
  });

  it('defaults to the real globalThis', () => {
    setCarrierLastLaunch('tok2', undefined);
    expect(getCarrier().lastLaunch?.appToken).toBe('tok2');
  });
});

describe('getInternal (the singleton client as a service resolver)', () => {
  it('is undefined when no client is launched', () => {
    expect(getInternal({})).toBeUndefined();
  });

  it('returns the carrier client (which IS a service resolver)', () => {
    const g = {};
    const resolver = { getService: vi.fn(() => 1), getServiceProvider: vi.fn() };
    setCarrierClient(resolver, g);
    expect(getInternal(g)).toBe(resolver);
  });
});

describe('getFilters (the singleton client filters service)', () => {
  it('is undefined when no client is launched', () => {
    expect(getFilters({})).toBeUndefined();
  });

  it('returns the client filters service', () => {
    const g = {};
    const filterStore = { network: null };
    setCarrierClient(
      {
        getService: (token: { name: string }) =>
          token.name === 'filters' ? filterStore : undefined,
        getServiceProvider: vi.fn(),
      },
      g,
    );
    expect(getFilters(g)).toBe(filterStore);
  });
});

describe('service manifests', () => {
  const noop: ServiceManifest = () => {};

  it('returns no manifests by default', () => {
    expect(getServiceManifests({})).toEqual([]);
  });

  it('appends contributed manifests in contribution order', () => {
    const host = {};
    const m1: ServiceManifest = () => {};
    const m2: ServiceManifest = () => {};
    contributeServiceManifest(m1, host);
    contributeServiceManifest(m2, host);
    expect(getServiceManifests(host)).toEqual([m1, m2]);
  });

  it('isolates manifests per carrier host (a fresh host sees none)', () => {
    const a = {};
    const b = {};
    contributeServiceManifest(noop, a);
    expect(getServiceManifests(a)).toEqual([noop]);
    expect(getServiceManifests(b)).toEqual([]);
  });
});

describe('process-level lifecycle listener (L1)', () => {
  it('is held on the carrier slot, shared by every reader of the same host, and cleared with null', () => {
    const g = {};
    const listener = vi.fn();
    setProcessLifecycleEventsListener(listener, g);
    expect(getCarrierLifecycleSlot(g).get()).toBe(listener);
    getCarrierLifecycleSlot(g).set(null);
    expect(getCarrierLifecycleSlot(g).get()).toBeNull();
    expect(getCarrierLifecycleSlot({}).get()).toBeNull(); // another host is untouched
  });

  it('defaults to nothing', () => {
    expect(getCarrierLifecycleSlot({}).get()).toBeNull();
  });

  describe('sealCarrierLifecycleSlot (R5L-1)', () => {
    const pageView = (g: object): Record<string, unknown> =>
      (g as { __BUGSEE__: Record<string, Record<string, unknown>> }).__BUGSEE__[
        BUGSEE_SDK_VERSION
      ] as Record<string, unknown>;

    it('moves the listener and delivery queue off the carrier: page writes cannot install a listener', () => {
      const g = {};
      const owner = vi.fn();
      setProcessLifecycleEventsListener(owner, g);
      sealCarrierLifecycleSlot(g);
      const slot = getCarrierLifecycleSlot(g);
      expect(slot.get()).toBe(owner); // the pre-seal listener survived the move

      const page = vi.fn();
      expect(() => {
        pageView(g).lifecycleListener = page;
      }).toThrow(TypeError); // strict mode; sloppy page script is silently ignored
      expect(pageView(g).lifecycleListener).toBeUndefined();
      expect(slot.get()).toBe(owner);
      expect(() => {
        pageView(g).lifecycleDelivery = { queue: [], delivering: false };
      }).toThrow(TypeError);
      expect(pageView(g).lifecycleDelivery).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(pageView(g), 'lifecycleListener')?.configurable).toBe(
        false,
      );

      // the owner still sets and reads, through the same module-private state, from any later reader
      const next = vi.fn();
      slot.set(next);
      expect(getCarrierLifecycleSlot(g).get()).toBe(next);
      setProcessLifecycleEventsListener(null, g);
      expect(getCarrierLifecycleSlot(g).get()).toBeNull();
      expect(getCarrierLifecycleSlot(g).delivery).toBe(slot.delivery);
    });

    it('is idempotent and per carrier', () => {
      const g = {};
      const other = {};
      sealCarrierLifecycleSlot(g);
      const delivery = getCarrierLifecycleSlot(g).delivery;
      setProcessLifecycleEventsListener(vi.fn(), g);
      sealCarrierLifecycleSlot(g); // second seal keeps the state
      expect(getCarrierLifecycleSlot(g).delivery).toBe(delivery);
      expect(getCarrierLifecycleSlot(g).get()).not.toBeNull();
      // `other` is not sealed: still an ordinary writable slot
      setProcessLifecycleEventsListener(vi.fn(), other);
      expect(pageView(other).lifecycleListener).toBeTypeOf('function');
    });
  });
});

describe('process-level blackout flag (V2)', () => {
  it('defaults to false and is per host', () => {
    const g = {};
    expect(getCarrierBlackout(g)).toBe(false);
    setCarrierBlackout(true, g);
    expect(getCarrierBlackout(g)).toBe(true);
    expect(getCarrierBlackout({})).toBe(false);
    setCarrierBlackout(false, g);
    expect(getCarrierBlackout(g)).toBe(false);
  });
});

describe('in-flight launch (L13)', () => {
  it('is recorded and cleared per host', () => {
    const g = {};
    expect(getCarrierPendingLaunch(g)).toBeUndefined();
    const pending = Promise.resolve();
    setCarrierPendingLaunch(pending, g);
    expect(getCarrierPendingLaunch(g)).toBe(pending);
    expect(getCarrierPendingLaunch({})).toBeUndefined();
    setCarrierPendingLaunch(undefined, g);
    expect(getCarrierPendingLaunch(g)).toBeUndefined();
  });
});
