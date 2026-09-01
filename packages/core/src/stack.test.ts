import { describe, expect, it } from 'vitest';
import { callSiteFrames, formatStack, parseLocation, parseV8Stack, type StackFrame } from './stack';

describe('parseV8Stack', () => {
  it('parses a typical Node stack into structured frames', () => {
    const stack = [
      'Error: boom',
      '    at doWork (/app/src/work.js:10:15)',
      '    at /app/src/index.js:5:1',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n');
    expect(parseV8Stack(stack)).toEqual([
      { function: 'doWork', file: '/app/src/work.js', line: 10, column: 15 },
      { file: '/app/src/index.js', line: 5, column: 1 },
      {
        function: 'process.processTicksAndRejections',
        file: 'node:internal/process/task_queues',
        line: 95,
        column: 5,
      },
    ]);
  });

  it('skips the header line and any non-frame lines', () => {
    expect(parseV8Stack('Error: nope\nsome noise\n    at f (/a.js:1:2)')).toEqual([
      { function: 'f', file: '/a.js', line: 1, column: 2 },
    ]);
  });

  it('strips a file:// URL from a frame path (§14.3)', () => {
    expect(parseV8Stack('    at Object.<anonymous> (file:///app/main.js:1:1)')).toEqual([
      { function: 'Object.<anonymous>', file: '/app/main.js', line: 1, column: 1 },
    ]);
  });

  it('normalizes a webpack:// frame path to a friendly path (§14.3)', () => {
    expect(parseV8Stack('    at mod (webpack:///./src/app.ts:3:7)')).toEqual([
      { function: 'mod', file: './src/app.ts', line: 3, column: 7 },
    ]);
  });

  it('handles an anonymous frame with no function name', () => {
    expect(parseV8Stack('    at /lib/x.js:42:9')).toEqual([
      { file: '/lib/x.js', line: 42, column: 9 },
    ]);
  });

  it('splits at the first " (" so a parenthesized path stays in the location', () => {
    expect(parseV8Stack('    at handler (/app (prod)/server.js:8:3)')).toEqual([
      { function: 'handler', file: '/app (prod)/server.js', line: 8, column: 3 },
    ]);
  });

  it('handles a location without line/column (e.g. <anonymous>)', () => {
    expect(parseV8Stack('    at Generator.next (<anonymous>)')).toEqual([
      { function: 'Generator.next', file: '<anonymous>' },
    ]);
  });

  it('omits the function key entirely for a bare-location frame (no function: undefined)', () => {
    const frame = parseV8Stack('    at /lib/x.js:42:9')[0];
    expect(frame).not.toHaveProperty('function');
  });

  it('does not split "fn (loc" without a closing paren (the path keeps the " (")', () => {
    // endsWith(")") guards the split; a truncated line is treated as a bare location.
    expect(parseV8Stack('    at fn (/a.js:1:2')).toEqual([
      { file: 'fn (/a.js', line: 1, column: 2 },
    ]);
  });

  it('does not treat a noise line merely starting with "at" as a frame (the space matters)', () => {
    expect(parseV8Stack('Error\natypical noise here')).toEqual([]);
  });

  it('does not treat a trailing ")" without a " (" as a function split', () => {
    // Pins the `open !== -1` conjunct: "weird)" has no " (", so it stays a bare location.
    expect(parseV8Stack('    at weird)')).toEqual([{ file: 'weird)' }]);
  });

  it('returns an empty array for a stack with no frames', () => {
    expect(parseV8Stack('Error: just a message')).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseV8Stack('')).toEqual([]);
  });
});

describe('parseLocation', () => {
  it('parses file:line:column and scrubs the path (file:// and webpack://)', () => {
    expect(parseLocation('file:///app/main.js:1:1')).toEqual({
      file: '/app/main.js',
      line: 1,
      column: 1,
    });
    expect(parseLocation('webpack:///./src/app.ts:3:7')).toEqual({
      file: './src/app.ts',
      line: 3,
      column: 7,
    });
  });

  it('returns a bare scrubbed file when there is no line:column', () => {
    expect(parseLocation('<anonymous>')).toEqual({ file: '<anonymous>' });
    expect(parseLocation('file:///lib/x.js')).toEqual({ file: '/lib/x.js' });
  });

  it('only strips the full file:// and webpack:// prefixes, not a single-slash lookalike', () => {
    expect(parseLocation('file:/local/x.js')).toEqual({ file: 'file:/local/x.js' });
    expect(parseLocation('webpack:/local/x.js')).toEqual({ file: 'webpack:/local/x.js' });
  });

  it('does not split a location whose file part would be empty or non-numeric line/col', () => {
    // `(.+)` (not `.*`) requires a non-empty file; `(\\d+)` requires real digits.
    expect(parseLocation(':1:2')).toEqual({ file: ':1:2' });
    expect(parseLocation('a::2')).toEqual({ file: 'a::2' });
  });

  it('requires a fully-numeric column anchored to the end (no empty / trailing-garbage column)', () => {
    // Pins `(\\d+)$`: an empty column or trailing junk must NOT match (stays a bare file).
    expect(parseLocation('a:1:')).toEqual({ file: 'a:1:' });
    expect(parseLocation('a:1:2extra')).toEqual({ file: 'a:1:2extra' });
  });
});

