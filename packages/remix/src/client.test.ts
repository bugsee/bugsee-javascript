import {
  BugseeErrorBoundary as RealBugseeErrorBoundary,
  withBugseeErrorBoundary as realWithBugseeErrorBoundary,
} from '@bugsee/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the browser umbrella launch (tested in @bugsee/browser). Spy @bugsee/react's reportReactError while
// keeping the rest of @bugsee/react REAL (so the `export *` re-export is genuinely exercised).
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('@bugsee/bugsee', () => ({ launch }));
const { reportReactError } = vi.hoisted(() => ({ reportReactError: vi.fn() }));
vi.mock('@bugsee/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/react')>();
  return { ...actual, reportReactError };
});

import * as clientEntry from './client';
import { bugseeOnError, captureRemixErrorBoundaryError, registerClient } from './client';

describe('registerClient', () => {
  afterEach(() => {
    launch.mockReset();
    reportReactError.mockReset();
  });

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

describe('bugseeOnError (RR7 <HydratedRouter onError>)', () => {
  afterEach(() => reportReactError.mockReset());

  it('reports the React error WITH the component stack when errorInfo is present', () => {
    const err = new Error('render boom');
    bugseeOnError(err, { componentStack: '\n  at Widget\n  at App' });
    expect(reportReactError).toHaveBeenCalledWith(err, {
      componentStack: '\n  at Widget\n  at App',
    });
  });

  it('reports without a component stack when errorInfo is absent', () => {
    const err = new Error('boom');
    bugseeOnError(err);
    expect(reportReactError).toHaveBeenCalledWith(err, {});
  });

  it('omits the component stack when errorInfo carries none', () => {
    const err = new Error('boom');
    bugseeOnError(err, {});
    expect(reportReactError).toHaveBeenCalledWith(err, {});
  });

  it('omits the component stack when React passes null (componentStack is string | null)', () => {
    const err = new Error('boom');
    bugseeOnError(err, { componentStack: null });
    expect(reportReactError).toHaveBeenCalledWith(err, {}); // null must NOT leak as a bogus stack
  });
});

describe('captureRemixErrorBoundaryError (Remix v2 root ErrorBoundary)', () => {
  afterEach(() => reportReactError.mockReset());

  it('reports a real Error (a render crash) thrown to the boundary', () => {
    const err = new Error('render crash');
    captureRemixErrorBoundaryError(err);
    expect(reportReactError).toHaveBeenCalledWith(err, {});
  });

  it('SKIPS a route-error-response (404/redirect — expected control flow, not a crash)', () => {
    // v2 `useRouteError()` yields a { status, statusText, data } route-error-response for 404s/redirects.
    captureRemixErrorBoundaryError({ status: 404, statusText: 'Not Found', data: 'x' });
    expect(reportReactError).not.toHaveBeenCalled();
  });

  it('reports a non-Error thrown value (still a crash, not a route-error-response)', () => {
    captureRemixErrorBoundaryError('a thrown string');
    expect(reportReactError).toHaveBeenCalledWith('a thrown string', {});
  });

  it('reports an object lacking a numeric `status` (not the route-error-response shape)', () => {
    const err = { statusText: 'x', data: 'y' }; // missing `status` → a real thrown object, report it
    captureRemixErrorBoundaryError(err);
    expect(reportReactError).toHaveBeenCalledWith(err, {});
  });

  it('forwards a custom getClient', () => {
    const err = new Error('x');
    const getClient = () => undefined;
    captureRemixErrorBoundaryError(err, { getClient });
    expect(reportReactError).toHaveBeenCalledWith(err, { getClient });
  });
});

describe('client entry surface', () => {
  it('re-exports the REAL @bugsee/react boundaries (one-import DX)', () => {
    expect(clientEntry.BugseeErrorBoundary).toBe(RealBugseeErrorBoundary);
    expect(clientEntry.withBugseeErrorBoundary).toBe(realWithBugseeErrorBoundary);
  });
});
