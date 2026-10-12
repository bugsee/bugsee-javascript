import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCarrierClient, setCarrierLastLaunch } from './carrier';
import { relaunchWith } from './relaunch';

// The deadline timer of a bounded relaunch must NEVER keep a process alive (round 2, mutation survivor m21):
// a Node/Bun/Deno process whose last client stopped would otherwise sit out the full 5 s default waiting for
// a deadline nobody needs. Two properties, both observed through the real `relaunchWith`:
//   1. the timer handle is `unref()`ed when the runtime offers it (and a runtime whose handle has no `unref`,
//      i.e. a browser's number, works the same);
//   2. it is cleared once the work wins the race, so no timer outlives the relaunch.

afterEach(() => vi.restoreAllMocks());

// `@bugsee/core` has no DOM / Node lib: reach the timers through a structural view of `globalThis`.
const host = globalThis as unknown as {
  setTimeout(cb: () => void, ms?: number): unknown;
  clearTimeout(handle: unknown): void;
};
const nextTurn = (fire: () => void): void => void Promise.resolve().then(fire);

interface FakeHandle {
  unref: ReturnType<typeof vi.fn>;
  fire: () => void;
}

/** Replace `setTimeout`/`clearTimeout` with recorders; each timer is a handle the test fires by hand. */
function installFakeTimers(handleFor: (fire: () => void) => unknown) {
  const handles: unknown[] = [];
  const cleared: unknown[] = [];
  vi.spyOn(host, 'setTimeout').mockImplementation((cb: () => void) => {
    const handle = handleFor(cb);
    handles.push(handle);
    return handle;
  });
  vi.spyOn(host, 'clearTimeout').mockImplementation((handle: unknown) => {
    cleared.push(handle);
  });
  return { handles, cleared };
}

function launchedCarrier(stop: () => Promise<boolean>) {
  const carrier = {};
  setCarrierClient({ stop }, carrier);
  setCarrierLastLaunch('tok', {}, carrier);
  return carrier;
}

describe('relaunchWith — the deadline timer never keeps the process alive (m21)', () => {
  it('unref()s the timer that bounds a stop which never settles, and the deadline still wins', async () => {
    const { handles } = installFakeTimers((fire) => {
      const handle: FakeHandle = { unref: vi.fn(), fire };
      // The deadline fires on the next microtask turn, standing in for the elapsed 5 s.
      nextTurn(fire);
      return handle;
    });
    const carrier = launchedCarrier(() => new Promise<boolean>(() => {}));
    const next = { stop: vi.fn() };

    const result = await relaunchWith(() => next, undefined, carrier);

    expect(result).toBe(next);
    expect(handles).toHaveLength(1);
    expect((handles[0] as FakeHandle).unref).toHaveBeenCalledTimes(1);
  });

  it('clears the timer once the stop finishes first, so nothing is left armed', async () => {
    const { handles, cleared } = installFakeTimers((fire) => ({ unref: vi.fn(), fire }));
    const carrier = launchedCarrier(async () => true);
    const next = { stop: vi.fn() };

    await relaunchWith(() => next, undefined, carrier);

    expect(handles).toHaveLength(1);
    expect(cleared).toEqual(handles);
  });

  it('works with a handle that has no unref (a browser timer id)', async () => {
    const { cleared } = installFakeTimers((fire) => {
      nextTurn(fire);
      return 42;
    });
    const carrier = launchedCarrier(() => new Promise<boolean>(() => {}));
    const next = { stop: vi.fn() };

    await expect(relaunchWith(() => next, undefined, carrier)).resolves.toBe(next);
    expect(cleared).toEqual([42]);
  });
});
