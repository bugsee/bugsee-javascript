import type { Bugsee } from '@bugsee/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkComponentStack, reportReactError } from './report';

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
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = { '0.0.0': { client } }; // seed the carrier slot
    reportReactError(new Error('via-carrier'));
    expect(logException).toHaveBeenCalledTimes(1);
    expect((logException.mock.calls[0]?.[0] as Error).message).toBe('via-carrier');
  });

  it('is a no-op (no throw) when no SDK is launched and no getClient is injected', () => {
    expect(() => reportReactError(new Error('x'))).not.toThrow(); // carrier empty → defaultGetClient undefined
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

  it('is a no-op for an empty or undefined component stack', () => {
    const a = new Error('a');
    linkComponentStack(a, undefined);
    expect(a.cause).toBeUndefined();
    const b = new Error('b');
    linkComponentStack(b, '');
    expect(b.cause).toBeUndefined();
  });
});
