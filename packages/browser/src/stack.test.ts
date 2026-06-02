import { describe, expect, it } from 'vitest';
import { parseStack } from './stack';

describe('parseStack — V8 / Chromium dialect', () => {
  it('delegates `at fn (file:line:col)` frames to the V8 parser (path-scrubbed)', () => {
    const stack = [
      'Error: boom',
      '    at doWork (https://app.test/work.js:10:15)',
      '    at file:///lib/x.js:5:1',
    ].join('\n');
    expect(parseStack(stack)).toEqual([
      { function: 'doWork', file: 'https://app.test/work.js', line: 10, column: 15 },
      { file: '/lib/x.js', line: 5, column: 1 }, // file:// stripped
    ]);
  });
});

describe('parseStack — SpiderMonkey / JavaScriptCore dialect (fn@location)', () => {
  it('parses Firefox-style frames', () => {
    const stack = [
      'doWork@https://app.test/work.js:10:15',
      'onload@https://app.test/index.js:3:1',
    ].join('\n');
    expect(parseStack(stack)).toEqual([
      { function: 'doWork', file: 'https://app.test/work.js', line: 10, column: 15 },
      { function: 'onload', file: 'https://app.test/index.js', line: 3, column: 1 },
    ]);
  });

  it('handles an anonymous frame (@location with no function)', () => {
    expect(parseStack('@https://app.test/a.js:1:2')).toEqual([
      { file: 'https://app.test/a.js', line: 1, column: 2 },
    ]);
  });

  it('handles Safari "global code" and skips non-frame lines like [native code]', () => {
    const stack = ['global code@https://app.test/a.js:1:1', '[native code]'].join('\n');
    expect(parseStack(stack)).toEqual([
      { function: 'global code', file: 'https://app.test/a.js', line: 1, column: 1 },
    ]);
  });

  it('scrubs webpack:// paths in the @-form', () => {
    expect(parseStack('mod@webpack:///./src/app.ts:3:7')).toEqual([
      { function: 'mod', file: './src/app.ts', line: 3, column: 7 },
    ]);
  });

  it('splits on the FIRST @ so a URL containing @ stays in the location', () => {
    // A function name never contains '@'; a URL can (userinfo). The FIRST '@' is the separator.
    expect(parseStack('fn@https://user@app.test/a.js:1:2')).toEqual([
      { function: 'fn', file: 'https://user@app.test/a.js', line: 1, column: 2 },
    ]);
  });

  it('ignores an @ line with an empty location', () => {
    expect(parseStack('weird@')).toEqual([]);
  });

  it('routes a function name starting with "at" to the @-parser, not V8 (the space matters)', () => {
    // `attachThing@...` must not be mistaken for a V8 `at ` frame and dropped.
    expect(parseStack('attachThing@https://app.test/a.js:1:2')).toEqual([
      { function: 'attachThing', file: 'https://app.test/a.js', line: 1, column: 2 },
    ]);
  });
});

describe('parseStack — edge cases', () => {
  it('returns [] for an empty string', () => {
    expect(parseStack('')).toEqual([]);
  });

  it('returns [] for a stack with no recognizable frames', () => {
    expect(parseStack('just a message\nmore noise')).toEqual([]);
  });
});
