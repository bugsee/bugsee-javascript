import { describe, expect, it, vi } from 'vitest';
import { createServiceContainer, defineService, serviceToken } from './index';

// Reusable contract tokens for the mechanics tests (name carries the identity; phantom type unused).
const S = serviceToken('s');
const Clock = serviceToken('clock');
const Storage = serviceToken('storage');
const Missing = serviceToken('missing');

describe('defineService', () => {
  it('defaults to LAZY mode', () => {
    expect(defineService(S, () => 1).mode).toBe('LAZY');
  });

  it('honors an explicit mode', () => {
    expect(defineService(S, () => 1, 'EXPLICIT').mode).toBe('EXPLICIT');
  });
});

describe('ServiceContainer / Provider (LAZY)', () => {
  it('getProvider exposes the requested name', () => {
    const c = createServiceContainer();
    expect(c.getProvider(Clock).name).toBe('clock');
    expect(c.getProvider(Storage).name).toBe('storage');
  });

  it('returns the same provider instance for a name', () => {
    const c = createServiceContainer();
    expect(c.getProvider(Clock)).toBe(c.getProvider(Clock));
  });

  it('keys by token name, not token identity (distinct same-name tokens converge)', () => {
    // The container is keyed by `token.name`, so two DISTINCT token objects sharing a name resolve to
    // the SAME provider — the property that lets duplicated module copies (each minting its own token
    // object for one contract) converge on one registration. Object-identity keying would break this.
    const c = createServiceContainer();
    const tokenA = serviceToken<{ v: number }>('shared');
    const tokenB = serviceToken<{ v: number }>('shared');
    expect(tokenA).not.toBe(tokenB); // genuinely different objects
    expect(c.getProvider(tokenA)).toBe(c.getProvider(tokenB)); // same provider
    c.addService(defineService(tokenA, () => ({ v: 7 })));
    expect(c.getProvider(tokenB).getImmediate()).toEqual({ v: 7 }); // registered via A, resolved via B
  });

  it('lazily instantiates on first getImmediate, exactly once (singleton)', () => {
    const c = createServiceContainer();
    const factory = vi.fn(() => ({ v: 1 }));
    c.addService(defineService(S, factory));
    const a = c.getProvider(S).getImmediate();
    const b = c.getProvider(S).getImmediate();
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('passes the container to the factory', () => {
    const c = createServiceContainer();
    let received: unknown;
    c.addService(
      defineService(S, (container) => {
        received = container;
        return 1;
      }),
    );
    c.getProvider(S).getImmediate();
    expect(received).toBe(c);
  });

  it('getImmediate throws "is not registered" before registration', () => {
    expect(() => createServiceContainer().getProvider(Missing).getImmediate()).toThrow(
      /is not registered/,
    );
  });

  it('getImmediate({ optional: true }) returns null before registration', () => {
    expect(
      createServiceContainer().getProvider(Missing).getImmediate({ optional: true }),
    ).toBeNull();
  });

  it('isServiceSet / isInitialized track the lifecycle', () => {
    const c = createServiceContainer();
    const p = c.getProvider(S);
    expect(p.isServiceSet()).toBe(false);
    expect(p.isInitialized()).toBe(false);
    c.addService(defineService(S, () => 1));
    expect(p.isServiceSet()).toBe(true);
    expect(p.isInitialized()).toBe(false);
    p.getImmediate();
    expect(p.isInitialized()).toBe(true);
  });

  it('registering the same name twice throws "already registered"', () => {
    const c = createServiceContainer();
    c.addService(defineService(S, () => 1));
    expect(() => c.addService(defineService(S, () => 2))).toThrow(/already registered/);
  });
});

describe('async get() + late registration', () => {
  it('resolves after late LAZY registration', async () => {
    const c = createServiceContainer();
    const promise = c.getProvider(S).get(); // pending: not registered yet
    c.addService(defineService(S, () => 42));
    await expect(promise).resolves.toBe(42);
  });

  it('resolves with the cached instance when already instantiated, without re-running the factory', async () => {
    const c = createServiceContainer();
    const factory = vi.fn(() => ({ v: 1 }));
    c.addService(defineService(S, factory));
    const eager = c.getProvider(S).getImmediate();
    await expect(c.getProvider(S).get()).resolves.toBe(eager);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('get() and getImmediate() yield the same instance', async () => {
    const c = createServiceContainer();
    c.addService(defineService(S, () => ({ v: 1 })));
    const fromGet = await c.getProvider(S).get();
    expect(c.getProvider(S).getImmediate()).toBe(fromGet);
  });

  it('get() called twice while pending shares one pending promise', async () => {
    const c = createServiceContainer();
    c.addService(defineService(S, () => 9, 'EXPLICIT'));
    const p = c.getProvider(S);
    const a = p.get();
    const b = p.get(); // deferred already exists -> reused, not recreated
    expect(a).toBe(b);
    p.initialize();
    await expect(a).resolves.toBe(9);
  });

  it('late EXPLICIT registration keeps a pending get() pending until initialize', async () => {
    const c = createServiceContainer();
    const p = c.getProvider(S);
    const pending = p.get(); // pending, not registered
    c.addService(defineService(S, () => 5, 'EXPLICIT')); // setService must NOT instantiate (EXPLICIT)
    const sentinel = Symbol('pending');
    expect(await Promise.race([pending, Promise.resolve(sentinel)])).toBe(sentinel);
    p.initialize();
    await expect(pending).resolves.toBe(5);
  });
});

describe('EXPLICIT mode', () => {
  it('getImmediate throws "must be initialized" before initialize', () => {
    const c = createServiceContainer();
    c.addService(defineService(S, () => 1, 'EXPLICIT'));
    expect(() => c.getProvider(S).getImmediate()).toThrow(/must be initialized/);
  });

  it('getImmediate({ optional: true }) returns null before initialize', () => {
    const c = createServiceContainer();
    c.addService(defineService(S, () => 1, 'EXPLICIT'));
    expect(c.getProvider(S).getImmediate({ optional: true })).toBeNull();
  });

  it('initialize instantiates with options; getImmediate then returns it', () => {
    const c = createServiceContainer();
    c.addService(defineService(S, (_c, opts) => ({ opts }), 'EXPLICIT'));
    const inst = c.getProvider(S).initialize({ a: 1 });
    expect(inst).toEqual({ opts: { a: 1 } });
    expect(c.getProvider(S).getImmediate()).toBe(inst);
  });

  it('get() stays pending until initialize', async () => {
    const c = createServiceContainer();
    c.addService(defineService(S, () => 5, 'EXPLICIT'));
    const promise = c.getProvider(S).get();
    c.getProvider(S).initialize();
    await expect(promise).resolves.toBe(5);
  });
});

describe('initialize errors', () => {
  it('throws "is not registered" when not registered', () => {
    expect(() => createServiceContainer().getProvider(S).initialize()).toThrow(/is not registered/);
  });

  it('throws "already initialized" when already initialized', () => {
    const c = createServiceContainer();
    c.addService(defineService(S, () => 1, 'EXPLICIT'));
    c.getProvider(S).initialize();
    expect(() => c.getProvider(S).initialize()).toThrow(/already initialized/);
  });

  it('re-throws a cached failure instead of retrying the factory', () => {
    const c = createServiceContainer();
    const boom = new Error('boom');
    const factory = vi.fn(() => {
      throw boom;
    });
    c.addService(defineService(S, factory, 'EXPLICIT'));
    const p = c.getProvider(S);
    expect(() => p.initialize()).toThrow(boom); // first: factory fails, caches
    expect(() => p.initialize()).toThrow(boom); // second: cached failure re-thrown, no retry
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('clearInstance', () => {
  it('drops the instance and re-instantiates on next access', () => {
    const c = createServiceContainer();
    const factory = vi.fn(() => ({ v: 1 }));
    c.addService(defineService(S, factory));
    const p = c.getProvider(S);
    p.getImmediate();
    p.clearInstance();
    expect(p.isInitialized()).toBe(false);
    p.getImmediate();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('rejects a pending get() with "cleared before it initialized"', async () => {
    const c = createServiceContainer();
    const pending = c.getProvider(S).get();
    c.getProvider(S).clearInstance();
    await expect(pending).rejects.toThrow(/cleared before it initialized/);
  });

  it('lets a fresh get() resolve after a pending one was rejected (deferred reset)', async () => {
    const c = createServiceContainer();
    const p = c.getProvider(S);
    const first = p.get();
    p.clearInstance();
    await expect(first).rejects.toThrow();
    const second = p.get();
    c.addService(defineService(S, () => 7));
    await expect(second).resolves.toBe(7);
  });

  it('clears an instance created via get() without corrupting the resolved promise, and re-instantiates', async () => {
    const c = createServiceContainer();
    let calls = 0;
    c.addService(
      defineService(S, () => {
        calls += 1;
        return { v: calls };
      }),
    );
    const p = c.getProvider(S);
    const promise = p.get(); // creates + (LAZY) resolves the deferred
    const first = await promise;
    p.clearInstance(); // rejects an already-settled deferred -> harmless no-op
    await expect(promise).resolves.toBe(first); // the original resolved promise is unaffected
    expect(p.getImmediate()).not.toBe(first); // re-instantiated
    expect(calls).toBe(2);
  });

  it('recovers after a factory failure once cleared (failure reset)', () => {
    const c = createServiceContainer();
    let shouldThrow = true;
    c.addService(
      defineService(S, () => {
        if (shouldThrow) {
          throw new Error('boom');
        }
        return 42;
      }),
    );
    const p = c.getProvider(S);
    expect(() => p.getImmediate()).toThrow('boom');
    p.clearInstance();
    shouldThrow = false;
    expect(p.getImmediate()).toBe(42);
  });
});

describe('factory failure', () => {
  it('getImmediate throws the factory error', () => {
    const c = createServiceContainer();
    const boom = new Error('boom');
    c.addService(
      defineService(S, () => {
        throw boom;
      }),
    );
    expect(() => c.getProvider(S).getImmediate()).toThrow(boom);
  });

  it('get() rejects with the factory error on late registration', async () => {
    const c = createServiceContainer();
    const boom = new Error('boom');
    const promise = c.getProvider(S).get();
    c.addService(
      defineService(S, () => {
        throw boom;
      }),
    );
    await expect(promise).rejects.toBe(boom);
  });

  it('caches the failure: factory is not re-run, and a later get()/getImmediate also fail', async () => {
    const c = createServiceContainer();
    const boom = new Error('boom');
    const factory = vi.fn(() => {
      throw boom;
    });
    c.addService(defineService(S, factory));
    const p = c.getProvider(S);
    expect(() => p.getImmediate()).toThrow(boom);
    expect(() => p.getImmediate()).toThrow(boom); // re-throws cached failure, no re-run
    await expect(p.get()).rejects.toBe(boom);
    expect(p.getImmediate({ optional: true })).toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('re-entrancy', () => {
  it('detects a self-referential factory (getImmediate) instead of double-instantiating', () => {
    const c = createServiceContainer();
    c.addService(
      defineService(S, (container) => {
        container.getProvider(S).getImmediate(); // self-cycle during construction
        return 1;
      }),
    );
    expect(() => c.getProvider(S).getImmediate()).toThrow(/circular/);
  });

  it('reports a circular error (not "must be initialized") for an EXPLICIT self-cycle via getImmediate', () => {
    const c = createServiceContainer();
    c.addService(
      defineService(
        S,
        (container) => {
          container.getProvider(S).getImmediate();
          return 1;
        },
        'EXPLICIT',
      ),
    );
    expect(() => c.getProvider(S).initialize()).toThrow(/circular/);
  });

  it('a re-entrant get() during construction does not re-run the factory and resolves to the instance', async () => {
    const c = createServiceContainer();
    let calls = 0;
    let inner: Promise<unknown> | undefined;
    c.addService(
      defineService(S, (container) => {
        calls += 1;
        // Re-entrant get(): instantiate()'s guard prevents a second build; this pending deferred
        // is the provider's own, so the outer construction resolves it once it completes.
        inner = container.getProvider(S).get();
        return 1;
      }),
    );
    expect(c.getProvider(S).getImmediate()).toBe(1);
    expect(calls).toBe(1);
    await expect(inner).resolves.toBe(1);
  });
});

describe('onInit', () => {
  it('fires when the instance is created', () => {
    const c = createServiceContainer();
    c.addService(defineService(S, () => ({ v: 1 })));
    const cb = vi.fn();
    const p = c.getProvider(S);
    p.onInit(cb);
    p.getImmediate();
    expect(cb).toHaveBeenCalledWith({ v: 1 });
  });

  it('fires immediately if the instance already exists', () => {
    const c = createServiceContainer();
    c.addService(defineService(S, () => 1));
    const p = c.getProvider(S);
    p.getImmediate();
    const cb = vi.fn();
    p.onInit(cb);
    expect(cb).toHaveBeenCalledWith(1);
  });

  it('unsubscribe stops future calls', () => {
    const c = createServiceContainer();
    c.addService(defineService(S, () => 1));
    const p = c.getProvider(S);
    const cb = vi.fn();
    p.onInit(cb)();
    p.getImmediate();
    expect(cb).not.toHaveBeenCalled();
  });

  it('a throwing onInit callback does not break instantiation or other callbacks', () => {
    const c = createServiceContainer();
    c.addService(defineService(S, () => ({ v: 1 })));
    const p = c.getProvider(S);
    p.onInit(() => {
      throw new Error('bad');
    });
    const good = vi.fn();
    p.onInit(good);
    expect(() => p.getImmediate()).not.toThrow();
    expect(good).toHaveBeenCalledWith({ v: 1 });
  });

  it('snapshots callbacks so unsubscribing one during emit does not skip others', () => {
    const c = createServiceContainer();
    c.addService(defineService(S, () => 1));
    const p = c.getProvider(S);
    const b = vi.fn();
    let offB = (): void => undefined;
    p.onInit(() => {
      offB(); // unsubscribe b mid-emit
    });
    offB = p.onInit(b); // registered after the unsubscriber
    p.getImmediate();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
