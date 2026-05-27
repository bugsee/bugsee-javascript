import { describe, expect, it } from 'vitest';
import { createOptionsContainer } from './options';

describe('createOptionsContainer', () => {
  it('get returns the configured value when the key is present', () => {
    const c = createOptionsContainer({ captureNetworkBodySizeLimit: 4096 });
    expect(c.get('captureNetworkBodySizeLimit', 20480)).toBe(4096);
  });

  it('get returns the fallback when the key is absent', () => {
    const c = createOptionsContainer({ a: 1 });
    expect(c.get('missing', 'default')).toBe('default');
  });

  it('get returns a stored value even when it is falsy (0 / false / "")', () => {
    const c = createOptionsContainer({ flag: false, count: 0, label: '' });
    expect(c.get('flag', true)).toBe(false);
    expect(c.get('count', 99)).toBe(0);
    expect(c.get('label', 'x')).toBe('');
  });

  it('get returns a present-but-undefined value rather than the fallback', () => {
    const c = createOptionsContainer({ maybe: undefined });
    expect(c.get('maybe', 'fallback')).toBeUndefined();
  });

  it('has reports presence (true for set keys including undefined, false otherwise)', () => {
    const c = createOptionsContainer({ set: 1, undef: undefined });
    expect(c.has('set')).toBe(true);
    expect(c.has('undef')).toBe(true);
    expect(c.has('missing')).toBe(false);
  });

  it('defaults to an empty bag (everything falls back, nothing present)', () => {
    const c = createOptionsContainer();
    expect(c.has('anything')).toBe(false);
    expect(c.get('anything', 42)).toBe(42);
  });

  it('treats only own keys as present (inherited prototype members are not options)', () => {
    const c = createOptionsContainer({});
    expect(c.has('toString')).toBe(false);
    expect(c.get('toString', 'fallback')).toBe('fallback');
  });
});
