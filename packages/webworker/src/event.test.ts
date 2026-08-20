import { describe, expect, it, vi } from 'vitest';
import { type ExtendableEventLike, withBugseeEvent } from './event';
import type { Bugsee } from './launch';

function fakeClient() {
  const logException = vi.fn((_e: unknown, _o?: unknown) => Promise.resolve({ ok: true }));
  const flush = vi.fn(() => Promise.resolve(true));
  return { client: { logException, flush } as unknown as Bugsee, logException, flush };
}

const fakeEvent = () => {
  const waited: Promise<unknown>[] = [];
  const event: ExtendableEventLike = {
    waitUntil: (p) => {
      waited.push(p);
    },
  };
  return { event, settle: () => Promise.all(waited) };
};

describe('withBugseeEvent', () => {
  it('flushes a clean sync handler via event.waitUntil', async () => {
    const { client, flush, logException } = fakeClient();
    const ran = vi.fn();
    const { event, settle } = fakeEvent();
    withBugseeEvent(client, () => ran())(event);
    expect(ran).toHaveBeenCalledTimes(1);
    await settle();
    expect(flush).toHaveBeenCalledTimes(1); // the flush was handed to waitUntil (keeps the SW alive)
    expect(logException).not.toHaveBeenCalled();
  });

  it('captures + RETHROWS a synchronous handler throw, then flushes via waitUntil', async () => {
    const { client, flush, logException } = fakeClient();
    const boom = new Error('sw boom');
    const { event, settle } = fakeEvent();
    expect(() =>
      withBugseeEvent(client, () => {
        throw boom;
      })(event),
    ).toThrow('sw boom');
    expect(logException).toHaveBeenCalledWith(boom, { mechanism: 'uncaught' });
    await settle();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('captures an async handler rejection (would be an unhandledrejection) then flushes', async () => {
    const { client, flush, logException } = fakeClient();
    const boom = new Error('sw async boom');
    const { event, settle } = fakeEvent();
    withBugseeEvent(client, async () => {
      throw boom;
    })(event);
    expect(logException).not.toHaveBeenCalled(); // not yet — the rejection settles async
    await settle();
    expect(logException).toHaveBeenCalledWith(boom, { mechanism: 'uncaught' });
    expect(flush).toHaveBeenCalledTimes(1); // flushed AFTER capturing the rejection
  });

  it('flushes after a clean async handler resolves (no capture)', async () => {
    const { client, flush, logException } = fakeClient();
    const { event, settle } = fakeEvent();
    let handlerDone = false;
    withBugseeEvent(client, async () => {
      await Promise.resolve();
      handlerDone = true;
    })(event);
    await settle();
    expect(handlerDone).toBe(true);
    expect(logException).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

// HOST-BOUNDARY CONTAINMENT (the Wave 2.1 rule `neverThrow` exists for, and which the edge sibling already
// applies at the same seam — vercel-edge/src/edge-context.ts:80).
//
// `withBugseeEvent` wraps the APPLICATION's Service Worker handler, so the customer's own error is in
// flight in the catch path. `client.logException` is NOT total: it reads `.message`/`.stack` off the thrown
// value and stringifies non-Errors, so a thrown Proxy with a throwing trap, an Error with a throwing
// `stack` getter, or an object with a throwing `toString` — all things a real handler can throw — make it
// throw synchronously. Unguarded, that SDK failure REPLACES the customer's error (their own error handling
// then sees "Bugsee internal failure" instead of what actually went wrong) and skips the flush, so the
// incident is not uploaded either. `event.waitUntil` is host-supplied too and throws InvalidStateError on a
// no-longer-active event.
describe('withBugseeEvent — the SDK never becomes the app’s failure', () => {
  const throwingCapture = (sdkError: Error) => {
    const flush = vi.fn(() => Promise.resolve(true));
    const logException = vi.fn(() => {
      throw sdkError;
    });
    return { client: { logException, flush } as unknown as Bugsee, flush, logException };
  };

  it('rethrows the APPLICATION error (not the SDK one) when capturing it fails, and still flushes', async () => {
    const sdkError = new Error('sdk internal failure');
    const appError = new Error('the app’s own failure');
    const { client, flush } = throwingCapture(sdkError);
    const onError = vi.fn();
    const { event, settle } = fakeEvent();

    expect(() =>
      withBugseeEvent(
        client,
        () => {
          throw appError;
        },
        onError,
      )(event),
    ).toThrow(appError); // the customer's error survives the SDK's

    await settle();
    expect(flush).toHaveBeenCalledTimes(1); // and the incident is still flushed before the SW dies
    expect(onError).toHaveBeenCalledWith(sdkError); // the SDK failure is reported, not swallowed silently
  });

  it('still flushes when capturing an ASYNC handler rejection fails', async () => {
    const sdkError = new Error('sdk internal failure');
    const { client, flush } = throwingCapture(sdkError);
    const onError = vi.fn();
    const { event, settle } = fakeEvent();

    withBugseeEvent(
      client,
      async () => {
        throw new Error('async app failure');
      },
      onError,
    )(event);

    await settle(); // must not reject: a rejected waitUntil promise FAILS an install/activate event
    expect(flush).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(sdkError);
  });

  it('contains a throwing event.waitUntil (InvalidStateError) instead of failing the handler', () => {
    const { client } = fakeClient();
    const waitUntilError = new Error('InvalidStateError');
    const event: ExtendableEventLike = {
      waitUntil: () => {
        throw waitUntilError;
      },
    };
    const onError = vi.fn();
    const ran = vi.fn();
    expect(() => withBugseeEvent(client, () => ran(), onError)(event)).not.toThrow();
    expect(ran).toHaveBeenCalledTimes(1); // the app's handler still ran to completion
    expect(onError).toHaveBeenCalledWith(waitUntilError);
  });

  it('a throwing onError sink cannot defeat the guard', () => {
    const { client } = throwingCapture(new Error('sdk internal failure'));
    const appError = new Error('app failure');
    const { event } = fakeEvent();
    const badSink = () => {
      throw new Error('the sink itself throws');
    };
    expect(() =>
      withBugseeEvent(
        client,
        () => {
          throw appError;
        },
        badSink,
      )(event),
    ).toThrow(appError);
  });

  it('works without an onError sink (it is optional)', async () => {
    const { client, flush } = throwingCapture(new Error('sdk internal failure'));
    const appError = new Error('app failure');
    const { event, settle } = fakeEvent();
    expect(() =>
      withBugseeEvent(client, () => {
        throw appError;
      })(event),
    ).toThrow(appError);
    await settle();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

// A failing UPLOAD must not fail the Service Worker event: `waitUntil` rejecting is how an install/activate
// event is failed, which would unregister the worker over an SDK network error.
describe('withBugseeEvent — a failing flush never fails the event', () => {
  it('reports a rejected flush to onError and still settles the waitUntil promise', async () => {
    const uploadError = new Error('upload failed');
    const client = {
      logException: vi.fn(() => Promise.resolve({ ok: true })),
      flush: vi.fn(() => Promise.reject(uploadError)),
    } as unknown as Bugsee;
    const onError = vi.fn();
    const { event, settle } = fakeEvent();
    withBugseeEvent(client, () => {}, onError)(event);
    await expect(settle()).resolves.toBeDefined(); // resolved, not rejected
    expect(onError).toHaveBeenCalledWith(uploadError);
  });

  it('survives a rejected flush with no onError sink', async () => {
    const client = {
      logException: vi.fn(() => Promise.resolve({ ok: true })),
      flush: vi.fn(() => Promise.reject(new Error('upload failed'))),
    } as unknown as Bugsee;
    const { event, settle } = fakeEvent();
    withBugseeEvent(client, () => {})(event);
    await expect(settle()).resolves.toBeDefined();
  });
});
