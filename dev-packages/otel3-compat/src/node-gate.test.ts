import { describe, expect, it } from 'vitest';
import {
  nodeAtLeast,
  OTEL3_MIN_NODE,
  otel3Required,
  otel3Supported,
  skipIsForbidden,
} from './node-gate';

describe('nodeAtLeast', () => {
  it.each([
    ['22.15.0', true],
    ['22.15.1', true],
    ['22.16.0', true],
    ['23.0.0', true],
    ['24.15.0', true],
    ['22.14.9', false],
    ['22.12.0', false],
    ['20.19.0', false],
    ['18.20.4', false],
  ])('%s -> %s against the OTel 3 floor', (version, expected) => {
    expect(nodeAtLeast(version)).toBe(expected);
  });

  it('treats missing trailing parts as zero and honours a custom floor', () => {
    expect(nodeAtLeast('22.15')).toBe(true);
    expect(nodeAtLeast('22')).toBe(false);
    expect(nodeAtLeast('20.6.0', [20, 6, 0])).toBe(true);
    expect(nodeAtLeast('20.5.9', [20, 6, 0])).toBe(false);
  });

  it('pins the floor to what sdk-trace@3 declares', () => {
    expect(OTEL3_MIN_NODE).toEqual([22, 15, 0]);
  });

  it('agrees with the running Node', () => {
    expect(otel3Supported).toBe(nodeAtLeast(process.versions.node));
  });
});

describe('skipIsForbidden (BUGSEE_REQUIRE_OTEL3)', () => {
  it('is on only for the exact value "1"', () => {
    expect(skipIsForbidden({ BUGSEE_REQUIRE_OTEL3: '1' })).toBe(true);
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) {
      expect(skipIsForbidden({ BUGSEE_REQUIRE_OTEL3: v })).toBe(false);
    }
    expect(skipIsForbidden({})).toBe(false);
  });

  it('reads the real environment for the exported flag', () => {
    expect(otel3Required).toBe(skipIsForbidden(process.env));
  });
});
