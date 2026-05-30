import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUGSEE_SDK_VERSION,
  type BugseeCarrier,
  getCarrier,
  getCarrierClient,
  getInternal,
  getOrCreateInterceptor,
  setCarrierClient,
} from './carrier';
import type { Interceptor } from './contracts';

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
