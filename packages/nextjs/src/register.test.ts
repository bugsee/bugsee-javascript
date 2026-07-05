import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock both runtime compositions so we test the DISPATCH logic (which branch runs), not a real launch.
// register() dynamic-imports the self-subpath specifiers (`@bugsee/nextjs/server` | `/edge`) — see #172 —
// so mock THOSE (not `./server`).
const { registerServer } = vi.hoisted(() => ({ registerServer: vi.fn() }));
const { registerEdge } = vi.hoisted(() => ({ registerEdge: vi.fn() }));
vi.mock('@bugsee/nextjs/server', () => ({ registerServer }));
vi.mock('@bugsee/nextjs/edge', () => ({ registerEdge }));

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

  // Portability guard (#172): the dynamic imports MUST use the self-subpath specifiers, not relative paths.
  // A relative dynamic import is inlined by the (non-splitting) CJS build, hoisting `require('bugsee/node')`
  // into the portable `.` entry. vitest resolves './server' and '@bugsee/nextjs/server' to the same module,
  // so behavioural tests can't catch a revert — this source-level guard does (the leak is a build property).
  it('dynamic-imports the self-subpath specifiers (keeps the CJS `.` entry node-free)', () => {
    const src = readFileSync(new URL('./register.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/await import\('@bugsee\/nextjs\/server'\)/);
    expect(src).toMatch(/await import\('@bugsee\/nextjs\/edge'\)/);
    expect(src).not.toMatch(/await import\('\.\/(server|edge)'\)/);
  });
});
