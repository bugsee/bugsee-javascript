import { type Client, createEventHubs, type LogEvent } from '@bugsee/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ConsoleInterceptorOptions,
  createConsoleInterceptor,
  formatConsoleArgs,
} from './console-interceptor';

const CONSOLE_METHODS = ['log', 'info', 'debug', 'warn', 'error'] as const;
type RecordedCall = { method: string; args: unknown[] };

// Swap globalThis.console for a recording fake while a test runs, so the interceptor patches the fake
// (not the test runner's console). Returns the recorded passthrough calls; restores the real console.
function installFakeConsole() {
  const calls: RecordedCall[] = [];
  const real = (globalThis as unknown as { console: unknown }).console;
  const fake: Record<string, (...args: unknown[]) => void> = {};
  for (const method of CONSOLE_METHODS) {
    fake[method] = (...args: unknown[]) => calls.push({ method, args });
  }
  (globalThis as unknown as { console: unknown }).console = fake;
  return { calls, restore: () => ((globalThis as unknown as { console: unknown }).console = real) };
}

// Read globalThis.console (the fake during a test) so we exercise the wrapper the interceptor installed.
type FakeConsole = Record<(typeof CONSOLE_METHODS)[number], (...a: unknown[]) => void>;
const con = () => (globalThis as unknown as { console: FakeConsole }).console;

// A minimal client: the interceptor only touches client.hubs.log.
function fakeClient() {
  const hubs = createEventHubs();
  const emitted: LogEvent[] = [];
  hubs.log.subscribe((e) => emitted.push(e));
  return { client: { hubs } as unknown as Client, emitted, hubs };
}

const restores: Array<() => void> = [];
const fake = () => {
  const f = installFakeConsole();
  restores.push(f.restore);
  return f;
};
afterEach(() => {
  while (restores.length > 0) {
    restores.pop()?.();
  }
});

describe('formatConsoleArgs (portable default formatter)', () => {
  it('passes strings through and joins multiple args with a space', () => {
    expect(formatConsoleArgs(['hello', 'world'])).toBe('hello world');
  });

  it('stringifies plain objects and arrays as JSON', () => {
    expect(formatConsoleArgs([{ a: 1 }])).toBe('{"a":1}');
    expect(formatConsoleArgs([[1, 2]])).toBe('[1,2]');
  });

  it("renders an Error as its stack (falling back to name: message when there's no stack)", () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n  at x';
    expect(formatConsoleArgs([err])).toBe('Error: boom\n  at x');
    const noStack = new TypeError('bad');
    noStack.stack = undefined;
    expect(formatConsoleArgs([noStack])).toBe('TypeError: bad');
  });

  it('stringifies primitives (number/boolean/null/undefined) via String', () => {
    expect(formatConsoleArgs([1, true, null, undefined])).toBe('1 true null undefined');
  });

  it('is non-throwing on circular objects (json-safe)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatConsoleArgs([circular])).toBe('{"self":"[Circular]"}');
  });

  it('returns an empty string for no args', () => {
    expect(formatConsoleArgs([])).toBe('');
  });
});

describe('createConsoleInterceptor — capture', () => {
  it('emits a LogEvent (mapped level, source "console", formatted message, clock timestamp)', () => {
    fake();
    const { client, emitted } = fakeClient();
    const ic = createConsoleInterceptor({ now: () => 123 });
    ic.start(client);
    con().error('boom', { a: 1 });
    expect(emitted).toEqual([
      { timestamp: 123, level: 'error', source: 'console', message: 'boom {"a":1}' },
    ]);
  });

  it('maps each console method to its default level', () => {
    fake();
    const { client, emitted } = fakeClient();
    createConsoleInterceptor({ now: () => 1 }).start(client);
    con().log('a');
    con().info('b');
    con().debug('c');
    con().warn('d');
    con().error('e');
    expect(emitted.map((e) => e.level)).toEqual(['info', 'info', 'debug', 'warning', 'error']);
  });

  it('passes the call through to the original console (app behavior preserved)', () => {
    const { calls } = fake();
    const { client } = fakeClient();
    createConsoleInterceptor().start(client);
    con().warn('hi', 1);
    expect(calls).toEqual([{ method: 'warn', args: ['hi', 1] }]);
  });

  it('honors an injected formatter', () => {
    fake();
    const { client, emitted } = fakeClient();
    const format: ConsoleInterceptorOptions['format'] = (args) => `<${args.length}>`;
    createConsoleInterceptor({ now: () => 1, format }).start(client);
    con().log('a', 'b', 'c');
    expect(emitted[0]?.message).toBe('<3>');
  });

  it('honors injected level mappings (and only patches the listed methods)', () => {
    const { calls } = fake();
    const { client, emitted } = fakeClient();
    createConsoleInterceptor({ now: () => 1, levels: { error: 'verbose' } }).start(client);
    con().error('x');
    con().log('y'); // not in the custom levels → not captured, but still works
    expect(emitted).toEqual([{ timestamp: 1, level: 'verbose', source: 'console', message: 'x' }]);
    expect(calls).toContainEqual({ method: 'log', args: ['y'] });
  });

  it('skips a configured method that is absent from the runtime console', () => {
    fake(); // fake console has no "trace"
    const { client, emitted } = fakeClient();
    const ic = createConsoleInterceptor({ now: () => 1, levels: { trace: 'debug' } });
    expect(() => ic.start(client)).not.toThrow();
    expect((con() as unknown as Record<string, unknown>).trace).toBeUndefined(); // not patched in
    expect(emitted).toEqual([]);
  });

  it('fires the "log" stage hook with the captured LogEvent (listenable interceptor)', () => {
    fake();
    const { client } = fakeClient();
    const ic = createConsoleInterceptor({ now: () => 7 });
    const seen: LogEvent[] = [];
    ic.on('log', (e) => seen.push(e));
    ic.start(client);
    con().warn('hi', 1);
    expect(seen).toEqual([{ timestamp: 7, level: 'warning', source: 'console', message: 'hi 1' }]);
  });

  it('does not re-emit when a log subscriber itself logs (re-entrancy guard)', () => {
    fake();
    const { client, hubs } = fakeClient();
    const seen: LogEvent[] = [];
    hubs.log.subscribe((e) => {
      seen.push(e);
      con().log('from inside a subscriber'); // would recurse without the guard
    });
    createConsoleInterceptor({ now: () => 1 }).start(client);
    con().error('outer');
    expect(seen).toHaveLength(1); // exactly one emit; the nested log did not re-enter
    expect(seen[0]?.message).toBe('outer');
  });
});

describe('createConsoleInterceptor — stop', () => {
  it('restores the originals (after stop, calls are not captured but still pass through)', () => {
    const { calls } = fake();
    const { client, emitted } = fakeClient();
    const ic = createConsoleInterceptor({ now: () => 1 });
    ic.start(client);
    ic.stop();
    con().log('after');
    expect(emitted).toEqual([]); // nothing captured post-stop
    expect(calls).toContainEqual({ method: 'log', args: ['after'] }); // original restored
  });
});

describe('createConsoleInterceptor — no console in the runtime', () => {
  it('start and stop are safe no-ops when globalThis has no console', () => {
    const slot = globalThis as unknown as { console?: unknown };
    const real = slot.console;
    slot.console = undefined;
    try {
      const { client, emitted } = fakeClient();
      const ic = createConsoleInterceptor();
      expect(() => {
        ic.start(client);
        ic.stop();
      }).not.toThrow();
      expect(emitted).toEqual([]);
    } finally {
      slot.console = real;
    }
  });
});
