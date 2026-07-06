import {
  BugseeErrorBoundary as RealBugseeErrorBoundary,
  withBugseeErrorBoundary as realWithBugseeErrorBoundary,
} from '@bugsee/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock the browser umbrella launch (tested in @bugsee/browser). Spy @bugsee/react's reportReactError while
// keeping the rest of @bugsee/react REAL (so the `export *` re-export is genuinely exercised).
const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('bugsee', () => ({ launch }));
const { reportReactError } = vi.hoisted(() => ({ reportReactError: vi.fn() }));
vi.mock('@bugsee/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/react')>();
  return { ...actual, reportReactError };
});

import * as clientEntry from './client';
import { bugseeOnError, registerClient } from './client';

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

describe('client entry surface', () => {
  it('re-exports the REAL @bugsee/react boundaries (one-import DX)', () => {
    expect(clientEntry.BugseeErrorBoundary).toBe(RealBugseeErrorBoundary);
    expect(clientEntry.withBugseeErrorBoundary).toBe(realWithBugseeErrorBoundary);
  });
});
