import { describe, expect, it } from 'vitest';
import {
  applyDebugIds,
  attachDebugIds,
  buildDebugIdMap,
  readDebugIds,
  runtimeMapsStacks,
  setDebugIdRegistrationVerifier,
} from './debug-id';
import { parseV8Stack, type StackFrame } from './stack';

// A V8 `Error().stack` whose TOP frame is the bundle's own file (what the injected stub captures).
const bundleStack = (file: string) =>
  `Error\n    at <anonymous> (${file}:1:234)\n    at ${file}:1:250`;

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
    const stack =
      'Error\n    at reg (https://cdn/app.js:1:5)\n    at load (https://cdn/runtime.js:2:9)';
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

describe('runtimeMapsStacks', () => {
  it('is true only when the runtime reports `process.sourceMapsEnabled === true`', () => {
    expect(runtimeMapsStacks({ sourceMapsEnabled: true })).toBe(true);
    expect(runtimeMapsStacks({ sourceMapsEnabled: false })).toBe(false);
    expect(runtimeMapsStacks({})).toBe(false); // Bun / browser polyfills: property absent
    expect(runtimeMapsStacks({ sourceMapsEnabled: 'yes' })).toBe(false);
  });

  it('falls back to the launch flags where `sourceMapsEnabled` does not exist (Node < 18.19 / 20.7)', () => {
    expect(runtimeMapsStacks({ execArgv: ['--no-warnings', '--enable-source-maps'] })).toBe(true);
    expect(
      runtimeMapsStacks({ env: { NODE_OPTIONS: '--max-old-space-size=4 --enable-source-maps' } }),
    ).toBe(true);
    expect(runtimeMapsStacks({ execArgv: ['--no-warnings'], env: { NODE_OPTIONS: '--x' } })).toBe(
      false,
    );
    expect(
      runtimeMapsStacks({ env: { NODE_OPTIONS: '--enable-source-maps-extra --enable' } }),
    ).toBe(false);
    expect(runtimeMapsStacks({ execArgv: 'nope', env: null })).toBe(false);
    expect(runtimeMapsStacks({ env: { NODE_OPTIONS: 7 } })).toBe(false);
    // an explicit answer always wins over the launch flags (setSourceMapsEnabled(false) after start)
    expect(
      runtimeMapsStacks({ sourceMapsEnabled: false, execArgv: ['--enable-source-maps'] }),
    ).toBe(false);
  });

  it('reads NODE_OPTIONS like Node: whitespace-separated tokens, DOUBLE quotes only (single quotes are not stripped)', () => {
    const opts = (NODE_OPTIONS: string) => runtimeMapsStacks({ env: { NODE_OPTIONS } });
    expect(opts('--x\t--enable-source-maps')).toBe(true);
    expect(opts('--x   --enable-source-maps')).toBe(true);
    expect(opts('"--enable-source-maps"')).toBe(true);
    expect(opts("--x '--enable-source-maps'")).toBe(false);
    expect(opts('"--enable-source-maps-extra"')).toBe(false);
  });

  it('recognizes the `=true` form of the flag, and not `=false`/`=0`, in execArgv and NODE_OPTIONS', () => {
    expect(runtimeMapsStacks({ execArgv: ['--enable-source-maps=true'] })).toBe(true);
    expect(runtimeMapsStacks({ env: { NODE_OPTIONS: '--enable-source-maps=true' } })).toBe(true);
    expect(runtimeMapsStacks({ env: { NODE_OPTIONS: '"--enable-source-maps=1"' } })).toBe(true);
    expect(runtimeMapsStacks({ execArgv: ['--enable-source-maps=false'] })).toBe(false);
    expect(runtimeMapsStacks({ env: { NODE_OPTIONS: '--enable-source-maps=0' } })).toBe(false);
    expect(runtimeMapsStacks({ env: { NODE_OPTIONS: '--enable-source-maps=maybe' } })).toBe(false);
  });

  it('never throws: a hostile process object answers false', () => {
    const hostile = {
      get sourceMapsEnabled(): never {
        throw new Error('getter');
      },
    };
    expect(runtimeMapsStacks(hostile)).toBe(false);
    const envThrows = {
      get env(): never {
        throw new Error('env getter');
      },
    };
    expect(runtimeMapsStacks(envThrows)).toBe(false);
  });

  it('is false without a process object (browsers, workers, edge)', () => {
    expect(runtimeMapsStacks(undefined)).toBe(false);
    expect(runtimeMapsStacks(null)).toBe(false);
    expect(runtimeMapsStacks(1)).toBe(false);
  });

  it('defaults to the live `globalThis.process`', () => {
    const g = globalThis as unknown as { process?: { sourceMapsEnabled?: boolean } };
    const real = g.process;
    try {
      g.process = { sourceMapsEnabled: true };
      expect(runtimeMapsStacks()).toBe(true);
      g.process = {};
      expect(runtimeMapsStacks()).toBe(false);
      g.process = undefined;
      expect(runtimeMapsStacks()).toBe(false);
    } finally {
      g.process = real;
    }
  });
});

