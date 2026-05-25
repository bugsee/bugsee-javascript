import { describe, expect, it, vi } from 'vitest';
import { createServiceContainer, defineService } from './index';

describe('defineService', () => {
  it('defaults to LAZY mode', () => {
    expect(defineService('x', () => 1).mode).toBe('LAZY');
  });

  it('honors an explicit mode', () => {
    expect(defineService('x', () => 1, 'EXPLICIT').mode).toBe('EXPLICIT');
  });
});

describe('ServiceContainer / Provider (LAZY)', () => {
  it('getProvider exposes the requested name', () => {
    const c = createServiceContainer();
    expect(c.getProvider('clock').name).toBe('clock');
    expect(c.getProvider('storage').name).toBe('storage');
  });

  it('returns the same provider instance for a name', () => {
    const c = createServiceContainer();
    expect(c.getProvider('clock')).toBe(c.getProvider('clock'));
  });

  it('lazily instantiates on first getImmediate, exactly once (singleton)', () => {
    const c = createServiceContainer();
    const factory = vi.fn(() => ({ v: 1 }));
    c.addService(defineService('s', factory));
    const a = c.getProvider<{ v: number }>('s').getImmediate();
    const b = c.getProvider<{ v: number }>('s').getImmediate();
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('passes the container to the factory', () => {
    const c = createServiceContainer();
    let received: unknown;
    c.addService(
      defineService('s', (container) => {
        received = container;
        return 1;
      }),
    );
    c.getProvider('s').getImmediate();
    expect(received).toBe(c);
  });

  it('getImmediate throws "is not registered" before registration', () => {
    expect(() => createServiceContainer().getProvider('missing').getImmediate()).toThrow(
      /is not registered/,
    );
  });

  it('getImmediate({ optional: true }) returns null before registration', () => {
    expect(
      createServiceContainer().getProvider('missing').getImmediate({ optional: true }),
    ).toBeNull();
  });

  it('isServiceSet / isInitialized track the lifecycle', () => {
    const c = createServiceContainer();
    const p = c.getProvider('s');
    expect(p.isServiceSet()).toBe(false);
    expect(p.isInitialized()).toBe(false);
    c.addService(defineService('s', () => 1));
    expect(p.isServiceSet()).toBe(true);
    expect(p.isInitialized()).toBe(false);
    p.getImmediate();
    expect(p.isInitialized()).toBe(true);
  });

  it('registering the same name twice throws "already registered"', () => {
    const c = createServiceContainer();
    c.addService(defineService('s', () => 1));
    expect(() => c.addService(defineService('s', () => 2))).toThrow(/already registered/);
  });
});

describe('async get() + late registration', () => {
  it('resolves after late LAZY registration', async () => {
    const c = createServiceContainer();
    const promise = c.getProvider<number>('s').get(); // pending: not registered yet
    c.addService(defineService('s', () => 42));
    await expect(promise).resolves.toBe(42);
  });

  it('resolves with the cached instance when already instantiated, without re-running the factory', async () => {
    const c = createServiceContainer();
    const factory = vi.fn(() => ({ v: 1 }));
    c.addService(defineService('s', factory));
    const eager = c.getProvider<{ v: number }>('s').getImmediate();
    await expect(c.getProvider<{ v: number }>('s').get()).resolves.toBe(eager);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('get() and getImmediate() yield the same instance', async () => {
    const c = createServiceContainer();
    c.addService(defineService('s', () => ({ v: 1 })));
    const fromGet = await c.getProvider<{ v: number }>('s').get();
    expect(c.getProvider<{ v: number }>('s').getImmediate()).toBe(fromGet);
  });

  it('get() called twice while pending shares one pending promise', async () => {
    const c = createServiceContainer();
    c.addService(defineService('s', () => 9, 'EXPLICIT'));
    const p = c.getProvider<number>('s');
    const a = p.get();
    const b = p.get(); // deferred already exists -> reused, not recreated
    expect(a).toBe(b);
    p.initialize();
    await expect(a).resolves.toBe(9);
  });

  it('late EXPLICIT registration keeps a pending get() pending until initialize', async () => {
    const c = createServiceContainer();
    const p = c.getProvider<number>('s');
    const pending = p.get(); // pending, not registered
    c.addService(defineService('s', () => 5, 'EXPLICIT')); // setService must NOT instantiate (EXPLICIT)
    const sentinel = Symbol('pending');
    expect(await Promise.race([pending, Promise.resolve(sentinel)])).toBe(sentinel);
    p.initialize();
    await expect(pending).resolves.toBe(5);
  });
});

describe('EXPLICIT mode', () => {
  it('getImmediate throws "must be initialized" before initialize', () => {
    const c = createServiceContainer();
    c.addService(defineService('s', () => 1, 'EXPLICIT'));
    expect(() => c.getProvider('s').getImmediate()).toThrow(/must be initialized/);
  });

  it('getImmediate({ optional: true }) returns null before initialize', () => {
    const c = createServiceContainer();
    c.addService(defineService('s', () => 1, 'EXPLICIT'));
    expect(c.getProvider('s').getImmediate({ optional: true })).toBeNull();
  });

  it('initialize instantiates with options; getImmediate then returns it', () => {
    const c = createServiceContainer();
    c.addService(defineService('s', (_c, opts) => ({ opts }), 'EXPLICIT'));
    const inst = c.getProvider<{ opts: unknown }>('s').initialize({ a: 1 });
    expect(inst).toEqual({ opts: { a: 1 } });
    expect(c.getProvider('s').getImmediate()).toBe(inst);
  });

  it('get() stays pending until initialize', async () => {
    const c = createServiceContainer();
    c.addService(defineService('s', () => 5, 'EXPLICIT'));
    const promise = c.getProvider<number>('s').get();
    c.getProvider('s').initialize();
    await expect(promise).resolves.toBe(5);
  });
});

describe('initialize errors', () => {
  it('throws "is not registered" when not registered', () => {
    expect(() => createServiceContainer().getProvider('s').initialize()).toThrow(
      /is not registered/,
    );
  });

  it('throws "already initialized" when already initialized', () => {
    const c = createServiceContainer();
    c.addService(defineService('s', () => 1, 'EXPLICIT'));
    c.getProvider('s').initialize();
    expect(() => c.getProvider('s').initialize()).toThrow(/already initialized/);
  });

  it('re-throws a cached failure instead of retrying the factory', () => {
    const c = createServiceContainer();
    const boom = new Error('boom');
    const factory = vi.fn(() => {
      throw boom;
    });
    c.addService(defineService('s', factory, 'EXPLICIT'));
    const p = c.getProvider('s');
    expect(() => p.initialize()).toThrow(boom); // first: factory fails, caches
    expect(() => p.initialize()).toThrow(boom); // second: cached failure re-thrown, no retry
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('clearInstance', () => {
  it('drops the instance and re-instantiates on next access', () => {
    const c = createServiceContainer();
    const factory = vi.fn(() => ({ v: 1 }));
    c.addService(defineService('s', factory));
    const p = c.getProvider('s');
    p.getImmediate();
    p.clearInstance();
    expect(p.isInitialized()).toBe(false);
    p.getImmediate();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('rejects a pending get() with "cleared before it initialized"', async () => {
    const c = createServiceContainer();
    const pending = c.getProvider<number>('s').get();
    c.getProvider('s').clearInstance();
    await expect(pending).rejects.toThrow(/cleared before it initialized/);
  });

  it('lets a fresh get() resolve after a pending one was rejected (deferred reset)', async () => {
    const c = createServiceContainer();
    const p = c.getProvider<number>('s');
    const first = p.get();
    p.clearInstance();
    await expect(first).rejects.toThrow();
    const second = p.get();
    c.addService(defineService('s', () => 7));
    await expect(second).resolves.toBe(7);
  });

  it('recovers after a factory failure once cleared (failure reset)', () => {
    const c = createServiceContainer();
    let shouldThrow = true;
    c.addService(
      defineService('s', () => {
        if (shouldThrow) {
          throw new Error('boom');
        }
        return 42;
      }),
    );
    const p = c.getProvider<number>('s');
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
      defineService('s', () => {
        throw boom;
      }),
    );
    expect(() => c.getProvider('s').getImmediate()).toThrow(boom);
  });

  it('get() rejects with the factory error on late registration', async () => {
    const c = createServiceContainer();
    const boom = new Error('boom');
    const promise = c.getProvider('s').get();
    c.addService(
      defineService('s', () => {
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
    c.addService(defineService('s', factory));
    const p = c.getProvider('s');
    expect(() => p.getImmediate()).toThrow(boom);
    expect(() => p.getImmediate()).toThrow(boom); // re-throws cached failure, no re-run
    await expect(p.get()).rejects.toBe(boom);
    expect(p.getImmediate({ optional: true })).toBeNull();
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('re-entrancy', () => {
  it('detects a self-referential factory instead of double-instantiating', () => {
    const c = createServiceContainer();
    c.addService(
      defineService('s', (container) => {
        container.getProvider('s').getImmediate(); // self-cycle during construction
        return 1;
      }),
    );
    expect(() => c.getProvider('s').getImmediate()).toThrow(/circular/);
  });
});

describe('onInit', () => {
  it('fires when the instance is created', () => {
    const c = createServiceContainer();
    c.addService(defineService('s', () => ({ v: 1 })));
    const cb = vi.fn();
    const p = c.getProvider<{ v: number }>('s');
    p.onInit(cb);
    p.getImmediate();
    expect(cb).toHaveBeenCalledWith({ v: 1 });
  });

  it('fires immediately if the instance already exists', () => {
    const c = createServiceContainer();
    c.addService(defineService('s', () => 1));
    const p = c.getProvider('s');
    p.getImmediate();
    const cb = vi.fn();
    p.onInit(cb);
    expect(cb).toHaveBeenCalledWith(1);
  });

  it('unsubscribe stops future calls', () => {
    const c = createServiceContainer();
    c.addService(defineService('s', () => 1));
    const p = c.getProvider('s');
    const cb = vi.fn();
    p.onInit(cb)();
    p.getImmediate();
    expect(cb).not.toHaveBeenCalled();
  });

  it('a throwing onInit callback does not break instantiation or other callbacks', () => {
    const c = createServiceContainer();
    c.addService(defineService('s', () => ({ v: 1 })));
    const p = c.getProvider<{ v: number }>('s');
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
    c.addService(defineService('s', () => 1));
    const p = c.getProvider<number>('s');
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
