import { setCarrierClient } from '@bugsee/core';
import {
  BugseeErrorBoundary as RealBugseeErrorBoundary,
  BugseeProfiler as RealBugseeProfiler,
  withBugseeErrorBoundary as realWithBugseeErrorBoundary,
} from '@bugsee/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the browser umbrella launch so the client-init composition is tested without a real browser
// environment (the real launch is covered in @bugsee/browser). vi.mock intercepts `import { launch }`.
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('bugsee', () => ({ launch }));

import * as clientEntry from './client';
import { createOnRouterTransitionStart, onRouterTransitionStart, registerClient } from './client';

function fakeClient() {
  return { addBreadcrumb: vi.fn<(b: unknown) => void>() };
}

describe('client entry surface', () => {
  it('re-exports the REAL @bugsee/react boundaries (one-import DX for Next apps)', () => {
    // Referential identity — proves the actual @bugsee/react symbols, not just same-shaped functions.
    expect(clientEntry.BugseeErrorBoundary).toBe(RealBugseeErrorBoundary);
    expect(clientEntry.withBugseeErrorBoundary).toBe(realWithBugseeErrorBoundary);
    expect(clientEntry.BugseeProfiler).toBe(RealBugseeProfiler);
  });
});

describe('registerClient', () => {
  afterEach(() => launch.mockReset());

  it('launches the batteries-included browser SDK with the appToken + options', () => {
    const sentinel = { id: 'browser-client' };
    launch.mockReturnValue(sentinel);
    const result = registerClient('tok', { captureLogs: false });
    expect(launch).toHaveBeenCalledWith('tok', { captureLogs: false });
    expect(result).toBe(sentinel);
  });

  it('defaults the options to an empty object', () => {
    launch.mockReturnValue({});
    registerClient('tok');
    expect(launch).toHaveBeenCalledWith('tok', {});
  });
});

describe('createOnRouterTransitionStart', () => {
  it('records a navigation breadcrumb on a soft navigation', () => {
    const client = fakeClient();
    const handler = createOnRouterTransitionStart({ getClient: () => client as never });
    handler('/dashboard', 'push');
    expect(client.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'navigation',
        category: 'navigation',
        message: '/dashboard',
        data: expect.objectContaining({ href: '/dashboard', navigationType: 'push' }),
      }),
    );
  });

  it('is a no-op when no client is active (consults the resolver, does not throw)', () => {
    const getClient = vi.fn<() => undefined>(() => undefined);
    const handler = createOnRouterTransitionStart({ getClient });
    expect(() => handler('/x', 'replace')).not.toThrow();
    expect(getClient).toHaveBeenCalledTimes(1);
  });

  it('never throws out of the router when the client throws', () => {
    const client = {
      addBreadcrumb: vi.fn(() => {
        throw new Error('capture failed');
      }),
    };
    const handler = createOnRouterTransitionStart({ getClient: () => client as never });
    expect(() => handler('/x', 'traverse')).not.toThrow();
  });

  it('defaults to the carrier client when no getClient is provided (no launch → safe no-op)', () => {
    expect(() => onRouterTransitionStart('/x', 'push')).not.toThrow();
  });

  describe('default carrier binding', () => {
    afterEach(() => setCarrierClient(undefined));

    it('records the navigation breadcrumb against the carrier client (default resolver)', () => {
      // Seed the process-global carrier the default resolver reads via getCarrierClient — proves the
      // default `onRouterTransitionStart` actually consults the carrier + records, not just no-throws.
      const client = fakeClient();
      setCarrierClient(client);
      onRouterTransitionStart('/settings', 'traverse');
      expect(client.addBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'navigation',
          message: '/settings',
          data: expect.objectContaining({ href: '/settings', navigationType: 'traverse' }),
        }),
      );
    });
  });
});
