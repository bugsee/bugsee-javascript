import type { LogEvent } from '@bugsee/core';
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

describe('createConsoleInterceptor — a hostile argument must not reach the app', () => {
  // BINDING: an interceptor must never alter application behavior. The capture block ran under
  // `try/finally` with no `catch`, so anything thrown while formatting escaped into the application's own
  // `console.log(...)` call AND skipped the passthrough below it — the app both crashed where it
  // previously did not, and lost the line it was trying to print.
  //
  // Not a theoretical input: a getter that throws is what ORM row proxies, MobX/Vue reactive objects read
  // outside their scope, and detached DOM nodes all do.
  // `degrades` = the value is unserializable in EVERY environment, so the captured message must show the
  // placeholder. Deep nesting is deliberately not in that set: whether `JSON.stringify` overflows depends
  // on the stack the host happens to give it, and it did not overflow under the mutation-test runner even
  // though it does under vitest. Asserting the placeholder for it made the test environment-dependent.
  // What holds everywhere — and is the property that matters — is that nothing escapes and the app's own
  // call still goes through.
  const hostileValues: ReadonlyArray<[string, unknown, boolean]> = [
    [
      'a getter that throws',
      {
        get boom(): string {
          throw new Error('getter exploded');
        },
      },
      true,
    ],
    [
      'a toJSON that throws',
      {
        toJSON(): never {
          throw new Error('toJSON exploded');
        },
      },
      true,
    ],
    [
      'a Proxy whose traps throw',
      new Proxy(
        {},
        {
          ownKeys(): never {
            throw new Error('trap exploded');
          },
        },
      ),
      true,
    ],
    [
      'an object nested past the stringify recursion limit',
      (() => {
        let node: Record<string, unknown> = {};
        const root = node;
        for (let i = 0; i < 20000; i++) {
          const next: Record<string, unknown> = {};
          node.n = next;
          node = next;
        }
        return root;
      })(),
      false,
    ],
  ];

  for (const [label, value, degrades] of hostileValues) {
    it(`does not throw into the caller, and still forwards, for ${label}`, () => {
      const f = fake();
      const ic = createConsoleInterceptor({ now: () => 1 });
      const logs: LogEvent[] = [];
      ic.on('log', (e) => logs.push(e));

      expect(() => con().log(value)).not.toThrow();
      // The passthrough is the half a bare `finally` silently skipped: the app's own output.
      expect(f.calls).toEqual([{ method: 'log', args: [value] }]);
      // And capture still happened, rather than being dropped entirely.
      expect(logs).toHaveLength(1);
      if (degrades) {
        expect(logs[0]?.message).toContain('[Unserializable]');
      }
    });
  }

  it('survives an injected formatter that throws', () => {
    // `format` is a public option — the whole point of the seam is that a platform swaps in its own
    // (node passes `util.format`). A formatter is arbitrary code, so it can throw, and when it did the
    // exception escaped into the application's `console.log` and the passthrough never ran. Making the
    // default stringifier total fixed the common cause; it cannot fix an injected one.
    const f = fake();
    const ic = createConsoleInterceptor({
      now: () => 1,
      format: () => {
        throw new Error('formatter exploded');
      },
    });
    const logs: LogEvent[] = [];
    ic.on('log', (e) => logs.push(e));

    expect(() => con().log('hi')).not.toThrow();
    expect(f.calls).toEqual([{ method: 'log', args: ['hi'] }]);
    // Capture is lost for this line — there is no message to record — but the application is untouched,
    // which is the trade this guard exists to make.
    expect(logs).toHaveLength(0);

    // And the guard is not left set: the next line is captured normally.
    con().log('after');
    expect(f.calls).toHaveLength(2);
  });

  it('keeps forwarding after a hostile argument — the patch is not left wedged', () => {
    const f = fake();
    const ic = createConsoleInterceptor({ now: () => 1 });
    const logs: LogEvent[] = [];
    ic.on('log', (e) => logs.push(e));

    con().log({
      get boom(): string {
        throw new Error('getter exploded');
      },
    });
    con().log('after');

    // The re-entrancy guard is cleared in `finally`, so a throw must not strand it — otherwise every
    // later log in the process is silently dropped from capture.
    expect(f.calls).toHaveLength(2);
    expect(logs).toHaveLength(2);
    expect(logs[1]?.message).toBe('after');
  });
});

