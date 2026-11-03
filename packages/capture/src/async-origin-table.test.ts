import { describe, expect, it } from 'vitest';
import {
  ASYNC_ORIGIN_EXTRAS,
  ASYNC_ORIGIN_TABLE,
  type AsyncOriginRow,
  rowTargets,
} from './async-origin-table';

describe('rowTargets', () => {
  it('is the interface itself unless the row names concrete targets', () => {
    expect(rowTargets({ iface: 'Clipboard', methods: ['read'], mode: 'always', why: 'x' })).toEqual(
      ['Clipboard'],
    );
    expect(
      rowTargets({
        iface: 'Body',
        methods: ['json'],
        mode: 'off',
        targets: ['Request', 'Response'],
        why: 'x',
      }),
    ).toEqual(['Request', 'Response']);
  });
});

describe('the async-origin table', () => {
  const all: readonly AsyncOriginRow[] = [...ASYNC_ORIGIN_TABLE, ...ASYNC_ORIGIN_EXTRAS];

  it('has a mode, a reason and at least one method on every row', () => {
    for (const row of all) {
      expect(['always', 'armed', 'off']).toContain(row.mode);
      expect(row.why.length).toBeGreaterThan(0);
      expect(row.methods.length).toBeGreaterThan(0);
    }
  });

  it('classifies a (target, method) pair once, so a method has exactly one mode', () => {
    const seen = new Map<string, string>();
    for (const row of all) {
      for (const target of rowTargets(row)) {
        for (const method of row.methods) {
          const key = `${target}.${method}`;
          expect(seen.has(key), `${key} is classified twice`).toBe(false);
          seen.set(key, row.mode);
        }
      }
    }
  });

  it('keeps the measured BGSVIEWER-14 method in the always-on set and fetch out of the default set', () => {
    const mode = (iface: string, method: string): string | undefined =>
      all.find((row) => row.iface === iface && row.methods.includes(method))?.mode;
    expect(mode('HTMLMediaElement', 'play')).toBe('always');
    expect(mode('WindowOrWorkerGlobalScope', 'fetch')).toBe('off');
    expect(mode('SubtleCrypto', 'digest')).toBe('off');
  });
});