describe('formatStack', () => {
  it('renders frames with function, file, line and column', () => {
    expect(formatStack([{ function: 'doWork', file: '/a.js', line: 10, column: 5 }])).toBe(
      '    at doWork (/a.js:10:5)',
    );
  });

  it('uses <anonymous> for a frame without a function name', () => {
    expect(formatStack([{ file: '/a.js', line: 1, column: 2 }])).toBe(
      '    at <anonymous> (/a.js:1:2)',
    );
  });

  it('omits line/column for a frame that has none', () => {
    expect(formatStack([{ function: 'f', file: '<anonymous>' }])).toBe('    at f (<anonymous>)');
  });

  it('omits the location numbers unless BOTH line and column are present', () => {
    // The `&&` is load-bearing: a half-located frame must not render ":undefined".
    expect(formatStack([{ function: 'f', file: '/a', line: 5 }])).toBe('    at f (/a)');
    expect(formatStack([{ function: 'f', file: '/a', column: 5 }])).toBe('    at f (/a)');
  });

  it('keeps an explicit empty function name (?? only fills undefined, not "")', () => {
    expect(formatStack([{ function: '', file: '/a', line: 1, column: 2 }])).toBe(
      '    at  (/a:1:2)',
    );
  });

  it('joins multiple frames with newlines and round-trips a parsed stack', () => {
    const stack = '    at a (/x.js:1:2)\n    at b (/y.js:3:4)';
    expect(formatStack(parseV8Stack(stack))).toBe(stack);
  });

  it('returns an empty string for no frames', () => {
    expect(formatStack([])).toBe('');
  });

  it('appends an additive ` debugId=<id>` suffix when a frame carries a debug-ID', () => {
    expect(
      formatStack([{ function: 'f', file: '/a.js', line: 1, column: 2, debugId: 'abc-123' }]),
    ).toBe('    at f (/a.js:1:2) debugId=abc-123');
  });

  it('omits the suffix for frames without a debug-ID', () => {
    expect(formatStack([{ function: 'f', file: '/a.js', line: 1, column: 2 }])).not.toContain(
      'debugId',
    );
  });
});

