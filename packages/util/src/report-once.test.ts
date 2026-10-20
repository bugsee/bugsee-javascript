import { describe, expect, it, vi } from 'vitest';
import { reportOncePerMessage } from './report-once';

describe('reportOncePerMessage (a repeating failure reaches the host sink once, not once per call)', () => {
  it('forwards the first occurrence and drops repeats of the same error text', () => {
    const sink = vi.fn();
    const report = reportOncePerMessage(sink);
    report(new Error('boom'));
    report(new Error('boom'));
    report(new Error('boom'));
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('forwards a different message, and distinguishes error types with the same text', () => {
    const sink = vi.fn();
    const report = reportOncePerMessage(sink);
    report(new Error('a'));
    report(new Error('b'));
    report(new TypeError('a'));
    expect(sink.mock.calls.map((c) => String((c[0] as Error).message))).toEqual(['a', 'b', 'a']);
  });

  it('keys non-Error values by their text', () => {
    const sink = vi.fn();
    const report = reportOncePerMessage(sink);
    report('oops');
    report('oops');
    report(42);
    report(42);
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it('remembers a bounded number of distinct messages (memory stays bounded) and then stops reporting NEW ones too', () => {
    const sink = vi.fn();
    const report = reportOncePerMessage(sink);
    for (let i = 0; i < 100; i++) report(new Error(`e${i}`));
    expect(sink).toHaveBeenCalledTimes(32);
  });

  it('without a sink it is a harmless no-op, and a throwing sink never escapes', () => {
    expect(() => reportOncePerMessage(undefined)(new Error('x'))).not.toThrow();
    const throwing = vi.fn(() => {
      throw new Error('sink');
    });
    expect(() => reportOncePerMessage(throwing)(new Error('x'))).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it('a value whose text cannot be read is still reported once', () => {
    const sink = vi.fn();
    const report = reportOncePerMessage(sink);
    const hostile = {
      toString() {
        throw new Error('no text');
      },
    };
    report(hostile);
    report(hostile);
    expect(sink).toHaveBeenCalledTimes(1);
  });
});
