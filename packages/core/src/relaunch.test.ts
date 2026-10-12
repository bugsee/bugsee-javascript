import { describe, expect, it, vi } from 'vitest';
import {
  getCarrier,
  setCarrierClient,
  setCarrierLastLaunch,
  setCarrierPendingLaunch,
} from './carrier';
import { RELAUNCH_KEPT_OPTIONS, relaunchWith } from './relaunch';

describe('relaunchWith', () => {
  it('rejects when nothing was ever launched', async () => {
    const launch = vi.fn();
    await expect(relaunchWith(launch, undefined, {})).rejects.toThrow(/before launch/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('stops the running client FIRST, then launches with the same token and the retained seams', async () => {
    const g = {};
    const order: string[] = [];
    const previous = { stop: vi.fn(async () => void order.push('stop')) };
    setCarrierClient(previous, g);
    setCarrierLastLaunch('tok', { captureLogs: false, clock: 'c' }, g);
    const next = { stop: vi.fn() };
    const launch = vi.fn(async () => {
      order.push('launch');
      return next;
    });
    const result = await relaunchWith(launch, undefined, g);
    expect(result).toBe(next);
    expect(order).toEqual(['stop', 'launch']);
    expect(launch).toHaveBeenCalledWith('tok', { clock: 'c' }); // only the seams are retained
  });

  it('uses NEW options when given, and works with no client running', async () => {
    const g = {};
    setCarrierLastLaunch('tok', { clock: 'old' }, g);
    const next = { stop: vi.fn() };
    const launch = vi.fn(() => next);
    expect(await relaunchWith(launch, { captureLogs: false }, g)).toBe(next);
    // explicit options replace the Bugsee options; the kept seam (clock) is still carried
    expect(launch).toHaveBeenCalledWith('tok', { clock: 'old', captureLogs: false });
    expect(getCarrier(g).lastLaunch?.options).toEqual({ clock: 'old' }); // recording is the launcher's job
  });

  it('defaults to the real globalThis carrier', async () => {
    setCarrierLastLaunch('g-tok', { clock: 1 });
    const launch = vi.fn(() => ({ stop: vi.fn() }));
    await relaunchWith(launch, undefined);
    expect(launch).toHaveBeenCalledWith('g-tok', { clock: 1 });
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  });
});

describe('relaunchWith — options reset to defaults, integration seams kept (L10)', () => {
  const seams = {
    transport: () => 'transport',
    carrier: {},
    clock: { wallNow: () => 1 },
    scheduler: { setInterval: () => 1 },
    captureStore: { name: 'store' },
    bundleStore: { name: 'bundles' },
    onError: () => {},
    process: { pid: 1 },
    window: { w: 1 },
    document: { d: 1 },
  };

  it('without options: Bugsee options are dropped, seams carried over', async () => {
    const g = {};
    setCarrierLastLaunch(
      'tok',
      {
        ...seams,
        captureLogs: false,
        captureLogsLevel: 'error',
        maxRecordingTime: 5,
        detectCrashes: false,
        replay: true,
      },
      g,
    );
    const launch = vi.fn(() => ({ stop: vi.fn() }));
    await relaunchWith(launch, undefined, g);
    expect(launch).toHaveBeenCalledWith('tok', seams);
  });

  it('with options: they replace the Bugsee options; seams still come from the previous launch', async () => {
    const g = {};
    setCarrierLastLaunch('tok', { ...seams, captureLogs: false }, g);
    const launch = vi.fn(() => ({ stop: vi.fn() }));
    await relaunchWith(launch, { captureNetwork: false, onError: seams.onError }, g);
    expect(launch).toHaveBeenCalledWith('tok', { ...seams, captureNetwork: false });
  });

  it('an explicit seam wins over the remembered one', async () => {
    const g = {};
    setCarrierLastLaunch('tok', { ...seams }, g);
    const launch = vi.fn(() => ({ stop: vi.fn() }));
    const clock = { wallNow: () => 2 };
    await relaunchWith(launch, { clock }, g);
    expect(launch).toHaveBeenCalledWith('tok', { ...seams, clock });
  });

  it('tolerates a non-object remembered options value', async () => {
    const g = {};
    setCarrierLastLaunch('tok', undefined, g);
    const launch = vi.fn(() => ({ stop: vi.fn() }));
    await relaunchWith(launch, undefined, g);
    expect(launch).toHaveBeenCalledWith('tok', {});
  });

  it('keeps the injected stores and test seams, never a host Bugsee option', () => {
    expect(RELAUNCH_KEPT_OPTIONS).toEqual(
      expect.arrayContaining([
        'transport',
        'carrier',
        'clock',
        'scheduler',
        'captureStore',
        'bundleStore',
        'onError',
      ]),
    );
    for (const option of ['captureLogs', 'captureNetwork', 'replay', 'maxRecordingTime']) {
      expect(RELAUNCH_KEPT_OPTIONS).not.toContain(option);
    }
  });
});

describe('relaunchWith — bounded stop (L13)', () => {
  it('passes a timeout to stop() and does not hang when the old client never settles', async () => {
    const g = {};
    const stop = vi.fn(() => new Promise<boolean>(() => {}));
    setCarrierClient({ stop }, g);
    setCarrierLastLaunch('tok', {}, g);
    const next = { stop: vi.fn() };
    const launch = vi.fn(() => next);
    const result = await relaunchWith(launch, undefined, g, { stopTimeoutMs: 20 });
    expect(stop).toHaveBeenCalledWith(20);
    expect(result).toBe(next);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('has a finite default timeout', async () => {
    const g = {};
    const stop = vi.fn(async () => true);
    setCarrierClient({ stop }, g);
    setCarrierLastLaunch('tok', {}, g);
    await relaunchWith(() => ({ stop: vi.fn() }), undefined, g);
    const [timeout] = stop.mock.calls[0] as unknown as [number];
    expect(timeout).toBeGreaterThan(0);
    expect(Number.isFinite(timeout)).toBe(true);
  });
});

describe('relaunchWith — a launch that is still in flight (L13)', () => {
  it('waits for it, then stops THAT client and launches with the NEW options (never returns the stale one)', async () => {
    const g = {};
    const order: string[] = [];
    const inFlight = { stop: vi.fn(async () => void order.push('stop-in-flight')) };
    let finish: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = () => {
        setCarrierClient(inFlight, g);
        setCarrierLastLaunch('tok', { captureLogs: false }, g);
        resolve();
      };
    });
    setCarrierPendingLaunch(pending, g);
    const fresh = { stop: vi.fn() };
    const launch = vi.fn(() => {
      order.push('launch');
      return fresh;
    });
    const relaunching = relaunchWith(launch, { captureNetwork: false }, g);
    await Promise.resolve();
    expect(launch).not.toHaveBeenCalled();
    finish();
    await expect(relaunching).resolves.toBe(fresh);
    expect(order).toEqual(['stop-in-flight', 'launch']);
    expect(launch).toHaveBeenCalledWith('tok', { captureNetwork: false });
  });

  it('a failed in-flight launch does not block the relaunch', async () => {
    const g = {};
    setCarrierLastLaunch('tok', {}, g);
    setCarrierPendingLaunch(Promise.reject(new Error('launch failed')), g);
    const launch = vi.fn(() => ({ stop: vi.fn() }));
    await relaunchWith(launch, undefined, g);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('waits for a slow in-flight launch WITHOUT the stop bound (R2L-8): no "before launch", no second build', async () => {
    const g = {};
    const order: string[] = [];
    const slow = { stop: vi.fn(async () => void order.push('stop-slow')) };
    setCarrierPendingLaunch(
      new Promise<void>((resolve) => {
        (globalThis as unknown as { setTimeout(cb: () => void, ms: number): void }).setTimeout(
          () => {
            setCarrierClient(slow, g);
            setCarrierLastLaunch('tok', {}, g);
            resolve();
          },
          60,
        );
      }),
      g,
    );
    const fresh = { stop: vi.fn() };
    const launch = vi.fn(() => {
      order.push('launch');
      return fresh;
    });
    // the bound (10 ms) is far shorter than the launch (60 ms)
    await expect(relaunchWith(launch, undefined, g, { stopTimeoutMs: 10 })).resolves.toBe(fresh);
    expect(order).toEqual(['stop-slow', 'launch']);
  });

  it('rejects "before launch" only if no launch exists even after waiting', async () => {
    const g = {};
    setCarrierPendingLaunch(Promise.resolve(), g);
    await expect(relaunchWith(vi.fn(), undefined, g)).rejects.toThrow(/before launch/);
  });
});

describe('relaunchWith — kept deployment identity and the remembered carrier host (R2P-3, R2L-12)', () => {
  it('keeps the endpoint, app identity, persistence and runtime scope handles across a relaunch', async () => {
    const g = {};
    const kept = {
      endpoint: 'https://eu.example/',
      appId: 'app',
      appVersion: '1.2.3',
      appBuild: '45',
      platformType: 'electron',
      persist: false,
      recover: false,
      asyncLocalStorage: { name: 'als' },
      partitionCaptureByTenant: true,
      globalScope: { name: 'scope' },
      globalTarget: { name: 'target' },
      logger: { name: 'logger' },
    };
    setCarrierLastLaunch('tok', { ...kept, captureLogs: false }, g);
    const launch = vi.fn(() => ({ stop: vi.fn() }));
    await relaunchWith(launch, undefined, g);
    expect(launch).toHaveBeenCalledWith('tok', kept);
  });

  it('a plain relaunch() after launch(t, { carrier: X }) finds X without being told', async () => {
    const x = {};
    setCarrierLastLaunch('tok', { carrier: x, clock: 'c' }, x);
    const previous = { stop: vi.fn(async () => {}) };
    setCarrierClient(previous, x);
    const launch = vi.fn(() => ({ stop: vi.fn() }));
    await relaunchWith(launch, undefined);
    expect(previous.stop).toHaveBeenCalled();
    expect(launch).toHaveBeenCalledWith('tok', { carrier: x, clock: 'c' });
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  });

  it('a later launch on the DEFAULT carrier stops pointing at the old custom one', async () => {
    const x = {};
    setCarrierLastLaunch('x-tok', { carrier: x }, x);
    setCarrierLastLaunch('g-tok', {});
    const launch = vi.fn(() => ({ stop: vi.fn() }));
    await relaunchWith(launch, undefined);
    expect(launch).toHaveBeenCalledWith('g-tok', {});
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  });

  it('an explicit carrier argument wins over the remembered host', async () => {
    const x = {};
    const y = {};
    setCarrierLastLaunch('x-tok', { carrier: x }, x);
    setCarrierLastLaunch('y-tok', { carrier: y }, y);
    const launch = vi.fn(() => ({ stop: vi.fn() }));
    await relaunchWith(launch, undefined, x);
    expect(launch).toHaveBeenCalledWith('x-tok', { carrier: x });
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  });
});

describe('relaunchWith — a stop() that rejects', () => {
  it('does not stop the relaunch', async () => {
    const g = {};
    setCarrierClient({ stop: vi.fn(async () => Promise.reject(new Error('stop failed'))) }, g);
    setCarrierLastLaunch('tok', {}, g);
    const launch = vi.fn(() => ({ stop: vi.fn() }));
    await relaunchWith(launch, undefined, g);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
