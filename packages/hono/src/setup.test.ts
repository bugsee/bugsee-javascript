import { describe, expect, it, vi } from 'vitest';
import { type HonoApp, setupHono } from './setup';

describe('setupHono', () => {
  it('registers the bugsee middleware via app.use', () => {
    const app = { use: vi.fn() };
    setupHono(app as unknown as HonoApp);
    expect(app.use).toHaveBeenCalledTimes(1);
    expect(typeof app.use.mock.calls[0]?.[0]).toBe('function');
  });

  it('threads options into the middleware (pass-through when no client)', async () => {
    const app = { use: vi.fn() };
    setupHono(app as unknown as HonoApp, { getClient: () => undefined });
    const mw = app.use.mock.calls[0]?.[0] as (
      c: unknown,
      next: () => Promise<void>,
    ) => Promise<void>;
    const next = vi.fn(async () => undefined);
    await mw({ req: { method: 'GET', path: '/', routePath: '/', header: () => undefined } }, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
