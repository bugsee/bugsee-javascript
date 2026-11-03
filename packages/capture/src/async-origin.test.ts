import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AsyncOriginRecorder, installAsyncOrigins } from './async-origin';
import type { AsyncOriginRow } from './async-origin-table';

// A stackless platform rejection reason (what a DOMException from an async media task looks like: an object, no `.stack`).
const stackless = (name = 'NotSupportedError'): { name: string; message: string } => ({
  name,
  message: 'no sources',
});

type Fake = Record<string, unknown>;
const callSite = (fn: () => unknown): unknown => fn(); // a named frame the captured stack must contain

const row = (over: Partial<AsyncOriginRow> = {}): AsyncOriginRow => ({
  iface: 'Media',
  methods: ['play'],
  mode: 'always',
  why: 'test',
  ...over,
});

function fakeGlobal(play: (this: unknown, ...args: unknown[]) => unknown): Fake {
  class Media {
    play(...args: unknown[]): unknown {
      return play.apply(this, args);
    }
  }
  return { Media, Promise, Error };
}

const media = (g: Fake): { prototype: { play(...args: unknown[]): unknown } } =>
  g.Media as { prototype: { play(...args: unknown[]): unknown } };

let recorder: AsyncOriginRecorder | undefined;
afterEach(() => {
  recorder?.stop();
  recorder = undefined;
});

const install = (
  g: Fake,
  options: Parameters<typeof installAsyncOrigins>[0] = {},
): AsyncOriginRecorder => {
  recorder = installAsyncOrigins({ global: g, rows: [row()], ...options });
  return recorder;
};

describe('installAsyncOrigins — what is wrapped', () => {
  it('wraps an always-on row, leaves an armed row alone until arm(), and never wraps an off row', () => {
    const g = {
      A: class {
        a() {
          return 1;
        }
      },
      B: class {
        b() {
          return 1;
        }
      },
      C: class {
        c() {
          return 1;
        }
      },
    };
    const originals = { a: g.A.prototype.a, b: g.B.prototype.b, c: g.C.prototype.c };
    const r = install(g, {
      rows: [
        row({ iface: 'A', methods: ['a'], mode: 'always' }),
        row({ iface: 'B', methods: ['b'], mode: 'armed' }),
        row({ iface: 'C', methods: ['c'], mode: 'off' }),
      ],
    });
    expect(g.A.prototype.a).not.toBe(originals.a);
    expect(g.B.prototype.b).toBe(originals.b);
    expect(r.installed).toEqual(['A.a']);
    r.arm();
    expect(g.B.prototype.b).not.toBe(originals.b);
    expect(g.C.prototype.c).toBe(originals.c);
    expect(r.installed).toEqual(['A.a', 'B.b']);
    r.arm(); // idempotent
    expect(r.installed).toEqual(['A.a', 'B.b']);
  });

  it('only installs the modes asked for', () => {
    const g = {
      A: class {
        a() {
          return 1;
        }
      },
      B: class {
        b() {
          return 1;
        }
      },
    };
    const r = install(g, {
      modes: ['off'],
      rows: [
        row({ iface: 'A', methods: ['a'], mode: 'always' }),
        row({ iface: 'B', methods: ['b'], mode: 'off' }),
      ],
    });
    expect(r.installed).toEqual(['B.b']);
    r.arm();
    expect(r.installed).toEqual(['B.b']);
  });

  it('wraps every target of a mixin row and the global object itself', () => {
    const fetchLike = vi.fn(() => 1);
    const g = {
      fetch: fetchLike,
      Request: class {
        json() {
          return 1;
        }
      },
      Response: class {
        json() {
          return 1;
        }
      },
    };
    const r = install(g, {
      rows: [
        row({ iface: 'Body', methods: ['json'], targets: ['Request', 'Response'] }),
        row({ iface: 'WindowOrWorkerGlobalScope', methods: ['fetch'], targets: ['globalThis'] }),
      ],
    });
    expect(r.installed).toEqual(['Request.json', 'Response.json', 'globalThis.fetch']);
    expect(g.fetch).not.toBe(fetchLike);
  });

  it('skips what the realm does not have (workers lack HTMLMediaElement) without throwing', () => {
    const r = install(
      {},
      { rows: [row({ iface: 'HTMLMediaElement' }), row({ iface: 'Object', methods: ['nope'] })] },
    );
    expect(r.installed).toEqual([]);
    const g = { Media: class {} };
    expect(install(g).installed).toEqual([]); // ctor present, method absent
  });

  it('skips an inherited, non-function, frozen or non-configurable method rather than throwing', () => {
    class Base {
      play() {
        return 1;
      }
    }
    class Sub extends Base {}
    const frozen = class {
      play() {
        return 1;
      }
    };
    Object.freeze(frozen.prototype);
    const accessor = class {};
    Object.defineProperty(accessor.prototype, 'play', { get: () => () => 1, configurable: true });
    const value = class {};
    Object.defineProperty(value.prototype, 'play', {
      value: 5,
      configurable: true,
      writable: true,
    });
    const locked = class {};
    Object.defineProperty(locked.prototype, 'play', {
      value: () => 1,
      configurable: false,
      writable: false,
    });
    const r = install(
      { Sub, frozen, accessor, value, locked },
      { rows: ['Sub', 'frozen', 'accessor', 'value', 'locked'].map((iface) => row({ iface })) },
    );
    expect(r.installed).toEqual([]);
  });

  it('is idempotent: a second install over the same global wraps nothing and does not double-wrap', () => {
    const g = fakeGlobal(() => Promise.resolve(1));
    const first = install(g);
    const wrapped = media(g).prototype.play;
    const second = installAsyncOrigins({ global: g, rows: [row()] });
    expect(second.installed).toEqual([]);
    expect(media(g).prototype.play).toBe(wrapped);
    second.stop(); // must not unwrap the first instance's patch
    expect(media(g).prototype.play).toBe(wrapped);
    first.stop();
  });
});

