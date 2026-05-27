import { describe, expect, it } from 'vitest';
import { parseV8Stack } from './stack';

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

  it('returns an empty array for a stack with no frames', () => {
    expect(parseV8Stack('Error: just a message')).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseV8Stack('')).toEqual([]);
  });
});
