import { describe, expect, it, vi } from 'vitest';
import { runServerRequest } from './server-instrument';

// Wave 2.1/2.3 — the request path must be inert (docs/review/backend-express-fastify-koa.md SEV1 #1,
// docs/review/backend-hono-hapi-elysia.md SEV1 #1). `dispatch` is where express/koa call `next()` and where
// hono continues the chain, so an SDK throw before it means the ROUTE HANDLER NEVER RUNS — a customer-visible
// 500 on a request that would have succeeded, with the app's own error middleware handed a Bugsee-internal
// Error as if it were their bug. Reproduced against real express, koa and hono servers.

const info = { method: 'GET', url: '/x' };

/** A client whose service lookup throws — the confirmed @bugsee/service behaviour that reaches the engine. */
const throwingClient = () =>
  ({
    getServiceProvider: () => ({
      getImmediate: () => {
        throw new Error('SDK-INTERNAL-BOOM');
      },
    }),
  }) as never;

describe('runServerRequest never turns an SDK fault into the request’s outcome', () => {
  it('still runs the handler when the engine throws, and reports the fault', () => {
    const onError = vi.fn();
    const handler = vi.fn(() => 'APP-OK');
    expect(runServerRequest(info, { getClient: throwingClient, onError }, handler)).toBe('APP-OK');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).toContain('SDK-INTERNAL-BOOM');
  });

  it('still runs the handler when the client RESOLVER itself throws', () => {
    const handler = vi.fn(() => 'APP-OK');
    expect(
      runServerRequest(
        info,
        {
          getClient: () => {
            throw new Error('carrier broken');
          },
        },
        handler,
      ),
    ).toBe('APP-OK');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('hands the handler a working no-op span, so the adapter’s own calls are safe', () => {
    runServerRequest(info, { getClient: throwingClient }, (span) => {
      expect(() => {
        span.setRoute('/x/:id');
        span.captureError(new Error('app error'));
        span.finish(200);
      }).not.toThrow();
      return 0;
    });
  });

  it('does NOT swallow the application’s own error — that still propagates', () => {
    // The whole point of the guard is to separate the two. An app error reaching the framework's error
    // handling is correct behaviour; swallowing it would be a worse defect than the one being fixed.
    const appError = new Error('APP-ERROR');
    const onError = vi.fn();
    const handler = vi.fn(() => {
      throw appError;
    });
    expect(() => runServerRequest(info, { getClient: throwingClient, onError }, handler)).toThrow(
      appError,
    );
    expect(onError).not.toHaveBeenCalledWith(appError);
    // …and exactly ONCE. Treating the app's error as an SDK fault would re-enter the fallback dispatch and
    // run the customer's route handler a second time — a double write, not merely a lost report.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('propagates the application’s error on the healthy path, running the handler exactly ONCE', () => {
    // This is the case that pins the `dispatched` guard: the engine succeeds, so the throw comes from INSIDE
    // dispatch. Treating it as an SDK fault would re-enter the fallback and run the customer's route handler
    // a second time — a duplicated write, not merely a lost report. (With a throwing client the engine fails
    // before dispatch is ever entered, so that path cannot distinguish the two.)
    const appError = new Error('APP-ERROR');
    const onError = vi.fn();
    const handler = vi.fn(() => {
      throw appError;
    });
    expect(() => runServerRequest(info, { getClient: () => undefined, onError }, handler)).toThrow(
      appError,
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
