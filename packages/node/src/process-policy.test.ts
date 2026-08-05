import { describe, expect, it, vi } from 'vitest';
import {
  foreignListenerCount,
  type ListenerSource,
  markOwnHandler,
  nodeTerminatesOnRejection,
  printFatal,
  releaseSignalToDefault,
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

describe('nodeTerminatesOnRejection', () => {
  // `preserve` reproduces NODE's outcome, so it must read what that outcome is. A host running
  // `--unhandled-rejections=warn` keeps its process alive (verified against real node: exit 0), and
  // `preserve` was calling process.exit(1) anyway -- killing a process Node would have kept running, which
  // is the exact inversion of the bug `preserve` exists to prevent.
  it.each([
    ['unset', {}, true],
    ['throw', { execArgv: ['--unhandled-rejections=throw'] }, true],
    ['strict', { execArgv: ['--unhandled-rejections=strict'] }, true],
    ['warn', { execArgv: ['--unhandled-rejections=warn'] }, false],
    ['none', { execArgv: ['--unhandled-rejections=none'] }, false],
    ['warn-with-error-code', { execArgv: ['--unhandled-rejections=warn-with-error-code'] }, false],
    ['an unknown value', { execArgv: ['--unhandled-rejections=bogus'] }, true],
  ])('reads the mode from execArgv: %s', (_label, source, expected) => {
    expect(nodeTerminatesOnRejection(source)).toBe(expected);
  });

  it('reads the mode from NODE_OPTIONS too, which execArgv does NOT reflect', () => {
    // Verified against real node: `NODE_OPTIONS=--unhandled-rejections=warn` lands in process.env only.
    expect(
      nodeTerminatesOnRejection({ env: { NODE_OPTIONS: '--unhandled-rejections=warn' } }),
    ).toBe(false);
    expect(
      nodeTerminatesOnRejection({
        env: { NODE_OPTIONS: '--max-old-space-size=4096 --unhandled-rejections=none' },
      }),
    ).toBe(false);
    expect(nodeTerminatesOnRejection({ env: { NODE_OPTIONS: '--enable-source-maps' } })).toBe(true);
    expect(nodeTerminatesOnRejection({ env: {} })).toBe(true);
  });

  it('lets the LAST occurrence win, as node does', () => {
    expect(
      nodeTerminatesOnRejection({
        execArgv: ['--unhandled-rejections=warn', '--unhandled-rejections=throw'],
      }),
    ).toBe(true);
    expect(
      nodeTerminatesOnRejection({
        execArgv: ['--unhandled-rejections=throw'],
        env: { NODE_OPTIONS: '--unhandled-rejections=warn' },
      }),
    ).toBe(false);
  });
});

describe('releaseSignalToDefault', () => {
  const withListeners = (over: Record<string, unknown> = {}) => {
    const off = vi.fn();
    const kill = vi.fn();
    return { off, kill, listeners: () => [], pid: 99, ...over };
  };

  it('re-raises with the process own pid when no listener remains', () => {
    const proc = withListeners();
    expect(releaseSignalToDefault(proc, 'SIGTERM', () => {})).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith(99, 'SIGTERM');
  });

  it('removes the handler before re-raising, so the re-raise cannot re-enter it', () => {
    const handler = () => {};
    const proc = withListeners();
    releaseSignalToDefault(proc, 'SIGTERM', handler);
    expect(proc.off).toHaveBeenCalledWith('SIGTERM', handler);
  });

  it('stands down when ANY listener remains — the host owns the shutdown', () => {
    const proc = withListeners({ listeners: () => [() => {}] });
    expect(releaseSignalToDefault(proc, 'SIGTERM', () => {})).toBe(false);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('stands down when the process cannot enumerate listeners at all', () => {
    // An injected double or a non-Node process-like. Re-raising blind could kill a process whose host
    // handler we simply cannot see, so "unknown" has to mean "do nothing".
    const proc = withListeners({ listeners: undefined });
    expect(releaseSignalToDefault(proc, 'SIGTERM', () => {})).toBe(false);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('never guesses a pid — a process-like without one is left alone', () => {
    // `kill(0, sig)` signals the entire PROCESS GROUP on POSIX. Defaulting the pid would turn a missing
    // field into a signal delivered to every sibling process in the group.
    const proc = withListeners({ pid: undefined });
    expect(releaseSignalToDefault(proc, 'SIGTERM', () => {})).toBe(false);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('tolerates a process-like with no kill at all', () => {
    const proc = withListeners({ kill: undefined });
    expect(releaseSignalToDefault(proc, 'SIGTERM', () => {})).toBe(false);
  });

  it('tolerates a process-like with no off at all', () => {
    const proc = withListeners({ off: undefined });
    expect(() => releaseSignalToDefault(proc, 'SIGTERM', () => {})).not.toThrow();
  });
});
