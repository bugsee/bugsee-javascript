import { describe, expect, it, vi } from 'vitest';
import { reportGuarded } from './report-guarded';

describe('reportGuarded (tell the host sink about an option problem without ever breaking launch)', () => {
  it('delivers the error to the sink', () => {
    const sink = vi.fn();
    const error = new Error('bad option');
    reportGuarded(sink, error);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(error);
  });

  it('does nothing without a sink', () => {
    expect(() => reportGuarded(undefined, new Error('x'))).not.toThrow();
  });

  it('swallows a sink that throws (a warning must not make launch() throw)', () => {
    const sink = vi.fn(() => {
      throw new Error('sink is rethrowing');
    });
    expect(() => reportGuarded(sink, new Error('x'))).not.toThrow();
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('a sink that returns a rejected promise has the rejection absorbed (no unhandled rejection)', async () => {
    const rejected = Promise.reject(new Error('async sink failed'));
    const absorb = vi.spyOn(rejected, 'catch');
    reportGuarded(() => rejected, new Error('x'));
    expect(absorb).toHaveBeenCalledTimes(1);
    await expect(
      rejected.then(
        () => 'resolved',
        () => 'rejected',
      ),
    ).resolves.toBe('rejected');
  });
});