describe('callSiteFrames — a stack for a value that never had one', () => {
  // A thrown non-Error (a string, a plain object, null) carries no stack, so `crash.json` shipped
  // `frames: []`. That costs more than a location: worker/crash/managed/common.py:88 only emits
  // grouping signatures when it has a top frame, so EVERY occurrence became a new issue. Four
  // identical `logException('...')` calls produced SBROWSER-32/35/38/41, one event each.
  //
  // The caller's own frames are the fault site; only the SDK's frames have to go.

  it('drops the boundary and everything the SDK called above it (Error.captureStackTrace)', () => {
    const parse = (stack: string) =>
      stack
        .split('\n')
        .filter((l) => l.trim().startsWith('at '))
        .map((l) => ({ file: 'f', function: l.trim().slice(3).split(' ')[0] }) as StackFrame);

    function boundary(): StackFrame[] {
      return callSiteFrames(new Error(), boundary, parse);
    }
    function applicationCode(): StackFrame[] {
      return boundary();
    }

    const frames = applicationCode();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]?.function).toBe('applicationCode'); // the caller, not the SDK
    expect(frames.map((f) => f.function)).not.toContain('boundary');
  });

  it('falls back to dropping exactly the boundary frame where captureStackTrace is absent', () => {
    // Measured 2026-08-26: Chromium, Firefox AND WebKit all expose Error.captureStackTrace, so this
    // path is for older engines only. It stays deterministic by construction rather than by matching
    // function names (which minification renames): the Error is created INSIDE the boundary, so the
    // boundary is always frame 0 and dropping one frame is exact.
    const original = (Error as { captureStackTrace?: unknown }).captureStackTrace;
    (Error as { captureStackTrace?: unknown }).captureStackTrace = undefined;
    try {
      const parse = (): StackFrame[] => [
        { file: 'sdk', function: 'boundary' },
        { file: 'app', function: 'applicationCode' },
      ];
      const frames = callSiteFrames(new Error(), function boundary() {}, parse);
      expect(frames.map((f) => f.function)).toEqual(['applicationCode']);
    } finally {
      (Error as { captureStackTrace?: unknown }).captureStackTrace = original;
    }
  });

  it('returns no frames when the engine produces no stack at all', () => {
    // Very old engines (and some embedded ones) leave `error.stack` undefined. `?? ''` keeps that a
    // frameless report rather than a thrown SDK — the same outcome as before this existed.
    const original = (Error as { captureStackTrace?: unknown }).captureStackTrace;
    (Error as { captureStackTrace?: unknown }).captureStackTrace = undefined;
    try {
      const noStack = new Error();
      Object.defineProperty(noStack, 'stack', { value: undefined });
      expect(callSiteFrames(noStack, function boundary() {}, parseV8Stack)).toEqual([]);
    } finally {
      (Error as { captureStackTrace?: unknown }).captureStackTrace = original;
    }
  });

  it('returns no frames when the engine produces no stack, WITH captureStackTrace present', () => {
    // Symmetric case: the capture runs but the engine still yields nothing readable.
    const noStack = new Error();
    Object.defineProperty(noStack, 'stack', { value: undefined, writable: true });
    const capture = (Error as { captureStackTrace?: (t: object, f: unknown) => void })
      .captureStackTrace;
    if (typeof capture === 'function') {
      // captureStackTrace would normally REPLACE .stack; pin the non-writable case instead.
      Object.defineProperty(noStack, 'stack', { value: undefined, writable: false });
    }
    expect(callSiteFrames(noStack, function boundary() {}, parseV8Stack)).toEqual([]);
  });

  it('never throws and never leaves the caller without an array', () => {
    const frames = callSiteFrames(
      new Error(),
      function boundary() {},
      () => {
        throw new Error('parser exploded');
      },
    );
    expect(frames).toEqual([]);
  });
});

describe("scrubFramePath — the customer's filesystem must not ship in a crash", () => {
  // A Node crash frame carried the FULL absolute path: the OS username, the home-directory layout and
  // often an internal project codename, in every report. The SDK's rule is that privacy-relevant data is
  // obscured to the maximum extent possible BY DEFAULT, and this was shipped behaviour that broke it.

  it('truncates a dependency path at the FIRST node_modules boundary, not the last', () => {
    // Load-bearing. `file` is the key of the `file → debugId` source-map join, so two distinct files
    // scrubbing to one string would hand a frame the WRONG debug id and symbolicate it against the wrong
    // map — worse than the leak. Measured on a real 24,591-file pnpm tree: truncating at the LAST
    // boundary collapses 2,783 distinct files onto shared keys; at the FIRST, zero.
    expect(
      parseLocation('/Users/jane/app/node_modules/a/node_modules/lodash/index.js:1:1').file,
    ).toBe('node_modules/a/node_modules/lodash/index.js');
    // …so a nested copy stays distinguishable from a hoisted one, which is the whole duplicate-package
    // signal: same package, two versions, one process.
    expect(parseLocation('/Users/jane/app/node_modules/lodash/index.js:1:1').file).toBe(
      'node_modules/lodash/index.js',
    );
  });

  it('keeps the pnpm version directory, which carries the version for free', () => {
    expect(
      parseLocation('/Users/jane/app/node_modules/.pnpm/ipaddr.js@2.4.0/node_modules/ipaddr.js:1:1')
        .file,
    ).toBe('node_modules/.pnpm/ipaddr.js@2.4.0/node_modules/ipaddr.js');
  });

  it('leaves a URL alone — a browser frame is not a filesystem path', () => {
    // The leak is node-family only. Scrubbing a URL would destroy the origin, which IS the useful part.
    expect(parseLocation('https://app.example.com/static/js/main.abc.js:9:1').file).toBe(
      'https://app.example.com/static/js/main.abc.js',
    );
  });

  it('leaves an already-relative path alone', () => {
    expect(parseLocation('./src/app.ts:3:7').file).toBe('./src/app.ts');
  });
});
