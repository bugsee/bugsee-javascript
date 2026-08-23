import { describe, expect, it } from 'vitest';
import { bytesToMegabytes } from './units';

describe('bytesToMegabytes', () => {
  it('converts a byte count to whole binary megabytes', () => {
    // 16 GiB — the unit every Bugsee SDK puts on the wire for platform.memory_* (Android
    // EnvironmentInfoProvider divides by 1024/1024), and the unit the viewer renders as GB.
    expect(bytesToMegabytes(17_179_869_184)).toBe(16_384);
    expect(bytesToMegabytes(1024 * 1024)).toBe(1);
  });

  it('truncates a partial megabyte rather than rounding it up (Android `(int)` parity)', () => {
    expect(bytesToMegabytes(1024 * 1024 - 1)).toBe(0);
    expect(bytesToMegabytes(1024 * 1024 * 3 + 1024 * 1023)).toBe(3);
  });

  it('maps zero to zero', () => {
    expect(bytesToMegabytes(0)).toBe(0);
  });

  it('never emits a negative or non-finite value onto the wire', () => {
    // A probe that fails can hand back NaN (e.g. a subtraction against an unread value); shipping
    // NaN would serialize as null and render as a blank row, and a negative RAM figure is nonsense.
    expect(bytesToMegabytes(Number.NaN)).toBe(0);
    expect(bytesToMegabytes(Number.POSITIVE_INFINITY)).toBe(0);
    expect(bytesToMegabytes(-1)).toBe(0);
  });
});
