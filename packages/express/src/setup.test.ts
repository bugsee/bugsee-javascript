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
});

describe('setupExpressErrorHandler', () => {
  it('installs the error handler (a 4-arg middleware)', () => {
    const { app, stack } = fakeApp();
    setupExpressErrorHandler(app);
    expect(stack).toHaveLength(1);
    expect(stack[0]?.length).toBe(4);
  });
});
