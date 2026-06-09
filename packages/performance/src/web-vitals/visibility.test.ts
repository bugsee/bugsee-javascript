import { describe, expect, it } from 'vitest';
import type { WebVitalsEnv } from './env';
import { createVisibilityWatcher } from './visibility';

// A document+window fake with a mutable visibility state + a settable clock.
function fakeEnv(initialVisibility = 'visible') {
  const listeners = new Map<string, Set<() => void>>();
  const state = { visibility: initialVisibility, now: 0 };
  const add = (type: string, l: () => void) =>
    (listeners.get(type) ?? listeners.set(type, new Set()).get(type))?.add(l);
  const env: WebVitalsEnv = {
    performance: { now: () => state.now, getEntriesByType: () => [] },
    document: {
      addEventListener: (type: string, l: () => void) => add(type, l),
      get visibilityState() {
        return state.visibility;
      },
    } as never,
    window: { addEventListener: (type: string, l: () => void) => add(type, l) } as never,
  };
  const emit = (type: string) => {
    for (const l of listeners.get(type) ?? []) l();
  };
  return { env, state, emit };
}

describe('createVisibilityWatcher', () => {
  it('starts at Infinity when the page is visible', () => {
    expect(createVisibilityWatcher(fakeEnv('visible').env).firstHiddenTime).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('starts at 0 when the page is already hidden', () => {
    expect(createVisibilityWatcher(fakeEnv('hidden').env).firstHiddenTime).toBe(0);
  });

  it('records the clock at the FIRST hidden transition and never moves later', () => {
    const { env, state, emit } = fakeEnv('visible');
    const watcher = createVisibilityWatcher(env);
    state.now = 100;
    state.visibility = 'visible';
    emit('visibilitychange'); // still visible → no change
    expect(watcher.firstHiddenTime).toBe(Number.POSITIVE_INFINITY);
    state.now = 250;
    state.visibility = 'hidden';
    emit('visibilitychange'); // first hidden → 250
    expect(watcher.firstHiddenTime).toBe(250);
    state.now = 900;
    emit('visibilitychange'); // a later hidden → keeps the earliest (min)
    expect(watcher.firstHiddenTime).toBe(250);
  });

  it('treats pagehide as becoming hidden', () => {
    const { env, state, emit } = fakeEnv('visible');
    const watcher = createVisibilityWatcher(env);
    state.now = 42;
    emit('pagehide');
    expect(watcher.firstHiddenTime).toBe(42);
  });

  it('does not throw without document/window', () => {
    expect(() => createVisibilityWatcher({}).firstHiddenTime).not.toThrow();
  });

  it('falls back to 0 as the hidden time when there is no performance clock', () => {
    let pagehide: (() => void) | undefined;
    const env: WebVitalsEnv = {
      window: { addEventListener: (_type: string, l: () => void) => (pagehide = l) } as never,
    };
    const watcher = createVisibilityWatcher(env);
    pagehide?.();
    expect(watcher.firstHiddenTime).toBe(0);
  });
});
