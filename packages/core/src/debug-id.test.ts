import { describe, expect, it } from 'vitest';
import { applyDebugIds, attachDebugIds, buildDebugIdMap, readDebugIds } from './debug-id';
import { type StackFrame, parseV8Stack } from './stack';

// A V8 `Error().stack` whose TOP frame is the bundle's own file (what the injected stub captures).
const bundleStack = (file: string) => `Error\n    at <anonymous> (${file}:1:234)\n    at ${file}:1:250`;

describe('readDebugIds', () => {
  it('reads `_bugseeDebugIds` from a global object', () => {
    expect(readDebugIds({ _bugseeDebugIds: { s: 'id' } })).toEqual({ s: 'id' });
  });

  it('returns {} when the global has no _bugseeDebugIds', () => {
    expect(readDebugIds({})).toEqual({});
  });

  it('returns {} for a non-object / null global', () => {
    expect(readDebugIds(null)).toEqual({});
    expect(readDebugIds(42)).toEqual({});
  });

  it('returns {} when _bugseeDebugIds is not a (non-null) object', () => {
    expect(readDebugIds({ _bugseeDebugIds: 'nope' })).toEqual({});
    expect(readDebugIds({ _bugseeDebugIds: null })).toEqual({});
  });
});

describe('buildDebugIdMap', () => {
  it("maps each stack's TOP-frame file to its debug-ID (ignoring lower frames)", () => {
    // The top frame is the bundle that registered; a lower frame is a different file and must NOT be keyed.
    const stack = 'Error\n    at reg (https://cdn/app.js:1:5)\n    at load (https://cdn/runtime.js:2:9)';
    const map = buildDebugIdMap(
      { [stack]: 'app-id', [bundleStack('https://cdn/vendor.js')]: 'vendor-id' },
      parseV8Stack,
    );
    expect(map.get('https://cdn/app.js')).toBe('app-id'); // top frame
    expect(map.get('https://cdn/runtime.js')).toBeUndefined(); // a lower frame is not the bundle
    expect(map.get('https://cdn/vendor.js')).toBe('vendor-id');
  });

  it('skips a stack with no parseable frame', () => {
    const map = buildDebugIdMap({ 'no frames here': 'x' }, parseV8Stack);
    expect(map.size).toBe(0);
  });
});

describe('attachDebugIds', () => {
  it('stamps debugId onto frames whose file is in the map', () => {
    const frames: StackFrame[] = [
      { file: 'https://cdn/app.js', line: 5, column: 1 },
      { file: 'https://cdn/other.js', line: 2, column: 2 },
    ];
    attachDebugIds(frames, new Map([['https://cdn/app.js', 'app-id']]));
    expect(frames[0]?.debugId).toBe('app-id');
    expect(frames[1]?.debugId).toBeUndefined(); // no match → untouched
  });

  it('leaves frames without a file untouched', () => {
    const frames: StackFrame[] = [{ function: 'anon' }];
    attachDebugIds(frames, new Map([['x', 'id']]));
    expect(frames[0]?.debugId).toBeUndefined();
  });
});

describe('applyDebugIds', () => {
  it('end-to-end: reads the global stub, builds the map, and stamps matching frames', () => {
    const frames: StackFrame[] = [{ file: 'https://cdn/app.js', line: 1, column: 1 }];
    applyDebugIds(frames, {
      globalObject: { _bugseeDebugIds: { [bundleStack('https://cdn/app.js')]: 'app-id' } },
      parseStack: parseV8Stack,
    });
    expect(frames[0]?.debugId).toBe('app-id');
  });

  it('is a no-op when there is no _bugseeDebugIds (no plugin ran)', () => {
    const frames: StackFrame[] = [{ file: 'https://cdn/app.js' }];
    applyDebugIds(frames, { globalObject: {}, parseStack: parseV8Stack });
    expect(frames[0]?.debugId).toBeUndefined();
  });

  it('defaults to globalThis + parseV8Stack when no options are given', () => {
    const g = globalThis as { _bugseeDebugIds?: Record<string, string> };
    const prev = g._bugseeDebugIds;
    g._bugseeDebugIds = { [bundleStack('/abs/app.js')]: 'g-id' };
    try {
      const frames: StackFrame[] = [{ file: '/abs/app.js' }];
      applyDebugIds(frames);
      expect(frames[0]?.debugId).toBe('g-id');
    } finally {
      if (prev === undefined) delete g._bugseeDebugIds;
      else g._bugseeDebugIds = prev;
    }
  });
});