describe('createConsoleInterceptor — capture (fires the "log" stage)', () => {
  it('fires a LogEvent (mapped level, source "console", formatted message, clock timestamp)', () => {
    fake();
    const ic = createConsoleInterceptor({ now: () => 123 });
    const logs: LogEvent[] = [];
    ic.on('log', (e) => logs.push(e)); // subscribing activates + patches console
    con().error('boom', { a: 1 });
    expect(logs).toEqual([
      { timestamp: 123, level: 'error', source: 'console', message: 'boom {"a":1}' },
    ]);
  });

  it('maps each console method to its default level', () => {
    fake();
    const ic = createConsoleInterceptor({ now: () => 1 });
    const logs: LogEvent[] = [];
    ic.on('log', (e) => logs.push(e));
    con().log('a');
    con().info('b');
    con().debug('c');
    con().warn('d');
    con().error('e');
    expect(logs.map((l) => l.level)).toEqual(['info', 'info', 'debug', 'warning', 'error']);
  });

  it('passes the call through to the original console (app behavior preserved)', () => {
    const { calls } = fake();
    const ic = createConsoleInterceptor();
    ic.on('log', () => {});
    con().warn('hi', 1);
    expect(calls).toEqual([{ method: 'warn', args: ['hi', 1] }]);
  });

  it('honors an injected formatter', () => {
    fake();
    const format: ConsoleInterceptorOptions['format'] = (args) => `<${args.length}>`;
    const ic = createConsoleInterceptor({ now: () => 1, format });
    const logs: LogEvent[] = [];
    ic.on('log', (e) => logs.push(e));
    con().log('a', 'b', 'c');
    expect(logs[0]?.message).toBe('<3>');
  });

  it('honors injected level mappings (and only patches the listed methods)', () => {
    const { calls } = fake();
    const ic = createConsoleInterceptor({ now: () => 1, levels: { error: 'verbose' } });
    const logs: LogEvent[] = [];
    ic.on('log', (e) => logs.push(e));
    con().error('x');
    con().log('y'); // not in the custom levels → not captured, but still works
    expect(logs).toEqual([{ timestamp: 1, level: 'verbose', source: 'console', message: 'x' }]);
    expect(calls).toContainEqual({ method: 'log', args: ['y'] });
  });

  it('skips a configured method that is absent from the runtime console', () => {
    fake(); // fake console has no "trace"
    const ic = createConsoleInterceptor({ now: () => 1, levels: { trace: 'debug' } });
    const logs: LogEvent[] = [];
    expect(() => ic.on('log', (e) => logs.push(e))).not.toThrow();
    expect((con() as unknown as Record<string, unknown>).trace).toBeUndefined(); // not patched in
    expect(logs).toEqual([]);
  });

  it('does not re-emit when a log subscriber itself logs (re-entrancy guard)', () => {
    fake();
    const ic = createConsoleInterceptor({ now: () => 1 });
    const seen: LogEvent[] = [];
    ic.on('log', (e) => {
      seen.push(e);
      con().log('from inside a subscriber'); // would recurse without the guard
    });
    con().error('outer');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toBe('outer');
  });
});

describe('createConsoleInterceptor — activation', () => {
  it('patches console on the first subscriber and restores it on the last unsubscribe', () => {
    const { calls } = fake();
    const ic = createConsoleInterceptor({ now: () => 1 });
    const logs: LogEvent[] = [];
    const originalLog = con().log;
    const off = ic.on('log', (e) => logs.push(e));
    expect(con().log).not.toBe(originalLog); // patched (wrapper installed)
    con().log('active');
    expect(logs).toHaveLength(1); // captured while active
    off(); // last subscriber gone → deactivate → restore console
    expect(con().log).toBe(originalLog); // the original method is restored, not left wrapped
    con().log('after');
    expect(logs).toHaveLength(1); // not captured after restore
    expect(calls).toEqual([
      { method: 'log', args: ['active'] },
      { method: 'log', args: ['after'] },
    ]); // both passed through to the original
  });

  it('explicit start() activates without a subscriber; a later subscriber receives events', () => {
    fake();
    const ic = createConsoleInterceptor({ now: () => 5 });
    ic.start(); // active + patched, no subscriber yet
    con().warn('early'); // emitted to nobody (fine)
    const logs: LogEvent[] = [];
    ic.on('log', (e) => logs.push(e));
    con().warn('later');
    expect(logs).toEqual([{ timestamp: 5, level: 'warning', source: 'console', message: 'later' }]);
    ic.stop();
  });
});

describe('createConsoleInterceptor — no console in the runtime', () => {
  it('activation is a safe no-op when globalThis has no console', () => {
    const slot = globalThis as unknown as { console?: unknown };
    const real = slot.console;
    slot.console = undefined;
    try {
      const ic = createConsoleInterceptor();
      const logs: LogEvent[] = [];
      expect(() => {
        const off = ic.on('log', (e) => logs.push(e)); // activate (no console to patch)
        ic.start();
        ic.stop();
        off(); // last subscriber gone → deactivate with no console to restore
      }).not.toThrow();
      expect(logs).toEqual([]);
    } finally {
      slot.console = real;
    }
  });
});
