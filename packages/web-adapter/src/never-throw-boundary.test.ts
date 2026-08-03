import { setCarrierClient } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportError } from './adapter';

// Wave 2.1/2.3 — the shared host boundary for @bugsee/vue, angular, svelte and solid.
//
// `reportError` runs INSIDE the framework's error seam, whose whole purpose is to make an error survivable.
// Unguarded, an SDK-internal failure escaped into the framework AND prevented the customer's own handler
// from running — measured against real Vue, a fully-recovered mount became a throw out of `app.mount()` and
// an empty DOM purely because Bugsee was installed.

const clientThatThrows = (error: unknown) =>
  ({
    logException: () => {
      throw error;
    },
  }) as never;

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('reportError is a contained host boundary', () => {
  it('does not rethrow when the SDK itself throws', () => {
    const onError = vi.fn();
    expect(() =>
      reportError(new Error('customer error'), {
        getClient: () => clientThatThrows(new Error('SDK BOOM')),
        onError,
      }),
    ).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it('does not rethrow when the client RESOLVER throws (a broken carrier)', () => {
    expect(() =>
      reportError(new Error('e'), {
        getClient: () => {
          throw new Error('carrier broken');
        },
      }),
    ).not.toThrow();
  });

  it('does not leave logException’s rejection unhandled in the host process', async () => {
    // `void client.logException(...)` surfaces a rejection as an unhandled rejection one tick later — which
    // on Node is a process crash again now that Wave 2.5 restored the default disposition.
    const g = globalThis as unknown as {
      process: { on(e: string, l: () => void): void; off(e: string, l: () => void): void };
    };
    const unhandled = vi.fn();
    g.process.on('unhandledRejection', unhandled);
    const onError = vi.fn();
    reportError(new Error('e'), {
      getClient: () =>
        ({ logException: () => Promise.reject(new Error('upload failed')) }) as never,
      onError,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    g.process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('still reports normally on the healthy path', () => {
    const logException = vi.fn(() => Promise.resolve());
    setCarrierClient({ logException } as never);
    reportError(new Error('e'), { mechanism: 'vue' as never, labels: ['a'] });
    expect(logException).toHaveBeenCalledTimes(1);
  });
});
