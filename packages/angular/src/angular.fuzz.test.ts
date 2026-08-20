import type { Bugsee } from '@bugsee/browser';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { createAngularErrorHandler, reportAngularError } from './error';
import { type RouteSnapshotLike, routePatternFromSnapshot, setRouteNameFromRouter } from './router';

/**
 * Property-based tests for the two @bugsee/angular surfaces fed by HOST-supplied objects: the value Angular
 * hands `ErrorHandler.handleError` (literally anything a `throw` can produce) and the activated-route
 * snapshot tree walked off the app's `Router`. This adapter is a structural peer — it never imports
 * `@angular/core` — so "whatever the host presents" IS the input domain.
 *
 * The invariants, stated as the app owner would:
 *   1. THE APP'S ERROR PIPELINE IS UNTOUCHED — the chained delegate always runs, with the value Angular
 *      threw, unmodified. (The binding project principle: an interceptor must not alter host behaviour.)
 *   2. THE ERROR IS ALWAYS REPORTED when a client is available. Unwrapping `ngOriginalError` is a
 *      best-effort refinement; it must never cost the report.
 *   3. THE ROUTE PATTERN IS A MODEL-CHECKED JOIN of the snapshot chain, bounded and total.
 */

/** Every value a `throw` can hand `handleError`, including Angular's wrapper and hostile shapes.
 *  Generated as FACTORIES: fast-check stringifies and clone-probes its values, which would trip the
 *  hostile getters/traps inside the framework rather than inside the code under test. */
const thrownValue = fc.oneof(
  fc.anything().map((v) => () => v),
  fc.constant(() => null),
  fc.constant(() => undefined),
  fc.constant(() => new Error('plain')),
  fc.constant(() => Object.assign(new Error('w'), { ngOriginalError: new Error('inner') })),
  fc.constant(() => Object.assign(new Error('w'), { ngOriginalError: null })),
  fc.constant(() => Object.assign(new Error('w'), { ngOriginalError: undefined })),
  fc.constant(() => Object.assign(new Error('w'), { ngOriginalError: 'a string cause' })),
  fc.constant(() => ({
    get ngOriginalError(): unknown {
      throw new Error('hostile ngOriginalError getter');
    },
  })),
  fc.constant(
    () =>
      new Proxy(
        {},
        {
          has() {
            throw new Error('hostile `in` trap');
          },
          get() {
            throw new Error('hostile get trap');
          },
        },
      ),
  ),
  fc.constant(() => Object.create(null) as unknown),
);

/** The unwrap a CORRECT reader performs; `undefined` here means "could not be determined". */
function modelUnwrap(error: unknown): { ok: true; value: unknown } | { ok: false } {
  try {
    if (error !== null && typeof error === 'object' && 'ngOriginalError' in error) {
      const wrapped = (error as { ngOriginalError?: unknown }).ngOriginalError;
      if (wrapped !== undefined && wrapped !== null) return { ok: true, value: wrapped };
    }
    return { ok: true, value: error };
  } catch {
    return { ok: false };
  }
}

function trackingClient() {
  const logException = vi.fn((_error: unknown, _options?: unknown) => Promise.resolve());
  return { client: { logException } as unknown as Bugsee, logException };
}

describe('reportAngularError (fuzz)', () => {
  it('reports EXACTLY ONCE for any thrown value, unwrapping ngOriginalError when it is usable', () => {
    fc.assert(
      fc.property(thrownValue, (makeThrown) => {
        const thrown = makeThrown();
        const { client, logException } = trackingClient();
        expect(() => reportAngularError(thrown, { getClient: () => client })).not.toThrow();

        expect(logException).toHaveBeenCalledTimes(1);
        const reported = logException.mock.calls[0]?.[0];
        const model = modelUnwrap(thrown);
        if (model.ok) {
          expect(reported).toBe(model.value);
        } else {
          // An unreadable value cannot be unwrapped — but it MUST still be reported, as itself. The
          // unwrap is a refinement; losing it must not lose the error.
          expect(reported).toBe(thrown);
        }
      }),
    );
  });
});

describe('the Angular ErrorHandler seam (fuzz)', () => {
  it('always delegates the ORIGINAL thrown value, however broken the SDK is', () => {
    const brokenClient = fc.oneof(
      fc.constant(() => undefined),
      fc.constant(() => {
        throw new Error('resolver failed');
      }),
      fc.constant(
        () =>
          new Proxy({} as Bugsee, {
            get: () => () => {
              throw new Error('SDK internal failure');
            },
          }),
      ),
      fc.constant(() => ({ logException: () => Promise.resolve() }) as unknown as Bugsee),
    );
    fc.assert(
      fc.property(thrownValue, brokenClient, (makeThrown, getClient) => {
        const thrown = makeThrown();
        const delegate = { handleError: vi.fn() };
        const handler = createAngularErrorHandler({ getClient, delegate });
        expect(() => handler.handleError(thrown)).not.toThrow();
        expect(delegate.handleError).toHaveBeenCalledTimes(1);
        // Identity, not deep equality — a deep compare would read the hostile getters/traps itself.
        expect(delegate.handleError.mock.calls[0]?.[0]).toBe(thrown);
      }),
    );
  });
});

