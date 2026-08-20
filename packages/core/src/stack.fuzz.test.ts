import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatStack, parseLocation, parseV8Stack, type StackFrame } from './stack';

/**
 * Property-based tests for the V8 stack parser.
 *
 * A stack string is not a controlled input: it comes from whatever the application threw, and V8 puts
 * shapes in it that no one writes down by hand — `async` frames, `eval at …` frames, native frames,
 * directory names containing " (", Windows drive letters, URLs with ports. The parser is pure string
 * work with no schema behind it, so the useful claims are structural: it round-trips what it emits, it
 * never throws, and the path scrubbing it exists for always happens.
 */

/** A file path shaped like something a real stack carries, including the awkward ones. */
const filePath = fc.oneof(
  fc.stringMatching(/^\/[a-z][a-z0-9/_.-]{2,30}\.[jt]s$/),
  fc.stringMatching(/^[A-Z]:\\[a-z][a-z0-9\\_.-]{2,20}\.[jt]s$/), // Windows drive letter (colons!)
  fc.stringMatching(/^https?:\/\/[a-z]{3,10}\.example\.com(:\d{2,5})?\/[a-z]{2,10}\.js$/), // ports (colons!)
  fc.constantFrom(
    '/app (prod)/index.js', // a directory containing " (" — the reason parseFrame uses indexOf
    '/srv/app/node_modules/@scope/pkg/dist/index.mjs',
    '<anonymous>',
    'node:internal/process/task_queues',
  ),
);

const functionName = fc.oneof(
  fc.stringMatching(/^[a-zA-Z_$][a-zA-Z0-9_$]{0,20}$/),
  fc.stringMatching(/^[A-Z][a-zA-Z]{2,10}\.[a-z][a-zA-Z]{2,10}$/), // Class.method
  fc.constantFrom('async handler', 'new Foo', 'Object.<anonymous>', '<anonymous>'),
);

const frame: fc.Arbitrary<StackFrame> = fc.record({
  function: functionName,
  file: filePath,
  line: fc.integer({ min: 1, max: 99_999 }),
  column: fc.integer({ min: 1, max: 999 }),
});

describe('parseV8Stack / formatStack (fuzz)', () => {
  /**
   * The round trip these two exist to make: what `formatStack` writes, `parseV8Stack` reads back.
   *
   * It matters beyond tidiness — the report path formats scrubbed frames back into a stack string, and
   * anything that cannot survive its own serialization is a frame the backend receives differently from
   * the one the SDK scrubbed.
   */
  it('round-trips frames through format → parse', () => {
    fc.assert(
      fc.property(fc.array(frame, { minLength: 1, maxLength: 8 }), (frames) => {
        const parsed = parseV8Stack(formatStack(frames));
        expect(parsed).toHaveLength(frames.length);
        for (const [i, original] of frames.entries()) {
          expect(parsed[i]?.function, `frame ${i} function`).toBe(original.function);
          expect(parsed[i]?.line, `frame ${i} line`).toBe(original.line);
          expect(parsed[i]?.column, `frame ${i} column`).toBe(original.column);
          expect(parsed[i]?.file, `frame ${i} file`).toBe(original.file);
        }
      }),
      { numRuns: 500 },
    );
  });

  // Totality. `.stack` is whatever the thrown value carries — an app can throw an object with a `stack`
  // getter returning anything at all — and this runs while a report is being assembled.
  it('never throws, for any string', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 400 }),
          fc.stringMatching(/^([ ]*at [^\n]{0,60}\n){0,8}$/),
          fc.array(fc.string({ maxLength: 40 }), { maxLength: 10 }).map((l) => l.join('\n')),
        ),
        (stack) => {
          expect(() => parseV8Stack(stack)).not.toThrow();
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('returns only well-formed frames, whatever the input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (stack) => {
        for (const f of parseV8Stack(stack)) {
          // `line`/`column` are either both present and finite, or both absent — a half-parsed location
          // would render as `file:undefined:3` on the way back out.
          expect(f.line === undefined).toBe(f.column === undefined);
          if (f.line !== undefined) {
            expect(Number.isFinite(f.line)).toBe(true);
            expect(Number.isFinite(f.column as number)).toBe(true);
          }
        }
      }),
      { numRuns: 500 },
    );
  });

  // The scrubbing this module exists for (§14.3 step 5). A `file://` prefix that survives is a frame the
  // backend cannot match to a source map, and `webpack://` noise is what makes a stack unreadable.
  it('always strips file:// and normalizes webpack://', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^\/[a-z][a-z0-9/_.-]{2,20}\.js$/),
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 1, max: 999 }),
        (path, line, column) => {
          const fromFileUrl = parseLocation(`file://${path}:${line}:${column}`);
          expect(fromFileUrl.file).toBe(path);
          expect(fromFileUrl.line).toBe(line);

          // `webpack://` and its multi-slash variants all collapse to the bare path.
          for (const prefix of ['webpack://', 'webpack:///', 'webpack:////']) {
            const scrubbed = parseLocation(`${prefix}${path.slice(1)}:${line}:${column}`);
            expect(scrubbed.file, `${prefix} was not normalized`).toBe(path.slice(1));
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  // A path can legitimately contain " (" — a directory named "app (prod)" — which is why the function/
  // location split uses the FIRST occurrence rather than the last. Getting that backwards silently moves
  // half the path into the function name.
  it('splits function from location on the FIRST " (", so a path may contain one', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-zA-Z0-9]{2,12}$/),
        fc.integer({ min: 1, max: 9999 }),
        (fn, line) => {
          const [parsed] = parseV8Stack(`    at ${fn} (/app (prod)/index.js:${line}:7)`);
          expect(parsed?.function).toBe(fn);
          expect(parsed?.file).toBe('/app (prod)/index.js');
          expect(parsed?.line).toBe(line);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Real V8 shapes that are not `fn (file:line:col)`. None may throw, and none may be silently dropped
  // when the line is clearly a frame.
  it('handles the frame shapes V8 actually emits', () => {
    const stack = [
      'Error: boom',
      '    at Object.<anonymous> (/srv/app/index.js:12:15)',
      '    at async handler (/srv/app/routes.js:44:3)',
      '    at new Foo (/srv/app/foo.js:1:1)',
      '    at /srv/app/bare.js:9:2',
      '    at node:internal/process/task_queues:95:5',
      '    at <anonymous>',
      '    at eval (eval at run (/srv/app/e.js:1:1), <anonymous>:1:1)',
    ].join('\n');
    const frames = parseV8Stack(stack);
    // Seven `at ` lines, and the header is not one of them.
    expect(frames).toHaveLength(7);
    expect(frames[0]).toMatchObject({
      function: 'Object.<anonymous>',
      file: '/srv/app/index.js',
      line: 12,
      column: 15,
    });
    expect(frames[1]?.function).toBe('async handler');
    expect(frames[3]).toMatchObject({ file: '/srv/app/bare.js', line: 9, column: 2 });
    expect(frames[4]).toMatchObject({ file: 'node:internal/process/task_queues', line: 95 });
  });
});
