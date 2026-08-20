import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseStack } from './stack';

/**
 * Property-based tests for the engine-dispatching stack parser.
 *
 * Three dialects reach this function and the SDK does not choose which: Chromium emits V8's
 * `at fn (loc)`, Firefox and Safari emit `fn@loc`. On top of that the input is whatever the page threw —
 * a stack can be absent, truncated, or a string an application wrote itself. The claims worth stating are
 * that dispatch picks the right dialect, that a recognised frame is never half-parsed, and that nothing
 * throws, since this runs while an error report is being assembled in someone else's page.
 */

const url = fc.oneof(
  fc.stringMatching(/^https:\/\/[a-z]{3,10}\.example\.com\/[a-z]{2,10}\.js$/),
  fc.stringMatching(/^https:\/\/[a-z]{3,10}\.example\.com:\d{2,5}\/[a-z]{2,10}\.js$/), // port: extra colons
  // A location containing '@' — which is what makes the FIRST-'@' split load-bearing. Scoped packages
  // are the everyday case (`/node_modules/@scope/pkg/index.js` is in most dev-build stacks); splitting
  // on the LAST '@' instead moves half the path into the function name, and without one of these in the
  // generator that mutation survived.
  fc.stringMatching(
    /^https:\/\/[a-z]{3,8}\.example\.com\/node_modules\/@[a-z]{2,8}\/[a-z]{2,8}\/index\.js$/,
  ),
  fc.constantFrom(
    'debugger eval code',
    'moz-extension://uuid/content.js',
    'https://cdn.example.com/@vite/client',
  ),
);
const fnName = fc.stringMatching(/^[a-zA-Z_$][a-zA-Z0-9_$]{0,16}$/);
const line = fc.integer({ min: 1, max: 99_999 });
const column = fc.integer({ min: 1, max: 999 });

describe('parseStack — engine dispatch (fuzz)', () => {
  it('parses the SpiderMonkey / JavaScriptCore dialect', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fnName, url, line, column), { minLength: 1, maxLength: 6 }),
        (frames) => {
          const stack = frames.map(([fn, u, l, c]) => `${fn}@${u}:${l}:${c}`).join('\n');
          const parsed = parseStack(stack);
          expect(parsed).toHaveLength(frames.length);
          for (const [i, [fn, u, l, c]] of frames.entries()) {
            expect(parsed[i]?.function).toBe(fn);
            expect(parsed[i]?.file).toBe(u);
            expect(parsed[i]?.line).toBe(l);
            expect(parsed[i]?.column).toBe(c);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  // Firefox writes an anonymous frame as a bare `@location`, with nothing before the '@'.
  it('parses an anonymous @-frame without inventing a function name', () => {
    fc.assert(
      fc.property(url, line, column, (u, l, c) => {
        const [parsed] = parseStack(`@${u}:${l}:${c}`);
        expect(parsed?.function).toBeUndefined();
        expect(parsed?.file).toBe(u);
        expect(parsed?.line).toBe(l);
      }),
      { numRuns: 300 },
    );
  });

  /**
   * Dispatch is decided by whether ANY line starts with `at `, so a V8 stack must win even when it is
   * mixed with lines that could be read as the other dialect — an error MESSAGE containing an '@' (an
   * email address, an npm scope) sits above the frames in every V8 stack.
   */
  it('chooses the V8 dialect whenever V8 frames are present, message notwithstanding', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'Error: failed for user@example.com',
          'TypeError: cannot read @scope/pkg',
          'Error: boom',
        ),
        fnName,
        url,
        line,
        column,
        (message, fn, u, l, c) => {
          const parsed = parseStack(`${message}\n    at ${fn} (${u}:${l}:${c})`);
          // Exactly the one real frame: the message line is not a frame in either dialect.
          expect(parsed).toHaveLength(1);
          expect(parsed[0]?.function).toBe(fn);
          expect(parsed[0]?.file).toBe(u);
        },
      ),
      { numRuns: 400 },
    );
  });

  // `[native code]` and similar carry no '@', so they are not frames — dropping them keeps the stack
  // readable, and mis-reading them would produce a frame whose "file" is a sentence.
  it('drops @-dialect lines that carry no location', () => {
    fc.assert(
      fc.property(fnName, url, line, (fn, u, l) => {
        const parsed = parseStack(['[native code]', `${fn}@${u}:${l}:1`, 'x@'].join('\n'));
        expect(parsed).toHaveLength(1);
        expect(parsed[0]?.file).toBe(u);
      }),
      { numRuns: 300 },
    );
  });

  it('never throws, and never returns a half-parsed frame', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 400 }),
          fc.array(fc.string({ maxLength: 50 }), { maxLength: 10 }).map((l) => l.join('\n')),
          fc.stringMatching(/^([a-z@:0-9./ ]{0,40}\n){0,6}$/),
        ),
        (stack) => {
          let frames: ReturnType<typeof parseStack> = [];
          expect(() => {
            frames = parseStack(stack);
          }).not.toThrow();
          for (const f of frames) {
            // line and column travel together; one without the other renders as `file:undefined:3`.
            expect(f.line === undefined).toBe(f.column === undefined);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('returns no frames for input that contains none', () => {
    for (const stack of ['', '   ', 'Error: boom', 'just a sentence', '\n\n']) {
      expect(parseStack(stack), `expected no frames from ${JSON.stringify(stack)}`).toEqual([]);
    }
  });
});
