import { afterEach, describe, expect, it, vi } from 'vitest';

// The ConnectivityTracker is created ONLY when there is a window to listen on: a document-only source must not build
// (and key into the registry) a tracker that can never hear anything.
const connectivityTrackerFor = vi.hoisted(() => vi.fn());
vi.mock('@bugsee/trackers/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bugsee/trackers/browser')>();
  connectivityTrackerFor.mockImplementation(actual.connectivityTrackerFor);
  return { ...actual, connectivityTrackerFor };
});

import { createBrowserSystemEventsSource } from './system-events';

afterEach(() => {
  vi.unstubAllGlobals();
  connectivityTrackerFor.mockClear();
});

const doc = () => ({
  visibilityState: 'visible' as const,
  addEventListener: () => {},
  removeEventListener: () => {},
});

describe('createBrowserSystemEventsSource connectivity tracker creation', () => {
  it('is never created without a window (a document-only env never borrows the host window either)', () => {
    vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
    const off = createBrowserSystemEventsSource({ document: doc() as never }).onAny(() => {});
    expect(connectivityTrackerFor).not.toHaveBeenCalled();
    off();
  });

  it('is created, for that window, when there is one', () => {
    const win = { addEventListener: () => {}, removeEventListener: () => {} };
    const off = createBrowserSystemEventsSource({ window: win as never }).onAny(() => {});
    expect(connectivityTrackerFor).toHaveBeenCalledTimes(1);
    expect(connectivityTrackerFor.mock.calls[0]?.[0]).toMatchObject({ window: win });
    off();
  });
});