describe('installAsyncOrigins — the wrapper keeps the call faithful', () => {
  it('forwards this and arguments and returns the platform result on success', async () => {
    const seen: unknown[] = [];
    const g = fakeGlobal(function (this: unknown, ...args: unknown[]) {
      seen.push(this, ...args);
      return Promise.resolve('ok');
    });
    install(g);
    const el = new (g.Media as new () => { play(...a: unknown[]): Promise<string> })();
    await expect(el.play(1, 'two')).resolves.toBe('ok');
    expect(seen[0]).toBe(el);
    expect(seen.slice(1)).toEqual([1, 'two']);
  });

  it('keeps name and length, and toString answers as the original', () => {
    const g = fakeGlobal(() => 1);
    class Plain {
      play(_a: unknown, _b: unknown) {
        return Promise.resolve();
      }
    }
    (g as Fake).Plain = Plain;
    const original = Plain.prototype.play;
    install(g, { rows: [row({ iface: 'Plain' })] });
    expect(Plain.prototype.play).not.toBe(original);
    expect(Plain.prototype.play.name).toBe('play');
    expect(Plain.prototype.play.length).toBe(2);
    expect(Plain.prototype.play.toString()).toBe(Function.prototype.toString.call(original));
  });

  it('returns a non-thenable result untouched and lets a synchronous throw through unchanged', () => {
    const boom = new TypeError('sync');
    let mode: 'value' | 'throw' = 'value';
    const g = fakeGlobal(() => {
      if (mode === 'throw') throw boom;
      return 42;
    });
    install(g);
    const el = new (g.Media as new () => { play(): unknown })();
    expect(el.play()).toBe(42);
    mode = 'throw';
    expect(() => el.play()).toThrow(boom);
  });
});

