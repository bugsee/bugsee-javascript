import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock both runtime compositions so we test the DISPATCH logic (which branch runs), not a real launch.
// vi.mock intercepts the dynamic `await import('./server' | './edge')` inside register().
const { registerServer } = vi.hoisted(() => ({ registerServer: vi.fn() }));
const { registerEdge } = vi.hoisted(() => ({ registerEdge: vi.fn() }));
vi.mock('./server', () => ({ registerServer }));
vi.mock('./edge', () => ({ registerEdge }));

import { register } from './register';

describe('register (NEXT_RUNTIME dispatcher)', () => {
  const original = process.env.NEXT_RUNTIME;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = original;
    registerServer.mockClear();
    registerEdge.mockClear();
  });

  it('dispatches to the server (node) composition on the nodejs runtime', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    await register('my-token', { captureNetwork: false });
    expect(registerServer).toHaveBeenCalledWith('my-token', { captureNetwork: false });
    expect(registerEdge).not.toHaveBeenCalled();
  });

  it('dispatches to the edge composition on the edge runtime', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    await register('my-token', { captureNetwork: false });
    expect(registerEdge).toHaveBeenCalledWith('my-token', { captureNetwork: false });
    expect(registerServer).not.toHaveBeenCalled();
  });

  it('does not launch anything when NEXT_RUNTIME is unset', async () => {
    delete process.env.NEXT_RUNTIME;
    await register('my-token');
    expect(registerServer).not.toHaveBeenCalled();
    expect(registerEdge).not.toHaveBeenCalled();
  });
});
