import { describe, expect, it, vi } from 'vitest';
import {
  foreignListenerCount,
  type ListenerSource,
  markOwnHandler,
  printFatal,
} from './process-policy';

const procWith = (listeners: Record<string, unknown[]>): ListenerSource =>
  ({
    on: () => {},
    off: () => {},
    listeners: (event: string) => listeners[event] ?? [],
  }) as unknown as ListenerSource;

describe('markOwnHandler / foreignListenerCount', () => {
  it('does not count Bugsee’s own listeners as the host’s', () => {
    // Bugsee installs more than one listener for the same event (a reporting provider plus launch's
    // policy), so a raw listener count can never answer "does the host handle this too?".
    const ours = markOwnHandler(() => {});
    const alsoOurs = markOwnHandler(() => {});
    expect(
      foreignListenerCount(procWith({ uncaughtException: [ours, alsoOurs] }), 'uncaughtException'),
    ).toBe(0);
  });

  it('counts a host listener', () => {
    const ours = markOwnHandler(() => {});
    const host = (): void => {};
    expect(
      foreignListenerCount(procWith({ uncaughtException: [ours, host] }), 'uncaughtException'),
    ).toBe(1);
  });

  it('returns the handler it was given, so it can wrap an inline definition', () => {
    const fn = (): number => 1;
    expect(markOwnHandler(fn)).toBe(fn);
  });

  it('is scoped per event', () => {
    const host = (): void => {};
    const proc = procWith({ uncaughtException: [host], unhandledRejection: [] });
    expect(foreignListenerCount(proc, 'unhandledRejection')).toBe(0);
  });

  it('answers 0 when the runtime cannot enumerate listeners', () => {
    // The conservative answer: "no host handler", so the SDK reproduces Node's default disposition rather
    // than silently declining to act because it could not introspect an injected double.
    expect(foreignListenerCount({ on: () => {}, off: () => {} } as ListenerSource, 'x')).toBe(0);
  });

  it('ignores non-function entries', () => {
    expect(foreignListenerCount(procWith({ e: [null, 'nope'] }), 'e')).toBe(0);
  });
});

describe('printFatal', () => {
  it('prints the stack, which is the artifact operators reach for first', () => {
    const written: string[] = [];
    const error = new Error('boom');
    printFatal('[bugsee] uncaught:', error, (t) => written.push(t));
    expect(written[0]).toContain('boom');
    expect(written[0]).toContain('[bugsee] uncaught:');
    expect(written[0]).toContain('process-policy.test'); // the real stack, not just the message
  });

  it('falls back to name+message when an Error carries no stack', () => {
    const written: string[] = [];
    const error = new Error('no stack');
    error.stack = undefined;
    printFatal('x', error, (t) => written.push(t));
    expect(written[0]).toContain('Error: no stack');
  });

  it('stringifies a non-Error rejection reason', () => {
    const written: string[] = [];
    printFatal('x', { code: 42 }, (t) => written.push(t));
    expect(written[0]).toContain('[object Object]');
    printFatal('x', 'plain', (t) => written.push(t));
    expect(written[1]).toContain('plain');
  });

  it('ends with a newline so it does not run into the next log line', () => {
    const write = vi.fn();
    printFatal('x', 'y', write);
    expect((write.mock.calls[0]?.[0] as string).endsWith('\n')).toBe(true);
  });
});
