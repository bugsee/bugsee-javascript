import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the node-only server composition so we test the DISPATCH logic (which branch runs), not a real
// launch. vi.mock intercepts the dynamic `await import('./server')` inside register().
const { registerServer } = vi.hoisted(() => ({ registerServer: vi.fn() }));
vi.mock('./server', () => ({ registerServer }));

import { register } from './register';

describe('register (NEXT_RUNTIME dispatcher)', () => {
  const original = process.env.NEXT_RUNTIME;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = original;
    registerServer.mockClear();
  });

  it('dispatches to the server (node) composition on the nodejs runtime', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    await register('my-token', { captureNetwork: false });
    expect(registerServer).toHaveBeenCalledWith('my-token', { captureNetwork: false });
  });

  it('does not launch the node server on the edge runtime (edge wired in N2)', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    await register('my-token');
    expect(registerServer).not.toHaveBeenCalled();
  });

  it('does not launch when NEXT_RUNTIME is unset', async () => {
    delete process.env.NEXT_RUNTIME;
    await register('my-token');
    expect(registerServer).not.toHaveBeenCalled();
  });
});