describe('installAsyncOrigins — recording the origin', () => {
  it('returns a derived promise with the SAME reason object and records where it was called', async () => {
    const reason = stackless();
    const original = Promise.reject(reason);
    original.catch(() => undefined);
    const g = fakeGlobal(() => original);
    const r = install(g);
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    const derived = callSite(() => el.play()) as Promise<unknown>;
    expect(derived).not.toBe(original);
    await expect(derived).rejects.toBe(reason);
    const origin = r.originOf(reason);
    expect(origin?.api).toBe('Media.play');
    expect(origin?.target).toBe(el);
    expect(origin?.holder.stack).toContain('callSite');
    expect(r.originOfPromise(derived)).toBeUndefined(); // derived mode keys by reason, not by promise
  });

  it('does not retain a rejection that already carries a stack, nor overwrite the first origin', async () => {
    const withStack = new Error('has a stack');
    const bare = stackless();
    let next: unknown = withStack;
    const g = fakeGlobal(() => Promise.reject(next));
    const r = install(g);
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    await expect(el.play()).rejects.toBe(withStack);
    expect(r.originOf(withStack)).toBeUndefined();
    next = bare;
    await expect(el.play()).rejects.toBe(bare);
    const first = r.originOf(bare);
    await expect(el.play()).rejects.toBe(bare); // same reason object again
    expect(r.originOf(bare)).toBe(first);
  });

  it('passes a primitive rejection through unchanged and records nothing for it', async () => {
    const g = fakeGlobal(() => Promise.reject('plain string'));
    const r = install(g);
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    await expect(el.play()).rejects.toBe('plain string');
    expect(r.originOf('plain string')).toBeUndefined();
  });

  it('records for a function-valued reason too', async () => {
    const reason = Object.assign(() => 1, { name2: 'fn' });
    const g = fakeGlobal(() => Promise.reject(reason));
    const r = install(g);
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    await expect(el.play()).rejects.toBe(reason);
    expect(r.originOf(reason)).toBeDefined();
  });

  it('finds the origin through reason.cause (axios/ky/ofetch wrap the platform failure), a few levels deep', async () => {
    const inner = stackless();
    const g = fakeGlobal(() => Promise.reject(inner));
    const r = install(g);
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    await el.play().catch(() => undefined);
    const wrapped = { cause: { cause: inner } };
    expect(r.originOf(wrapped)?.api).toBe('Media.play');
    const tooDeep = { cause: { cause: { cause: { cause: inner } } } };
    expect(r.originOf(tooDeep)).toBeUndefined();
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(r.originOf(loop)).toBeUndefined();
    expect(r.originOf(null)).toBeUndefined();
    expect(r.originOf('str')).toBeUndefined();
  });

  it('records the target for the report to describe later', async () => {
    const g = fakeGlobal(() => Promise.reject(stackless()));
    const r = install(g);
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    const p = el.play();
    const reason = await p.catch((e: unknown) => e);
    expect(r.originOf(reason)?.target).toBe(el);
  });
});

