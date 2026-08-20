import type { Bugsee } from '@bugsee/browser';
import { BUGSEE_SDK_VERSION } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkComponentStack, reportReactError, reportRouteError } from './report';

// A fake client capturing logException calls (the only method the adapter touches).
function fakeClient() {
  const logException = vi.fn(
    (_error: unknown, _options?: { mechanism?: string }): Promise<{ ok: true }> =>
      Promise.resolve({ ok: true }),
  );
  const client = { logException } as unknown as Bugsee;
  return { client, logException };
}

const COMPONENT_STACK = '\n    in Widget (at App.tsx:10)\n    in App';

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('reportReactError', () => {
  it('reports the error to the injected client with the default `uncaught` mechanism', () => {
    const { client, logException } = fakeClient();
    reportReactError(new Error('render failed'), { getClient: () => client });
    expect(logException).toHaveBeenCalledTimes(1);
    expect((logException.mock.calls[0]?.[0] as Error).message).toBe('render failed');
    expect(logException.mock.calls[0]?.[1]?.mechanism).toBe('uncaught');
  });

  it('applies a mechanism override', () => {
    const { client, logException } = fakeClient();
    reportReactError(new Error('x'), { getClient: () => client, mechanism: 'programmatic' });
    expect(logException.mock.calls[0]?.[1]?.mechanism).toBe('programmatic');
  });

  it('links the component stack onto the reported error via error.cause', () => {
    const { client, logException } = fakeClient();
    const err = new Error('boom');
    reportReactError(err, { getClient: () => client, componentStack: COMPONENT_STACK });
    const reported = logException.mock.calls[0]?.[0] as Error;
    expect(reported).toBe(err); // the SAME object (preserves the core's instance-dedup)
    expect((reported.cause as Error).stack).toContain('in Widget'); // component stack linked via cause
  });

  it('is a no-op when no client is resolvable (SDK not launched)', () => {
    expect(() => reportReactError(new Error('x'), { getClient: () => undefined })).not.toThrow();
  });

  it('does NOT mutate the error (no cause linked) when there is no client to report to', () => {
    const err = new Error('x');
    // The component-stack link must run only when we actually report — never touch the app's error if the
    // SDK is not launched (resolveClient runs BEFORE linkComponentStack).
    reportReactError(err, { getClient: () => undefined, componentStack: COMPONENT_STACK });
    expect(err.cause).toBeUndefined();
  });

  it('falls back to the carrier client when no getClient is injected', () => {
    const { client, logException } = fakeClient();
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = { [BUGSEE_SDK_VERSION]: { client } }; // seed the carrier slot
    reportReactError(new Error('via-carrier'));
    expect(logException).toHaveBeenCalledTimes(1);
    expect((logException.mock.calls[0]?.[0] as Error).message).toBe('via-carrier');
  });

  it('is a no-op (no throw) when no SDK is launched and no getClient is injected', () => {
    expect(() => reportReactError(new Error('x'))).not.toThrow(); // carrier empty → defaultGetClient undefined
  });

  it('still REPORTS an error whose `cause` cannot be written (frozen / sealed)', () => {
    // The component-stack link is best-effort ENRICHMENT. `error.cause = frame` is an assignment to a
    // non-extensible object, which throws a TypeError in strict mode — and that throw reached
    // `reportReactError`'s outer guard BEFORE `reportError` ran, so a frozen error produced NO report at
    // all. The customer's crash disappeared because the SDK failed to decorate it.
    for (const harden of [Object.freeze, Object.seal, Object.preventExtensions]) {
      const { client, logException } = fakeClient();
      const err = harden(new Error(`hardened by ${harden.name}`));
      reportReactError(err, { getClient: () => client, componentStack: COMPONENT_STACK });
      expect(logException).toHaveBeenCalledTimes(1);
      expect(logException.mock.calls[0]?.[0]).toBe(err); // the SAME object, unenriched but reported
    }
  });

  it('still reports when reading the existing `cause` throws', () => {
    // The frame chains any EXISTING cause behind it, so the link also READS `error.cause` — a getter the
    // app owns, on an object the app owns.
    const { client, logException } = fakeClient();
    const err = new Error('boom');
    Object.defineProperty(err, 'cause', {
      get() {
        throw new Error('hostile cause getter');
      },
      configurable: true,
    });
    expect(() =>
      reportReactError(err, { getClient: () => client, componentStack: COMPONENT_STACK }),
    ).not.toThrow();
    expect(logException).toHaveBeenCalledTimes(1);
  });
});

