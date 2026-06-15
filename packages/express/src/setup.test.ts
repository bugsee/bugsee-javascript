import { describe, expect, it, vi } from 'vitest';
import type { ErrorMiddleware, RequestMiddleware } from './middleware';
import { setupExpress, setupExpressErrorHandler } from './setup';

// A fake Express app that records the order/arity of registered middleware.
function fakeApp() {
  const stack: Array<RequestMiddleware | ErrorMiddleware> = [];
  const app = {
    use(handler: RequestMiddleware | ErrorMiddleware) {
      stack.push(handler);
      return app;
    },
  };
  return { app, stack };
}

// A fake Express app that ALSO has a listen() method (the deterministic install path).
function fakeAppWithListen() {
  const stack: Array<RequestMiddleware | ErrorMiddleware> = [];
  const listenCalls: unknown[][] = [];
  const app = {
    use(handler: RequestMiddleware | ErrorMiddleware) {
      stack.push(handler);
      return app;
    },
    listen(...args: never[]) {
      listenCalls.push(args);
      return 'server';
    },
  };
  return { app, stack, listenCalls };
}

const fakeReq = () => ({ headers: {} }) as never;
const fakeRes = () => ({ statusCode: 200, once: () => undefined }) as never;

describe('setupExpress', () => {
  it('installs the request middleware now + a lazy error-handler installer', () => {
    const { app, stack } = fakeApp();
    setupExpress(app);
    expect(stack).toHaveLength(2); // [installer(3-arg), requestHandler(3-arg)]
    expect(stack[0]?.length).toBe(3);
    expect(stack[1]?.length).toBe(3);
  });

  it('appends the error handler (a 4-arg middleware) on the first request, after the routes', () => {
    const { app, stack } = fakeApp();
    setupExpress(app);
    const installer = stack[0] as RequestMiddleware;
    const next = vi.fn();
    installer(fakeReq(), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(stack).toHaveLength(3);
    expect(stack[2]?.length).toBe(4); // express recognizes a 4-arg fn as error middleware
  });

  it('appends the error handler at most once across requests', () => {
    const { app, stack } = fakeApp();
    setupExpress(app);
    const installer = stack[0] as RequestMiddleware;
    installer(fakeReq(), fakeRes(), vi.fn());
    installer(fakeReq(), fakeRes(), vi.fn());
    expect(stack).toHaveLength(3); // not 4
  });

  it('skips the error handler entirely when autoErrorHandler is false', () => {
    const { app, stack } = fakeApp();
    setupExpress(app, { autoErrorHandler: false });
    expect(stack).toHaveLength(1); // only the request middleware
    expect(stack[0]?.length).toBe(3);
  });

  it('installs the error handler deterministically when app.listen() is called', () => {
    const { app, stack, listenCalls } = fakeAppWithListen();
    setupExpress(app);
    expect(stack).toHaveLength(2); // installer + requestHandler, NOT yet the error handler

    const result = app.listen(3000 as never);
    expect(stack).toHaveLength(3); // appended at listen time, before any request
    expect(stack[2]?.length).toBe(4);
    expect(listenCalls).toEqual([[3000]]); // the original listen still runs with the forwarded args …
    expect(result).toBe('server'); // … and its return value is forwarded
  });

  it('installs at most once across listen() + a first request', () => {
    const { app, stack } = fakeAppWithListen();
    setupExpress(app);
    app.listen(3000 as never); // installs
    (stack[0] as RequestMiddleware)(fakeReq(), fakeRes(), vi.fn()); // first request → no-op
    expect(stack).toHaveLength(3); // still only one error handler
  });
});

describe('setupExpressErrorHandler', () => {
  it('installs the error handler (a 4-arg middleware)', () => {
    const { app, stack } = fakeApp();
    setupExpressErrorHandler(app);
    expect(stack).toHaveLength(1);
    expect(stack[0]?.length).toBe(4);
  });
});
