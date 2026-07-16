import { describe, expect, it } from 'vitest';
import { buildCrashJson } from './crash';
import { parseV8Stack, type StackFrame } from './stack';

function errorWith(name: string, message: string, stack: string | undefined): Error {
  const e = new Error(message);
  e.name = name;
  e.stack = stack;
  return e;
}

describe('buildCrashJson', () => {
  it('builds the Android-parity container from an Error (name/reason/structured frames)', () => {
    const err = errorWith(
      'TypeError',
      'Cannot read x',
      'TypeError: Cannot read x\n    at handleClick (app.min.js:1:2345)\n    at onClick (app.min.js:1:1200)',
    );
    const crash = buildCrashJson(err, { parseStack: parseV8Stack, handled: true });
    expect(crash).toBeDefined();
    expect(crash?.exception_type).toBe('error');
    expect(crash?.ndkCrash).toBe(false);
    expect(crash?.handled).toBe(true);
    expect(crash?.exception.name).toBe('TypeError');
    expect(crash?.exception.reason).toBe('Cannot read x');
    expect(crash?.exception.frames).toHaveLength(2);
    const f0 = crash?.exception.frames[0];
    expect(f0?.trace).toBe('at handleClick (app.min.js:1:2345)'); // no debugId suffix — it's a separate field
    expect(f0?.user).toBe(true);
    expect(f0?.data).toEqual({
      source: 'app.min.js',
      member: 'handleClick',
      line: 1,
      column: 2345,
    });
    expect(f0?.debug_id).toBeUndefined(); // no build injected one
  });

  it('stamps per-frame debug_id from the registration global', () => {
    const registrationStack = 'Error\n    at app.min.js:1:1'; // top frame file = app.min.js
    const globalObject = { _bugseeDebugIds: { [registrationStack]: 'dbg-uuid' } };
    const err = errorWith('Error', 'boom', 'Error: boom\n    at handleClick (app.min.js:1:2345)');
    const crash = buildCrashJson(err, { parseStack: parseV8Stack, globalObject });
    expect(crash?.exception.frames[0]?.debug_id).toBe('dbg-uuid');
  });

  it('recurses the cause chain', () => {
    const inner = errorWith('RangeError', 'inner', 'RangeError: inner\n    at f (a.js:2:2)');
    const outer = errorWith('Error', 'outer', 'Error: outer\n    at g (b.js:3:3)');
    (outer as { cause?: unknown }).cause = inner;
    const crash = buildCrashJson(outer, { parseStack: parseV8Stack });
    expect(crash?.exception.cause?.name).toBe('RangeError');
    expect(crash?.exception.cause?.frames[0]?.trace).toBe('at f (a.js:2:2)');
  });

  it('guards a cause CYCLE (self-cause does not recurse / loop)', () => {
    const err = errorWith('Error', 'x', 'Error: x\n    at f (a.js:1:1)');
    (err as { cause?: unknown }).cause = err;
    const crash = buildCrashJson(err, { parseStack: parseV8Stack });
    expect(crash?.exception.cause).toBeUndefined();
  });

  it('caps the cause chain at 10 levels', () => {
    // Build 12 chained errors; the 11th cause (depth 10) must not be attached.
    let tip = errorWith('Error', 'e12', 'Error: e12\n    at f (a.js:12:1)');
    for (let i = 11; i >= 1; i -= 1) {
      const outer = errorWith('Error', `e${i}`, `Error: e${i}\n    at f (a.js:${i}:1)`);
      (outer as { cause?: unknown }).cause = tip;
      tip = outer;
    }
    let node = buildCrashJson(tip, { parseStack: parseV8Stack })?.exception;
    let depth = 0;
    while (node?.cause) {
      node = node.cause;
      depth += 1;
    }
    expect(depth).toBe(10); // 10 causes attached, the 11th dropped
  });

  it('defaults handled to false and returns undefined for non-Errors', () => {
    expect(buildCrashJson('not an error')).toBeUndefined();
    expect(buildCrashJson(undefined)).toBeUndefined();
    const err = errorWith('Error', 'x', 'Error: x\n    at f (a.js:1:1)');
    expect(buildCrashJson(err, { parseStack: parseV8Stack })?.handled).toBe(false);
  });

  it('omits reason when the error has no message', () => {
    const err = errorWith('Error', '', 'Error\n    at f (a.js:1:1)');
    expect(buildCrashJson(err, { parseStack: parseV8Stack })?.exception.reason).toBeUndefined();
  });

  it('defaults the name to Error when absent', () => {
    const err = errorWith('', 'x', 'Error: x\n    at f (a.js:1:1)');
    expect(buildCrashJson(err, { parseStack: parseV8Stack })?.exception.name).toBe('Error');
  });

  it('handles an error with no stack (empty frames)', () => {
    const err = errorWith('Error', 'x', undefined);
    // default parseStack (parseV8Stack) + default global — a bare env has no injected debug-ids.
    expect(buildCrashJson(err)?.exception.frames).toEqual([]);
  });

  it('omits data for a frame with no scrubbable fields (custom parser) + renders a bare trace', () => {
    const emptyParser = (_stack: string): StackFrame[] => [{}];
    const err = errorWith('Error', 'x', 'whatever');
    const f = buildCrashJson(err, { parseStack: emptyParser })?.exception.frames[0];
    expect(f?.data).toBeUndefined();
    expect(f?.trace).toBe('at <anonymous> (<unknown>)');
    expect(f?.user).toBe(true);
  });
});
