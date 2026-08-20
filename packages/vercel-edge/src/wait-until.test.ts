import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWaitUntil } from './wait-until';

const VERCEL_SYMBOL = Symbol.for('@vercel/request-context');

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as Record<symbol, unknown>)[VERCEL_SYMBOL];
});

describe('resolveWaitUntil', () => {
  it('uses an explicit ExecutionContext.waitUntil (Cloudflare passes ctx) — bound to ctx', () => {
    const seen: Promise<unknown>[] = [];
    const ctx = {
      tag: 'cf',
      waitUntil(this: { tag: string }, p: Promise<unknown>) {
        // `this` must be ctx (bound) — assert by reading a ctx field
        expect(this.tag).toBe('cf');
        seen.push(p);
      },
    };
    const wu = resolveWaitUntil(ctx);
    const p = Promise.resolve(1);
    wu(p);
    expect(seen).toEqual([p]);
  });

  it('reads the Vercel Edge request-context global symbol when there is no ctx (EdgeRuntime present) — bound to it', () => {
    vi.stubGlobal('EdgeRuntime', 'edge-runtime');
    const seen: Promise<unknown>[] = [];
    const requestContext = {
      tag: 'vercel',
      waitUntil(this: { tag: string }, p: Promise<unknown>) {
        // `this` must be the request-context (bound) — an unbound return would lose it
        expect(this.tag).toBe('vercel');
        seen.push(p);
      },
    };
    (globalThis as Record<symbol, unknown>)[VERCEL_SYMBOL] = { get: () => requestContext };
    const wu = resolveWaitUntil();
    const p = Promise.resolve(1);
    wu(p);
    expect(seen).toEqual([p]);
  });

  it('prefers the explicit ctx over the Vercel symbol', () => {
    vi.stubGlobal('EdgeRuntime', 'edge-runtime');
    const fromSymbol: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[VERCEL_SYMBOL] = {
      get: () => ({ waitUntil: (p: Promise<unknown>) => fromSymbol.push(p) }),
    };
    const fromCtx: Promise<unknown>[] = [];
    const wu = resolveWaitUntil({ waitUntil: (p) => fromCtx.push(p) });
    wu(Promise.resolve(1));
    expect(fromCtx).toHaveLength(1);
    expect(fromSymbol).toHaveLength(0);
  });

  it('does NOT read the Vercel symbol when EdgeRuntime is absent (not on Vercel Edge)', () => {
    const fromSymbol: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[VERCEL_SYMBOL] = {
      get: () => ({ waitUntil: (p: Promise<unknown>) => fromSymbol.push(p) }),
    };
    // no EdgeRuntime stubbed → the symbol is not consulted; a no-op is returned
    const wu = resolveWaitUntil();
    expect(() => wu(Promise.resolve(1))).not.toThrow();
    expect(fromSymbol).toHaveLength(0);
  });

  it('falls back to a no-op when the symbol holder has no usable waitUntil', () => {
    vi.stubGlobal('EdgeRuntime', 'edge-runtime');
    (globalThis as Record<symbol, unknown>)[VERCEL_SYMBOL] = { get: () => ({}) }; // no waitUntil
    const wu = resolveWaitUntil();
    expect(() => wu(Promise.resolve(1))).not.toThrow();
  });

  it("falls back to a no-op when the holder's `get` is present but NOT a function", () => {
    // `holder?.get?.()` guards only null/undefined: an optional CALL on a present, non-callable `get` still
    // throws "holder?.get is not a function". That throw escapes `resolveWaitUntil`, which `runInEdgeContext`
    // calls BEFORE its try block (edge-context.ts:62) — so it does not cost a flush, it fails the customer's
    // request outright. The global is a symbol on `globalThis` that anything in the isolate can set, and the
    // very next line already type-guards `waitUntil` for exactly this reason.
    vi.stubGlobal('EdgeRuntime', 'edge-runtime');
    for (const get of ['not-a-function', 42, {}, [], true]) {
      (globalThis as Record<symbol, unknown>)[VERCEL_SYMBOL] = { get };
      let wu: ReturnType<typeof resolveWaitUntil> | undefined;
      expect(() => {
        wu = resolveWaitUntil();
      }).not.toThrow();
      expect(() => wu?.(Promise.resolve(1))).not.toThrow();
    }
  });

  it('falls back to a no-op when the holder itself is a non-object (squatted symbol)', () => {
    vi.stubGlobal('EdgeRuntime', 'edge-runtime');
    for (const holder of ['nope', 7, true]) {
      (globalThis as Record<symbol, unknown>)[VERCEL_SYMBOL] = holder;
      expect(() => resolveWaitUntil()(Promise.resolve(1))).not.toThrow();
    }
  });

  it('falls back to a no-op when the symbol is absent entirely (EdgeRuntime present, no holder)', () => {
    vi.stubGlobal('EdgeRuntime', 'edge-runtime');
    const wu = resolveWaitUntil();
    expect(() => wu(Promise.resolve(1))).not.toThrow();
  });

  it('falls back to a no-op when a ctx is given without a waitUntil function', () => {
    const wu = resolveWaitUntil({});
    expect(() => wu(Promise.resolve(1))).not.toThrow();
  });
});
