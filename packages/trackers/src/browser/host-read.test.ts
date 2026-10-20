import { describe, expect, it } from 'vitest';
import { hostRead } from './host-read';

describe('hostRead', () => {
  it('returns the read value', () => {
    expect(hostRead(() => 5)).toBe(5);
  });
  it('returns undefined and reports when the read throws', () => {
    const errors: unknown[] = [];
    expect(
      hostRead(
        () => {
          throw new Error('boom');
        },
        (e) => errors.push(e),
      ),
    ).toBeUndefined();
    expect((errors[0] as Error).message).toBe('boom');
  });
  it('swallows a throwing reporter and works without one', () => {
    const boom = (): never => {
      throw new Error('boom');
    };
    expect(
      hostRead(boom, () => {
        throw new Error('reporter');
      }),
    ).toBeUndefined();
    expect(hostRead(boom)).toBeUndefined();
  });
});
