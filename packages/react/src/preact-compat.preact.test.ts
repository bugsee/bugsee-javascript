import type { Bugsee } from '@bugsee/browser';
import { createElement } from 'react'; // aliased to preact/compat by vitest.preact.config.ts
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { BugseeErrorBoundary, withBugseeErrorBoundary } from './error-boundary';

// Preact 11 smoke: the error boundary must catch a render throw under `preact/compat`, report it, and render
// the fallback. Guards the README's claim that @bugsee/react works through the compat alias.

function fakeClient() {
  const logException = vi.fn(async () => ({ ok: true }) as const);
  return { client: { logException } as unknown as Bugsee, logException };
}

function Boom(): never {
  throw new Error('preact render boom');
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe('@bugsee/react under preact/compat 11', () => {
  it('resolves react to Preact (the alias is live)', async () => {
    const preact = await import('preact');
    expect(typeof preact.h).toBe('function');
    const compat = (await import('react')) as unknown as { Component: unknown };
    expect(compat.Component).toBe(preact.Component);
  });

  it('BugseeErrorBoundary catches a render throw, reports it and renders the fallback', async () => {
    const { client, logException } = fakeClient();
    const onError = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(
      createElement(
        BugseeErrorBoundary,
        { getClient: () => client, onError, fallback: createElement('p', { id: 'fb' }, 'oops') },
        createElement(Boom),
      ),
    );
    await flush();
    expect(host.querySelector('#fb')?.textContent).toBe('oops');
    expect(logException).toHaveBeenCalledTimes(1);
    expect(((logException.mock.calls[0] as unknown[])[0] as Error).message).toBe(
      'preact render boom',
    );
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('withBugseeErrorBoundary wraps a component the same way', async () => {
    const { client, logException } = fakeClient();
    const Safe = withBugseeErrorBoundary(Boom, {
      getClient: () => client,
      fallback: createElement('i', { id: 'hoc' }, 'hoc-fallback'),
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    createRoot(host).render(createElement(Safe));
    await flush();
    expect(host.querySelector('#hoc')?.textContent).toBe('hoc-fallback');
    expect(logException).toHaveBeenCalledTimes(1);
  });
});
