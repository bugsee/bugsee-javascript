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