describe('installAsyncOrigins — a pristine then, never the global one', () => {
  const nativeThen = Promise.prototype.then;

  it("uses zone.js's stored native then (p.__zone_symbol__then) and never the promise's own patched then", async () => {
    const patchedThen = vi.fn(() => {
      throw new Error('the patched then must not be called');
    });
    const reason = stackless();
    const real = Promise.reject(reason);
    real.catch(() => undefined);
    // The promise-like's own (patched) `then` must never run; the native one is reached through the stored symbol, bound to `real`.
    const promiseLike: Record<string, unknown> = {
      __zone_symbol__then: (...a: unknown[]) => nativeThen.apply(real, a as never),
    };
    Object.defineProperty(promiseLike, 'then', { value: patchedThen, enumerable: true });
    const g = fakeGlobal(() => promiseLike);
    const r = install(g, { cleanThen: null });
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    await expect(el.play()).rejects.toBe(reason);
    expect(patchedThen).not.toHaveBeenCalled();
    expect(r.originOf(reason)).toBeDefined();
  });

  it('falls back to the then captured at install when the promise carries no stored one', async () => {
    const reason = stackless();
    const real = Promise.reject(reason);
    real.catch(() => undefined);
    const g = fakeGlobal(() => real);
    const r = install(g); // auto: the global Promise is native here
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    await expect(el.play()).rejects.toBe(reason);
    expect(r.originOf(reason)).toBeDefined();
  });

  it('with NO pristine then it attaches no reaction, returns the same promise and keys the origin by promise', () => {
    const real = Promise.reject(stackless());
    real.catch(() => undefined);
    const g = fakeGlobal(() => real);
    const r = install(g, { cleanThen: null });
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    const returned = callSite(() => el.play());
    expect(returned).toBe(real);
    expect(r.originOfPromise(real)?.api).toBe('Media.play');
    expect(r.originOfPromise({})).toBeUndefined();
    expect(r.originOfPromise(null)).toBeUndefined();
  });

  it('a then that throws degrades to the untouched promise, never to a broken call', () => {
    const real = Promise.resolve(1);
    const exploding = () => {
      throw new TypeError('Incompatible receiver');
    };
    const g = fakeGlobal(() => real);
    const r = install(g, { cleanThen: exploding as never });
    const el = new (g.Media as new () => { play(): unknown })();
    expect(el.play()).toBe(real);
    expect(r.originOfPromise(real)).toBeDefined();
  });

  it('a then that returns a non-thenable degrades to the untouched promise', () => {
    const real = Promise.resolve(1);
    const g = fakeGlobal(() => real);
    install(g, { cleanThen: (() => 5) as never });
    const el = new (g.Media as new () => { play(): unknown })();
    expect(el.play()).toBe(real);
  });

  it('captures the clean then from a hidden iframe realm when the global Promise is not native', async () => {
    const reason = stackless();
    const real = Promise.reject(reason);
    real.catch(() => undefined);
    const removed = vi.fn();
    const frame = {
      style: {} as Record<string, string>,
      setAttribute: vi.fn(),
      remove: removed,
      contentWindow: { Promise },
    };
    const appended: unknown[] = [];
    const doc = {
      createElement: () => frame,
      documentElement: { appendChild: (n: unknown) => appended.push(n) },
    };
    const g: Fake = { ...fakeGlobal(() => real), Promise: class FakeZonePromise {}, document: doc };
    const r = install(g, { intrinsicPromisePrototype: () => undefined }); // as if the native prototype's then had been patched in place
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    await expect(el.play()).rejects.toBe(reason);
    expect(r.originOf(reason)).toBeDefined();
    expect(appended).toEqual([frame]);
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('gives up cleanly (no pristine then, promise returned untouched) when the iframe route is missing, throws, is not native or has no window', () => {
    const notNative = { Promise: class NotNative {} };
    const frame = (contentWindow?: object) => ({
      style: {},
      setAttribute: () => undefined,
      remove: () => undefined,
      contentWindow,
    });
    const docs: (object | undefined)[] = [
      undefined,
      {
        createElement: () => frame({ Promise: class X {} }),
        documentElement: { appendChild: () => undefined },
      },
      { createElement: () => frame(), documentElement: { appendChild: () => undefined } },
      { createElement: () => frame(), documentElement: undefined },
      {
        createElement: () => {
          throw new Error('csp');
        },
        documentElement: { appendChild: () => undefined },
      },
    ];
    for (const document of docs) {
      const real = Promise.resolve(1);
      const g: Fake = { ...fakeGlobal(() => real), ...notNative, document };
      const r = install(g, { intrinsicPromisePrototype: () => undefined });
      const el = new (g.Media as new () => { play(): unknown })();
      expect(el.play()).toBe(real);
      expect(r.originOfPromise(real)).toBeDefined(); // fallback mode: keyed by promise
      r.stop();
    }
  });
});

describe('installAsyncOrigins — cost bounds', () => {
  it('stops capturing a method after its budget and resumes when the shared timer resets it', async () => {
    let reset: (() => void) | undefined;
    const setIntervalStub = vi.fn((fn: () => void, _ms: number) => {
      reset = fn;
      return 7;
    });
    const clearIntervalStub = vi.fn();
    const g = fakeGlobal(() => Promise.reject(stackless()));
    const r = install(g, {
      maxCapturesPerMinute: 2,
      setInterval: setIntervalStub as never,
      clearInterval: clearIntervalStub as never,
    });
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    const reasons: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      reasons.push(await el.play().catch((e: unknown) => e));
    }
    expect(r.originOf(reasons[0])).toBeDefined();
    expect(r.originOf(reasons[1])).toBeDefined();
    expect(r.originOf(reasons[2])).toBeUndefined(); // over budget: untouched pass-through
    expect(setIntervalStub).toHaveBeenCalledTimes(1);
    expect(setIntervalStub.mock.calls[0]?.[1]).toBe(60_000);
    reset?.();
    const later = await el.play().catch((e: unknown) => e);
    expect(r.originOf(later)).toBeDefined();
    r.stop();
    expect(clearIntervalStub).toHaveBeenCalledWith(7);
  });

  it('unrefs the reset timer so it never keeps a process alive, and tolerates a timer without unref', () => {
    const unref = vi.fn();
    install(
      fakeGlobal(() => 1),
      { setInterval: (() => ({ unref })) as never, clearInterval: (() => undefined) as never },
    );
    expect(unref).toHaveBeenCalledTimes(1);
    recorder?.stop();
    install(
      fakeGlobal(() => 1),
      { setInterval: (() => 5) as never, clearInterval: (() => undefined) as never },
    );
  });

  it('does not start a timer when nothing was installed', () => {
    const setIntervalStub = vi.fn();
    install({}, { setInterval: setIntervalStub as never });
    expect(setIntervalStub).not.toHaveBeenCalled();
  });

  it('works without any timer API (a restricted realm): the budget then never resets', async () => {
    const g = fakeGlobal(() => Promise.reject(stackless()));
    const r = install(g, {
      maxCapturesPerMinute: 1,
      setInterval: undefined,
      clearInterval: undefined,
    });
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    const first = await el.play().catch((e: unknown) => e);
    expect(r.originOf(first)).toBeDefined();
  });

  it('uses the engine stack-capture where it exists (no frame to skip) and new Error() elsewhere (skip the wrapper frame)', async () => {
    const g1 = fakeGlobal(() => Promise.reject(stackless()));
    const r1 = install(g1);
    const el1 = new (g1.Media as new () => { play(): Promise<unknown> })();
    const reason1 = await el1.play().catch((e: unknown) => e);
    expect(r1.originOf(reason1)?.skip).toBe(
      typeof (Error as { captureStackTrace?: unknown }).captureStackTrace === 'function' ? 0 : 2,
    );
    r1.stop();
    const g2 = fakeGlobal(() => Promise.reject(stackless()));
    const r2 = install(g2, { captureStackTrace: null });
    const el2 = new (g2.Media as new () => { play(): Promise<unknown> })();
    const reason2 = await el2.play().catch((e: unknown) => e);
    // Both the recorder's own frames (observe, wrapped) sit above the caller in a plain `new Error().stack`.
    expect(r2.originOf(reason2)?.skip).toBe(2);
    expect(typeof r2.originOf(reason2)?.holder.stack).toBe('string');
  });

  it('without captureStackTrace, the first frame after the skip is the CALLER, not the recorder', async () => {
    const g = fakeGlobal(() => Promise.reject(stackless()));
    const r = install(g, { captureStackTrace: null });
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    const callerOfPlay = (): Promise<unknown> => el.play();
    const reason = await callerOfPlay().catch((e: unknown) => e);
    const origin = r.originOf(reason);
    const lines = (origin?.holder.stack ?? '').split('\n').filter((line) => /^\s+at\s/.test(line));
    expect(lines[origin?.skip ?? 0]).toContain('callerOfPlay');
  });

  it('a failure while capturing degrades to the untouched result', () => {
    const real = Promise.resolve(1);
    const g = fakeGlobal(() => real);
    install(g, {
      captureStackTrace: () => {
        throw new Error('capture failed');
      },
    });
    const el = new (g.Media as new () => { play(): unknown })();
    expect(el.play()).toBe(real);
  });
});

describe('installAsyncOrigins — stop', () => {
  it('restores the original method, and a wrapper someone kept calling passes straight through', async () => {
    const g = fakeGlobal(() => Promise.reject(stackless()));
    const original = media(g).prototype.play;
    const r = install(g);
    const wrapped = media(g).prototype.play;
    r.stop();
    expect(media(g).prototype.play).toBe(original);
    const reason = await (
      wrapped.call(new (g.Media as new () => object)()) as Promise<unknown>
    ).catch((e: unknown) => e);
    expect(r.originOf(reason)).toBeUndefined();
    r.stop(); // idempotent
  });

  it('leaves a method alone that another patcher wrapped on top of ours', () => {
    const g = fakeGlobal(() => Promise.resolve(1));
    const r = install(g);
    const ours = media(g).prototype.play;
    const theirs = function theirs(this: unknown, ...a: unknown[]) {
      return ours.apply(this, a);
    };
    media(g).prototype.play = theirs;
    r.stop();
    expect(media(g).prototype.play).toBe(theirs);
  });

  it('composes on top of an earlier third-party patch rather than replacing it', async () => {
    const reason = stackless();
    const g = fakeGlobal(() => Promise.reject(reason));
    const inner = media(g).prototype.play;
    const calls: string[] = [];
    media(g).prototype.play = function thirdParty(this: unknown, ...a: unknown[]) {
      calls.push('third-party');
      return inner.apply(this, a);
    };
    const r = install(g);
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    await expect(el.play()).rejects.toBe(reason);
    expect(calls).toEqual(['third-party']);
    expect(r.originOf(reason)).toBeDefined();
  });
});

describe('installAsyncOrigins — defensive paths', () => {
  it('skips a method whose define was silently ignored (a proxied prototype)', () => {
    const target = { play: () => Promise.resolve(1) };
    const proto = new Proxy(target, { defineProperty: () => true });
    const r = install({ Media: { prototype: proto }, Promise }, {});
    expect(r.installed).toEqual([]);
    expect(proto.play).toBe(target.play);
  });

  it('skips a method whose define the realm refuses (a trap that rejects it)', () => {
    const target = { play: () => Promise.resolve(1) };
    const proto = new Proxy(target, { defineProperty: () => false });
    expect(install({ Media: { prototype: proto }, Promise }, {}).installed).toEqual([]);
  });

  it('swallows a hostile realm silently when no onError was given', () => {
    const g = fakeGlobal(() => 1);
    Object.defineProperty(g, 'Media', {
      get() {
        throw new Error('hostile getter');
      },
    });
    expect(() => install(g)).not.toThrow();
  });

  it('survives a realm whose document getter throws (the iframe route is simply unavailable)', () => {
    const g = { ...fakeGlobal(() => 1), Promise: class NotNative {} };
    Object.defineProperty(g, 'document', {
      get(): never {
        throw new Error('document blocked');
      },
    });
    expect(() => install(g)).not.toThrow();
  });

  it('reports a restore that the realm refuses (the prototype was frozen after install) and carries on', () => {
    const onError = vi.fn();
    const g = fakeGlobal(() => Promise.resolve(1));
    const r = install(g, { onError });
    Object.freeze(media(g).prototype);
    r.stop();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('installAsyncOrigins — defaults', () => {
  it('installs from the real table onto the real global when given neither', () => {
    const r = installAsyncOrigins({ modes: ['always'] });
    expect(Array.isArray(r.installed)).toBe(true); // node has Blob/Request/... but none are 'always' rows; must not throw
    r.stop();
  });

  it('reports an internal failure through onError and carries on', () => {
    const onError = vi.fn();
    const g = fakeGlobal(() => 1);
    Object.defineProperty(g, 'Media', {
      get() {
        throw new Error('hostile getter');
      },
    });
    const r = installAsyncOrigins({ global: g, rows: [row()], onError });
    expect(r.installed).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    r.stop();
  });
});

// The whole point of returning a DERIVED promise: the app that ignores the rejection still produces `unhandledrejection`, exactly
// once, for the promise the app holds - the recorder's own reaction must not mark it handled.
describe('installAsyncOrigins - unhandled rejections stay observable', () => {
  type Proc = {
    listeners(event: string): ((...a: unknown[]) => void)[];
    removeAllListeners(event: string): void;
    on(event: string, fn: (...a: unknown[]) => void): void;
    off(event: string, fn: (...a: unknown[]) => void): void;
  };
  const proc = (globalThis as unknown as { process: Proc }).process;

  // The test runner listens on the same event and would fail the run; detach it for the duration.
  const collectUnhandled = async (
    run: () => unknown,
  ): Promise<{ reason: unknown; promise: unknown }[]> => {
    const saved = proc.listeners('unhandledRejection');
    proc.removeAllListeners('unhandledRejection');
    const seen: { reason: unknown; promise: unknown }[] = [];
    const mine = (reason: unknown, promise: unknown): void => {
      seen.push({ reason, promise });
    };
    proc.on('unhandledRejection', mine);
    try {
      run();
      const { setTimeout: later } = globalThis as unknown as {
        setTimeout(fn: () => void, ms: number): unknown;
      };
      await new Promise<void>((resolve) => later(resolve, 20));
    } finally {
      proc.off('unhandledRejection', mine);
      for (const fn of saved) {
        proc.on('unhandledRejection', fn);
      }
    }
    return seen;
  };

  it('an ignored rejection is reported once, for the promise the caller holds, and its origin is found', async () => {
    const reason = stackless();
    const g = fakeGlobal(() => Promise.reject(reason));
    const r = install(g);
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    let held: unknown;
    const seen = await collectUnhandled(() => {
      held = el.play();
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe(reason);
    expect(seen[0]?.promise).toBe(held);
    expect(r.originOf(reason)).toBeDefined();
    r.stop();
  });

  it('a handled rejection is not reported', async () => {
    const g = fakeGlobal(() => Promise.reject(stackless()));
    const r = install(g);
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    const seen = await collectUnhandled(() => {
      el.play().catch(() => undefined);
    });
    expect(seen).toHaveLength(0);
    r.stop();
  });
});

describe('installAsyncOrigins - a reason that cannot be inspected', () => {
  it('still rejects the caller with the SAME reason when reading its stack throws', async () => {
    const hostile = new Proxy(
      { name: 'NotSupportedError' },
      {
        get(target, key): unknown {
          if (key === 'stack') {
            throw new Error('stack getter');
          }
          return (target as Record<PropertyKey, unknown>)[key];
        },
      },
    );
    const g = fakeGlobal(() => Promise.reject(hostile));
    const r = install(g);
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    const caught = await el.play().catch((e: unknown) => e);
    expect(caught).toBe(hostile);
    r.stop();
  });
});

// core-js (forced) and similar polyfills replace `Promise` AND patch `Function.prototype.toString` so their own functions read as
// `[native code]`: a toString-based "is this native" check trusts a `then` that throws on the engine's own promises.
describe('installAsyncOrigins - a replacement Promise that disguises itself as native', () => {
  it('still records the origin, using the engine intrinsic then instead of the replacement', async () => {
    const reason = stackless();
    const g = fakeGlobal(() => Promise.reject(reason));
    function FakePromise(): void {}
    // biome-ignore lint/suspicious/noThenProperty: the point is a replacement Promise whose `then` is incompatible with native promises
    FakePromise.prototype.then = function incompatibleThen(): never {
      throw new TypeError('incompatible receiver');
    };
    g.Promise = FakePromise;
    const realToString = Function.prototype.toString;
    const liars = new Set<unknown>([FakePromise, FakePromise.prototype.then]);
    Function.prototype.toString = function lyingToString(this: unknown): string {
      return liars.has(this) ? 'function () { [native code] }' : realToString.call(this);
    };
    try {
      const r = install(g, { cleanThen: undefined });
      const el = new (g.Media as new () => { play(): Promise<unknown> })();
      const caught = await el.play().catch((e: unknown) => e);
      expect(caught).toBe(reason);
      expect(r.originOf(reason)).toBeDefined();
      r.stop();
    } finally {
      Function.prototype.toString = realToString;
    }
  });
});

describe('installAsyncOrigins - the engine intrinsic then', () => {
  const proto =
    (then: unknown): (() => unknown) =>
    () => ({ then });

  it('is used when it is native, even though the global Promise is a replacement', async () => {
    const reason = stackless();
    const g: Fake = { ...fakeGlobal(() => Promise.reject(reason)), Promise: class Replacement {} };
    const r = install(g);
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    await expect(el.play()).rejects.toBe(reason);
    expect(r.originOf(reason)).toBeDefined();
  });

  it('is skipped when it is not native (patched in place), a provider throws, or it has no then; the next source is tried', () => {
    for (const provider of [
      proto(() => undefined),
      () => {
        throw new Error('x');
      },
      () => null,
      proto(undefined),
    ]) {
      const real = Promise.resolve(1);
      const g: Fake = { ...fakeGlobal(() => real), Promise: class NotNative {} };
      const r = install(g, { intrinsicPromisePrototype: provider });
      const el = new (g.Media as new () => { play(): unknown })();
      expect(el.play()).toBe(real); // no clean then anywhere: untouched, keyed by promise
      expect(r.originOfPromise(real)).toBeDefined();
      r.stop();
    }
  });

  it("falls back to the global then when the intrinsic is unavailable but the global Promise is the engine's own", async () => {
    const reason = stackless();
    const g: Fake = { ...fakeGlobal(() => Promise.reject(reason)), Promise };
    const r = install(g, { intrinsicPromisePrototype: () => undefined });
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    await expect(el.play()).rejects.toBe(reason);
    expect(r.originOf(reason)).toBeDefined();
  });
});

// Chromium's async DOMExceptions (Clipboard.readText, createImageBitmap) carry a stack that is ONLY the header line, no frames.
describe('installAsyncOrigins - a reason whose stack has no frames', () => {
  const rejectWith = (stack: string | undefined) => {
    const reason = Object.assign(new Error('x'), { name: 'NotAllowedError' });
    Object.defineProperty(reason, 'stack', { value: stack, configurable: true });
    const g = fakeGlobal(() => Promise.reject(reason));
    const r = install(g);
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    return { reason, r, call: () => el.play().catch((e: unknown) => e) };
  };

  it('is recorded when the stack is only a header line (V8 DOMException), or blank', async () => {
    for (const stack of [
      'NotAllowedError: Failed to execute readText',
      '  ',
      'NotAllowedError: a\n',
      // header text that LOOKS like a frame must not hide the call site
      'NotAllowedError: connect user@host:8080 failed',
      'NotAllowedError: need\nat least one source',
      'Error: x\nfoo@bar:1',
    ]) {
      const { reason, r, call } = rejectWith(stack);
      await call();
      expect(r.originOf(reason), JSON.stringify(stack)).toBeDefined();
      r.stop();
    }
  });

  it('is NOT recorded when the stack has frames of its own (V8, Firefox/WebKit style)', async () => {
    for (const stack of [
      'TypeError: bad\n    at query (https://app.test/a.js:1:2)',
      'query@https://app.test/a.js:1:2\nmain@https://app.test/a.js:5:6',
    ]) {
      const { reason, r, call } = rejectWith(stack);
      await call();
      expect(r.originOf(reason), stack).toBeUndefined();
      r.stop();
    }
  });
});

// A wrapped API that rejects with its OWN stack (a TypeError from argument validation) has the wrapper on top of that stack. The
// recorder exposes the stack of a throwaway call through the same wrapper code so the report can recognise and drop that frame.
describe("installAsyncOrigins - the wrapper frame in a reason's own stack", () => {
  const locationOf = (line: string | undefined): string | undefined =>
    /(\S+:\d+:\d+)\)?\s*$/.exec(line ?? '')?.[1];
  const frameLines = (stack: string): string[] =>
    stack.split('\n').filter((line) => /^\s+at\s/.test(line));

  it("probeStack names the wrapper call site: the frame just above the thrower is the one in a real reason's own stack", async () => {
    const g = fakeGlobal(() => Promise.reject(new TypeError('bad argument'))); // stack made INSIDE the original: wrapper is on it
    const r = install(g);
    const el = new (g.Media as new () => { play(): Promise<unknown> })();
    const reason = (await el.play().catch((e: unknown) => e)) as Error;
    const probe = frameLines(r.probeStack ?? '');
    const thrower = probe.findIndex((line) => line.includes('probeThrower'));
    expect(thrower).toBeGreaterThanOrEqual(0);
    const site = locationOf(probe[thrower + 1]);
    expect(site).toBeDefined();
    expect(frameLines(reason.stack ?? '').map(locationOf)).toContain(site);
  });

  it("has no probe stack when the realm's errors carry none", () => {
    const g = fakeGlobal(() => Promise.resolve());
    class NoStack {} // an Error constructor whose instances carry no .stack
    const r = install(g, { global: { ...g, Error: NoStack } as never });
    expect(r.probeStack).toBeUndefined();
  });
});
