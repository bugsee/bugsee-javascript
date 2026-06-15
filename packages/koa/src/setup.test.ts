import { describe, expect, it, vi } from 'vitest';
import { type KoaApp, setupKoa } from './setup';

describe('setupKoa', () => {
  it('registers the bugsee middleware via app.use', () => {
    const app = { use: vi.fn() };
    setupKoa(app as unknown as KoaApp);
    expect(app.use).toHaveBeenCalledTimes(1);
    expect(typeof app.use.mock.calls[0]?.[0]).toBe('function');
  });

  it('threads options into the middleware (pass-through when no client)', async () => {
    const app = { use: vi.fn() };
    setupKoa(app as unknown as KoaApp, { getClient: () => undefined });
    const mw = app.use.mock.calls[0]?.[0] as (
      ctx: unknown,
      next: () => Promise<void>,
    ) => Promise<void>;
    const next = vi.fn(async () => undefined);
    await mw({ method: 'GET', path: '/', url: '/', status: 404, headers: {} }, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
