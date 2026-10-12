import { describe, expect, it, vi } from 'vitest';
import { createBlackoutState } from './blackout';

describe('createBlackoutState', () => {
  it('starts inactive', () => {
    expect(createBlackoutState().isActive()).toBe(false);
  });

  it('start() activates and end() deactivates', () => {
    const state = createBlackoutState();
    state.start();
    expect(state.isActive()).toBe(true);
    state.end();
    expect(state.isActive()).toBe(false);
  });

  it('is idempotent and NOT counted: one end() clears any number of start()s', () => {
    const state = createBlackoutState();
    const listener = vi.fn();
    state.onChange(listener);
    state.start();
    state.start();
    state.start();
    expect(listener).toHaveBeenCalledTimes(1);
    state.end();
    expect(state.isActive()).toBe(false);
    state.end();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('end() without a start() is a silent no-op', () => {
    const state = createBlackoutState();
    const listener = vi.fn();
    state.onChange(listener);
    state.end();
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies listeners with the new state, in subscription order', () => {
    const state = createBlackoutState();
    const seen: string[] = [];
    state.onChange((active) => seen.push(`a:${active}`));
    state.onChange((active) => seen.push(`b:${active}`));
    state.start();
    state.end();
    expect(seen).toEqual(['a:true', 'b:true', 'a:false', 'b:false']);
  });

  it('the state is already updated when a listener runs', () => {
    const state = createBlackoutState();
    const observed: boolean[] = [];
    state.onChange(() => observed.push(state.isActive()));
    state.start();
    state.end();
    expect(observed).toEqual([true, false]);
  });

  it('unsubscribe stops notifications and is itself idempotent', () => {
    const state = createBlackoutState();
    const listener = vi.fn();
    const off = state.onChange(listener);
    off();
    off();
    state.start();
    expect(listener).not.toHaveBeenCalled();
  });

  it('a throwing listener goes to onError and never blocks the others or the toggle', () => {
    const onError = vi.fn();
    const state = createBlackoutState(onError);
    const boom = new Error('boom');
    const after = vi.fn();
    state.onChange(() => {
      throw boom;
    });
    state.onChange(after);
    expect(() => state.start()).not.toThrow();
    expect(state.isActive()).toBe(true);
    expect(onError).toHaveBeenCalledWith(boom);
    expect(after).toHaveBeenCalledWith(true);
  });

  it('works without an onError sink', () => {
    const state = createBlackoutState();
    state.onChange(() => {
      throw new Error('x');
    });
    expect(() => state.start()).not.toThrow();
  });

  it('a listener subscribed during dispatch only hears the NEXT change', () => {
    const state = createBlackoutState();
    const late = vi.fn();
    let subscribed = false;
    state.onChange(() => {
      if (!subscribed) {
        subscribed = true;
        state.onChange(late);
      }
    });
    state.start();
    expect(late).not.toHaveBeenCalled();
    state.end();
    expect(late).toHaveBeenCalledWith(false);
  });

  it('a listener unsubscribing during dispatch does not skip the next listener', () => {
    const state = createBlackoutState();
    const second = vi.fn();
    const off = state.onChange(() => off());
    state.onChange(second);
    state.start();
    expect(second).toHaveBeenCalledWith(true);
  });
});

describe('createBlackoutState — re-entrant toggles (L3)', () => {
  it('a subscriber that starts a blackout from the end notification never leaves a later subscriber on the stale state', () => {
    const state = createBlackoutState();
    const first: boolean[] = [];
    const second: boolean[] = [];
    let restart = true;
    state.onChange((active) => {
      first.push(active);
      if (!active && restart) {
        restart = false;
        state.start(); // e.g. a lifecycle listener on BlackoutEnded
      }
    });
    state.onChange((active) => second.push(active));
    state.start();
    first.length = 0;
    second.length = 0;
    state.end();
    expect(state.isActive()).toBe(true);
    // The second subscriber was already on `true` and the net change is nil: it is told nothing, and in
    // particular never the stale "false" of the outer round.
    expect(second).toEqual([]);
    // The first subscriber saw every transition in order.
    expect(first).toEqual([false, true]);
  });

  it('a subscriber that ends a blackout from the start notification ends in the inactive state everywhere', () => {
    const state = createBlackoutState();
    const second: boolean[] = [];
    state.onChange((active) => {
      if (active) state.end();
    });
    state.onChange((active) => second.push(active));
    state.start();
    expect(state.isActive()).toBe(false);
    expect(second).not.toContain(true);
  });

  it('every subscriber is told the same final state exactly once per net change', () => {
    const state = createBlackoutState();
    const seen: boolean[] = [];
    let once = true;
    state.onChange(() => {
      if (once) {
        once = false;
        state.end();
        state.start();
      }
    });
    state.onChange((active) => seen.push(active));
    state.start();
    expect(state.isActive()).toBe(true);
    expect(seen).toEqual([true]);
  });

  it('a listener that keeps toggling forever is cut off and reported, never hangs', () => {
    const onError = vi.fn();
    const state = createBlackoutState(onError);
    state.onChange(() => (state.isActive() ? state.end() : state.start()));
    state.start();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/toggl/i) }),
    );
  });

  it('a listener unsubscribed mid-dispatch is not called afterwards', () => {
    const state = createBlackoutState();
    const second = vi.fn();
    let offSecond: () => void = () => {};
    state.onChange(() => offSecond());
    offSecond = state.onChange(second);
    state.start();
    expect(second).not.toHaveBeenCalled();
  });

  it('can start in the active state without notifying anyone (carried across a relaunch)', () => {
    const state = createBlackoutState(undefined, true);
    expect(state.isActive()).toBe(true);
    const listener = vi.fn();
    state.onChange(listener);
    state.start();
    expect(listener).not.toHaveBeenCalled();
    state.end();
    expect(listener).toHaveBeenCalledWith(false);
  });
});
