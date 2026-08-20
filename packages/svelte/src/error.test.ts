import type { Bugsee } from '@bugsee/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleErrorWithBugsee, reportSvelteError } from './error';

function fakeClient() {
  const logException = vi.fn(
    (
      _error: unknown,
      _options?: { mechanism?: string; labels?: string[] },
    ): Promise<{ ok: true }> => Promise.resolve({ ok: true }),
  );
  return { client: { logException } as unknown as Bugsee, logException };
}

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('reportSvelteError', () => {
  it('reports the error with the default `uncaught` mechanism and the route id as a label', () => {
    const { client, logException } = fakeClient();
    reportSvelteError(new Error('boom'), { routeId: '/users/[id]', getClient: () => client });
    const opts = logException.mock.calls[0]?.[1];
    expect(opts?.mechanism).toBe('uncaught');
    expect(opts?.labels).toEqual(['svelte.route:/users/[id]']);
  });

  it('omits labels entirely (no `labels` key) when there is no route id', () => {
    const { client, logException } = fakeClient();
    reportSvelteError(new Error('x'), { getClient: () => client });
    const opts = logException.mock.calls[0]?.[1] ?? {};
    expect('labels' in opts).toBe(false); // not even `labels: undefined` — the key is absent
  });

  it('applies a mechanism override', () => {
    const { client, logException } = fakeClient();
    reportSvelteError(new Error('x'), { getClient: () => client, mechanism: 'programmatic' });
    expect(logException.mock.calls[0]?.[1]?.mechanism).toBe('programmatic');
  });

  it('is a no-op when no client is resolvable', () => {
    expect(() => reportSvelteError(new Error('x'), { getClient: () => undefined })).not.toThrow();
  });

  it('falls back to the carrier client when no getClient is injected', () => {
    const { client, logException } = fakeClient();
    (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__ = { '0.0.0': { client } };
    reportSvelteError(new Error('via-carrier'));
    expect(logException).toHaveBeenCalledTimes(1);
  });
});

describe('handleErrorWithBugsee', () => {
  it('returns a handleError hook that reports the error, labeled with the navigation route id', () => {
    const { client, logException } = fakeClient();
    const handleError = handleErrorWithBugsee(undefined, { getClient: () => client });
    handleError({ error: new Error('render boom'), event: { route: { id: '/blog/[slug]' } } });
    expect(logException.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(logException.mock.calls[0]?.[1]?.labels).toEqual(['svelte.route:/blog/[slug]']);
  });

  it('DELEGATES to (and returns the value of) the app handleError, which still runs', () => {
    const { client } = fakeClient();
    const appHandler = vi.fn(() => ({ message: 'Custom error page' }));
    const handleError = handleErrorWithBugsee(appHandler, { getClient: () => client });
    const input = { error: new Error('x'), event: { route: { id: '/' } } };
    const result = handleError(input);
    expect(appHandler).toHaveBeenCalledWith(input); // the app's handler runs
    expect(result).toEqual({ message: 'Custom error page' }); // …and its return is forwarded to SvelteKit
  });

  // The four cases below all describe a DEGRADED route shape: no label is expected, but THE ERROR MUST
  // STILL BE REPORTED. `expect(calls[0]?.[1]?.labels).toBeUndefined()` alone cannot say that — it passes
  // just as happily when `logException` was never called at all, which is exactly what happens if a
  // property read on the framework-supplied `event` throws into the surrounding `neverThrow`. Every one of
  // these therefore asserts the REPORT first and the absent label second.
  const expectReportedWithoutLabel = (
    logException: ReturnType<typeof fakeClient>['logException'],
    error: unknown,
  ) => {
    expect(logException).toHaveBeenCalledTimes(1);
    expect(logException.mock.calls[0]?.[0]).toBe(error);
    const opts = logException.mock.calls[0]?.[1] ?? {};
    expect('labels' in opts).toBe(false);
  };

  it('tolerates a missing event entirely (server-thrown or pre-route error) — reports, no route label', () => {
    const { client, logException } = fakeClient();
    const handleError = handleErrorWithBugsee(undefined, { getClient: () => client });
    const error = new Error('x');
    handleError({ error });
    expectReportedWithoutLabel(logException, error);
  });

  it('tolerates an event with NO route object — reports, no route label', () => {
    // `HandleErrorInput` declares `route` optional, so this is a supported input, and it is the only shape
    // that exercises the second `?.` in `input.event?.route?.id`.
    const { client, logException } = fakeClient();
    const handleError = handleErrorWithBugsee(undefined, { getClient: () => client });
    const error = new Error('x');
    handleError({ error, event: {} });
    expectReportedWithoutLabel(logException, error);
  });

  it('tolerates a NULL route id (SvelteKit passes null for a route without an id) — no bogus label', () => {
    const { client, logException } = fakeClient();
    const handleError = handleErrorWithBugsee(undefined, { getClient: () => client });
    const error = new Error('x');
    handleError({ error, event: { route: { id: null } } });
    expectReportedWithoutLabel(logException, error); // not 'svelte.route:null'
  });

  it('treats an EMPTY route id as absent — no `svelte.route:` label with nothing after the colon', () => {
    // An empty id is not a route; labelling with a bare `svelte.route:` creates a meaningless
    // high-traffic label that groups unrelated issues together in the dashboard.
    const { client, logException } = fakeClient();
    const handleError = handleErrorWithBugsee(undefined, { getClient: () => client });
    const error = new Error('x');
    handleError({ error, event: { route: { id: '' } } });
    expectReportedWithoutLabel(logException, error);
  });
});