describe('routePatternFromSnapshot (fuzz)', () => {
  /** A snapshot chain as a list of `routeConfig.path` values (null = a pathless/componentless level). */
  const pathChain = fc.array(fc.option(fc.string(), { nil: null }), { maxLength: 80 });

  const buildTree = (paths: readonly (string | null)[]): RouteSnapshotLike | null => {
    let node: RouteSnapshotLike | null = null;
    for (let i = paths.length - 1; i >= 0; i--) {
      const p = paths[i];
      node = { routeConfig: p === null || p === undefined ? null : { path: p }, firstChild: node };
    }
    return node;
  };

  /** The whole specification: join the non-empty paths of the first 64 levels under a leading slash. */
  const model = (paths: readonly (string | null)[]): string | undefined => {
    const segments = paths
      .slice(0, 64)
      .filter((p): p is string => typeof p === 'string' && p !== '');
    return segments.length > 0 ? `/${segments.join('/')}` : undefined;
  };

  it('equals the model join for any chain (empty + pathless levels skipped, depth-bounded)', () => {
    fc.assert(
      fc.property(pathChain, (paths) => {
        expect(routePatternFromSnapshot(buildTree(paths))).toBe(model(paths));
      }),
    );
  });

  it('terminates and stays bounded on a CYCLIC tree (a malformed host snapshot)', () => {
    const cyclic: Record<string, unknown> = { routeConfig: { path: 'loop' } };
    cyclic.firstChild = cyclic;
    const pattern = routePatternFromSnapshot(cyclic as never);
    // exactly the depth bound, no more — the walk must not run away
    expect(pattern).toBe(`/${Array(64).fill('loop').join('/')}`);
  });

  it('is total: undefined, never a throw, for any non-tree the host presents', () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(null), fc.constant(undefined), fc.anything()), (input) => {
        expect(() => routePatternFromSnapshot(input as never)).not.toThrow();
      }),
    );
  });

  it('names the transaction with exactly the pattern the reader produced, or not at all', () => {
    fc.assert(
      fc.property(pathChain, (paths) => {
        const setRouteName = vi.fn();
        const client = {
          ext: () => ({ setRouteName, getActiveSpan: () => undefined }),
        } as unknown as Bugsee;
        const router = { routerState: { snapshot: { root: buildTree(paths) } } };
        setRouteNameFromRouter(router as never, { getClient: () => client });
        const expected = model(paths);
        if (expected === undefined) expect(setRouteName).not.toHaveBeenCalled();
        else expect(setRouteName).toHaveBeenCalledExactlyOnceWith(expected);
      }),
    );
  });
});

describe('the unwrap is silent on ordinary values (fuzz)', () => {
  /** Everything an app can plausibly `throw`, none of which is an SDK failure. */
  const ordinaryThrown = fc.oneof(
    fc.constant(() => null),
    fc.constant(() => undefined),
    fc.constant(() => 0),
    fc.constant(() => ''),
    fc.constant(() => false),
    fc.constant(() => 'a string error'),
    fc.constant(() => 123n),
    fc.constant(() => Symbol('s')),
    fc.constant(() => new Error('plain')),
    fc.constant(() => ({ message: 'a plain object' })),
    fc.constant(() => Object.assign(new Error('w'), { ngOriginalError: new Error('inner') })),
    fc.constant(() => Object.assign(new Error('w'), { ngOriginalError: null })),
    fc.constant(() => Object.assign(new Error('w'), { ngOriginalError: undefined })),
    fc.constant(() => Object.create(null) as unknown),
  );

  it('reports NO SDK-internal error while unwrapping any ordinary thrown value', () => {
    // The unwrap has its own `neverThrow(…, options.onError)` sink, so weakening `originalError`'s
    // precondition (`error !== null && typeof error === 'object' && 'ngOriginalError' in error`) no longer
    // loses the report — it degrades to a swallowed TypeError routed to the host's `onError` for the most
    // ordinary throws there are (`throw null`, `throw 'msg'`, a primitive). Silence is the contract; only
    // a genuinely hostile value (a throwing getter / proxy trap) may fire `onError`.
    fc.assert(
      fc.property(ordinaryThrown, (makeThrown) => {
        const thrown = makeThrown();
        const onError = vi.fn();
        const { client, logException } = trackingClient();
        reportAngularError(thrown, { getClient: () => client, onError });
        expect(logException).toHaveBeenCalledTimes(1);
        expect(onError).not.toHaveBeenCalled();
      }),
    );
  });
});