describe('linkComponentStack', () => {
  it('attaches the component stack as the error cause (described via .stack)', () => {
    const err = new Error('boom');
    linkComponentStack(err, COMPONENT_STACK);
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).stack).toBe(`React component stack:${COMPONENT_STACK}`);
  });

  it('preserves an existing cause by chaining it behind the component-stack frame', () => {
    const root = new Error('root cause');
    const err = new Error('boom');
    err.cause = root;
    linkComponentStack(err, COMPONENT_STACK);
    expect((err.cause as Error).stack).toContain('in Widget'); // component-stack frame is now the direct cause
    expect((err.cause as Error).cause).toBe(root); // the original cause is chained behind it
  });

  it('is a no-op for a non-Error value', () => {
    const value = { not: 'an error' };
    linkComponentStack(value, COMPONENT_STACK);
    expect(value).toEqual({ not: 'an error' }); // unchanged
  });

  it('names the cause frame so an app inspecting `err.cause` can tell what linked it', () => {
    // The frame becomes part of the APPLICATION's error object; anything logging `err.cause.message`
    // (a very ordinary thing to do) sees this string.
    const err = new Error('boom');
    linkComponentStack(err, COMPONENT_STACK);
    expect((err.cause as Error).message).toBe(`React component stack:${COMPONENT_STACK}`);
  });

  it('leaves a frozen error untouched rather than throwing at the app', () => {
    const err = Object.freeze(new Error('boom'));
    expect(() => linkComponentStack(err, COMPONENT_STACK)).not.toThrow();
    expect(err.cause).toBeUndefined();
  });

  it('is a no-op for an empty or undefined component stack', () => {
    const a = new Error('a');
    linkComponentStack(a, undefined);
    expect(a.cause).toBeUndefined();
    const b = new Error('b');
    linkComponentStack(b, '');
    expect(b.cause).toBeUndefined();
  });
});

describe('reportRouteError', () => {
  it('reports a route error the router surfaced, and dedupes a re-render of the same one', () => {
    // A react-router data router catches a route element's render throw in its OWN boundary, before
    // any ancestor sees it — so a BugseeErrorBoundary around <RouterProvider> never fires and nothing
    // is reported. The app picks the error up from `useRouteError()` and hands it here instead.
    const { client, logException } = fakeClient();
    const error = new Error('route boom');
    reportRouteError(error, { getClient: () => client });
    reportRouteError(error, { getClient: () => client }); // a re-render of the same error element
    expect(logException).toHaveBeenCalledTimes(2); // both forwarded; the CORE dedupes by instance
    expect(logException.mock.calls[0]?.[0]).toBe(error);
    expect(logException.mock.calls[0]?.[1]).toMatchObject({ mechanism: 'uncaught' });
  });

  it('lets the caller override the mechanism', () => {
    const { client, logException } = fakeClient();
    reportRouteError(new Error('x'), { getClient: () => client, mechanism: 'programmatic' });
    expect(logException.mock.calls[0]?.[1]).toMatchObject({ mechanism: 'programmatic' });
  });

  it('links a component stack when the caller has one', () => {
    const { client, logException } = fakeClient();
    const error = new Error('x');
    reportRouteError(error, { getClient: () => client, componentStack: '\n    at Route' });
    expect((logException.mock.calls[0]?.[0] as Error).cause).toBeInstanceOf(Error);
  });

  it('never throws out of the app when there is no launched client', () => {
    expect(() => reportRouteError(new Error('x'), { getClient: () => undefined })).not.toThrow();
  });
});