describe('buildDebugIdMap with an accept predicate', () => {
  it('keeps only registrations the predicate accepts, passing (top-frame file, debugId)', () => {
    const seen: [string, string][] = [];
    const map = buildDebugIdMap(
      {
        [bundleStack('/app/src/main.js')]: 'mapped-id',
        [bundleStack('/app/dist/app.js')]: 'real-id',
      },
      parseV8Stack,
      (file, id) => {
        seen.push([file, id]);
        return file.includes('dist');
      },
    );
    expect([...map]).toEqual([['/app/dist/app.js', 'real-id']]);
    expect(seen).toEqual([
      ['/app/src/main.js', 'mapped-id'],
      ['/app/dist/app.js', 'real-id'],
    ]);
  });
});

describe('buildDebugIdMap with a throwing predicate', () => {
  it('treats a throw as a rejection of that registration only', () => {
    const map = buildDebugIdMap(
      {
        [bundleStack('/app/dist/bad.js')]: 'bad-id',
        [bundleStack('/app/dist/good.js')]: 'good-id',
      },
      parseV8Stack,
      (file) => {
        if (file.includes('bad')) throw new Error('verifier blew up');
        return true;
      },
    );
    expect([...map]).toEqual([['/app/dist/good.js', 'good-id']]);
  });
});

describe('applyDebugIds under runtime source-map support (#185)', () => {
  // With `node --enable-source-maps` AND a map on disk, the registration key's top frame is mapped to an
  // ORIGINAL file (`src/main.js`). Joining on it stamps the bundle's id onto already-mapped frames -> the
  // backend remaps them again -> a wrong line. Without the map on disk (the plugin default: maps are deleted
  // after upload) nothing is mapped and the plain join is correct. So the guard is PER REGISTRATION.
  const registry = {
    [bundleStack('/app/src/main.js')]: 'mapped-id', // registered under a mapping runtime
    [bundleStack('/app/dist/other.js')]: 'other-id', // a bundle whose map is absent
  };
  const verify = (file: string, id: string): boolean =>
    file === '/app/dist/other.js' && id === 'other-id';
  const frames = (): StackFrame[] => [
    { file: '/app/src/main.js', line: 3, column: 3 },
    { file: '/app/dist/other.js', line: 1, column: 9 },
  ];

  it('while the runtime maps stacks, drops registrations the verifier rejects and keeps verified ones', () => {
    const f = frames();
    applyDebugIds(f, {
      globalObject: { _bugseeDebugIds: registry },
      parseStack: parseV8Stack,
      runtimeMapsStacks: true,
      verifyRegistration: verify,
    });
    expect(f[0]?.debugId).toBeUndefined();
    expect(f[1]?.debugId).toBe('other-id');
  });

  it('does not consult the verifier when the runtime does not map stacks', () => {
    const f = frames();
    applyDebugIds(f, {
      globalObject: { _bugseeDebugIds: registry },
      parseStack: parseV8Stack,
      runtimeMapsStacks: false,
      verifyRegistration: () => false,
    });
    expect(f.map((x) => x.debugId)).toEqual(['mapped-id', 'other-id']);
  });

  it('keeps every registration when mapping is on but no verifier exists (browser / Electron renderer)', () => {
    const f = frames();
    applyDebugIds(f, {
      globalObject: { _bugseeDebugIds: registry },
      parseStack: parseV8Stack,
      runtimeMapsStacks: true,
    });
    expect(f.map((x) => x.debugId)).toEqual(['mapped-id', 'other-id']);
  });

  it('with no verifier at all, never even probes the runtime (identical to the pre-#185 path)', () => {
    const g = globalThis as unknown as {
      process?: unknown;
      _bugseeDebugIds?: Record<string, string>;
    };
    const real = g.process;
    const prev = g._bugseeDebugIds;
    let probed = 0;
    g._bugseeDebugIds = registry;
    g.process = {
      get sourceMapsEnabled(): boolean {
        probed++;
        return true;
      },
    };
    try {
      const f = frames();
      applyDebugIds(f);
      expect(f.map((x) => x.debugId)).toEqual(['mapped-id', 'other-id']);
      expect(probed).toBe(0);
    } finally {
      g.process = real;
      if (prev === undefined) delete g._bugseeDebugIds;
      else g._bugseeDebugIds = prev;
    }
  });

  it('uses the installed process-wide verifier by default, and the live process probe', () => {
    const g = globalThis as unknown as {
      process?: { sourceMapsEnabled?: boolean };
      _bugseeDebugIds?: Record<string, string>;
    };
    const real = g.process;
    const prev = g._bugseeDebugIds;
    g._bugseeDebugIds = registry;
    setDebugIdRegistrationVerifier(verify);
    try {
      g.process = { sourceMapsEnabled: true };
      const mapped = frames();
      applyDebugIds(mapped);
      expect(mapped.map((x) => x.debugId)).toEqual([undefined, 'other-id']);
      g.process = { sourceMapsEnabled: false };
      const plain = frames();
      applyDebugIds(plain);
      expect(plain.map((x) => x.debugId)).toEqual(['mapped-id', 'other-id']);
      setDebugIdRegistrationVerifier(undefined);
      g.process = { sourceMapsEnabled: true };
      const none = frames();
      applyDebugIds(none);
      expect(none.map((x) => x.debugId)).toEqual(['mapped-id', 'other-id']);
    } finally {
      setDebugIdRegistrationVerifier(undefined);
      g.process = real;
      if (prev === undefined) delete g._bugseeDebugIds;
      else g._bugseeDebugIds = prev;
    }
  });
});
