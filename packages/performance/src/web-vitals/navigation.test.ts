import { describe, expect, it } from 'vitest';
import type { WebVitalsEnv } from './env';
import {
  getActivationStart,
  getNavigationEntry,
  getNavigationType,
  type NavigationTimingLike,
} from './navigation';

const navEnv = (
  navEntry?: Partial<NavigationTimingLike>,
  doc?: { prerendering?: boolean; wasDiscarded?: boolean },
): WebVitalsEnv => ({
  performance: {
    now: () => 1000,
    getEntriesByType: (type) =>
      type === 'navigation' && navEntry
        ? [{ name: '', entryType: 'navigation', startTime: 0, duration: 0, ...navEntry }]
        : [],
  },
  ...(doc !== undefined ? { document: doc as never } : {}),
});

describe('getNavigationEntry', () => {
  it('returns the first navigation timing entry', () => {
    const entry = getNavigationEntry(navEnv({ type: 'navigate', responseStart: 120 }));
    expect(entry).toMatchObject({ entryType: 'navigation', type: 'navigate', responseStart: 120 });
  });

  it('returns undefined when there is no navigation entry or no performance API', () => {
    expect(getNavigationEntry(navEnv())).toBeUndefined();
    expect(getNavigationEntry({})).toBeUndefined();
  });
});

describe('getActivationStart', () => {
  it('returns the entry activationStart, or 0 when absent', () => {
    expect(getActivationStart(navEnv({ activationStart: 50 }))).toBe(50);
    expect(getActivationStart(navEnv({ type: 'navigate' }))).toBe(0); // no activationStart field
    expect(getActivationStart(navEnv())).toBe(0); // no entry
  });
});

describe('getNavigationType', () => {
  it('is prerender when the document is prerendering or activationStart > 0', () => {
    expect(getNavigationType(navEnv({ type: 'navigate' }, { prerendering: true }))).toBe(
      'prerender',
    );
    expect(getNavigationType(navEnv({ type: 'navigate', activationStart: 5 }))).toBe('prerender');
  });

  it('is restore when the document was discarded', () => {
    expect(getNavigationType(navEnv({ type: 'navigate' }, { wasDiscarded: true }))).toBe('restore');
  });

  it('maps the entry type (underscores → hyphens): back_forward → back-forward, reload, navigate', () => {
    expect(getNavigationType(navEnv({ type: 'back_forward' }))).toBe('back-forward');
    expect(getNavigationType(navEnv({ type: 'reload' }))).toBe('reload');
    expect(getNavigationType(navEnv({ type: 'navigate' }))).toBe('navigate');
  });

  it('defaults to navigate when there is no navigation entry', () => {
    expect(getNavigationType(navEnv())).toBe('navigate');
  });
});
