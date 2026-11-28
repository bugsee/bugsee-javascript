import { describe, expect, it } from 'vitest';
import {
  describeModuleLoadFailure,
  detectModuleLoadFailure,
  IMPORT_FRAME_FUNCTION,
  moduleLoadFrameEnricher,
  REQUIRE_FRAME_FUNCTION,
  withModuleLoadFrames,
} from './module-load-failure';

// Shapes copied from what node 26 and bun 1.4 really produce (see the module's header).
function nodeEsmNotFound(): Error {
  return Object.assign(
    new Error("Cannot find module '/app/lazy.mjs' imported from /app/main.mjs"),
    { code: 'ERR_MODULE_NOT_FOUND', url: 'file:///app/lazy.mjs' },
  );
}

function nodeEsmPackageNotFound(): Error {
  return Object.assign(new Error("Cannot find package 'left-pad' imported from /app/main.mjs"), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
}

function nodeCjsNotFound(): Error {
  return Object.assign(
    new Error("Cannot find module './missing'\nRequire stack:\n- /app/a.cjs\n- /app/main.cjs"),
    { code: 'MODULE_NOT_FOUND', requireStack: ['/app/a.cjs', '/app/main.cjs'] },
  );
}

function bunResolve(extra: Record<string, unknown> = {}): Error {
  const error = new Error("Cannot find module './nope-dep.mjs' imported from /app/dep.mjs");
  error.name = 'ResolveMessage';
  return Object.assign(error, {
    code: 'ERR_MODULE_NOT_FOUND',
    specifier: './nope-dep.mjs',
    referrer: '/app/dep.mjs',
    importKind: 'import-statement',
    ...extra,
  });
}

function bunBuildError(column: number | null = 17): Error {
  const error = new Error('2 errors building "/app/syntax.mjs"');
  error.name = 'AggregateError';
  return Object.assign(error, {
    errors: [
      {
        name: 'BuildMessage',
        position: { file: '/app/syntax.mjs', line: 1, column: column ?? undefined },
      },
    ],
  });
}

function nodeSyntax(): Error {
  const error = new SyntaxError(
    "The requested module './exports.mjs' does not provide an export named 'nothere'",
  );
  error.stack = [
    'file:///app/named.mjs:1',
    "import { nothere } from './exports.mjs';",
    '         ^^^^^^^',
    `SyntaxError: ${error.message}`,
    '    at #asyncInstantiate (node:internal/modules/esm/module_job:463:21)',
  ].join('\n');
  return error;
}

describe('detectModuleLoadFailure', () => {
  it('reads a CommonJS syntax-error header, whose file is a bare path', () => {
    const error = new SyntaxError('Unexpected token');
    error.stack =
      '/app/broken.cjs:3\nconst = ;\n      ^\n\nSyntaxError: Unexpected token\n    at wrapSafe (node:internal/modules/cjs/loader:1)';
    expect(detectModuleLoadFailure(error)?.position).toEqual({
      file: '/app/broken.cjs',
      line: 3,
      column: 7,
    });
  });

  it('ignores a SyntaxError with no stack and no position', () => {
    const error = new SyntaxError('Unexpected token');
    error.stack = undefined;
    expect(detectModuleLoadFailure(error)).toBeUndefined();
  });

  it('reads a node ESM resolution failure from its url and message', () => {
    expect(detectModuleLoadFailure(nodeEsmNotFound())).toEqual({
      kind: 'resolution',
      via: 'import',
      requireStack: [],
      module: '/app/lazy.mjs',
      importer: '/app/main.mjs',
      code: 'ERR_MODULE_NOT_FOUND',
    });
  });

  it('reads a missing package from the message alone', () => {
    expect(detectModuleLoadFailure(nodeEsmPackageNotFound())).toMatchObject({
      module: 'left-pad',
      importer: '/app/main.mjs',
      via: 'import',
    });
  });

  it('treats a require chain as a require, importer first', () => {
    expect(detectModuleLoadFailure(nodeCjsNotFound())).toMatchObject({
      via: 'require',
      module: './missing',
      importer: '/app/a.cjs',
      requireStack: ['/app/a.cjs', '/app/main.cjs'],
    });
  });

  it("reads bun's structured ResolveMessage fields, which carry no stack", () => {
    expect(detectModuleLoadFailure(bunResolve())).toMatchObject({
      module: './nope-dep.mjs',
      importer: '/app/dep.mjs',
      via: 'import',
      code: 'ERR_MODULE_NOT_FOUND',
    });
    expect(detectModuleLoadFailure(bunResolve({ importKind: 'require-call' }))?.via).toBe(
      'require',
    );
  });

  it("finds the position of bun's build error and of node's syntax-error stack header", () => {
    expect(detectModuleLoadFailure(bunBuildError())?.position).toEqual({
      file: '/app/syntax.mjs',
      line: 1,
      column: 17,
    });
    expect(detectModuleLoadFailure(nodeSyntax())?.position).toEqual({
      file: '/app/named.mjs',
      line: 1,
      column: 10,
    });
  });

  it("names the module of bun's stackless missing-export SyntaxError", () => {
    const error = new SyntaxError("Export named 'nothere' not found in module '/app/exports.mjs'.");
    error.stack = undefined;
    expect(detectModuleLoadFailure(error)).toMatchObject({
      kind: 'resolution',
      module: '/app/exports.mjs',
      missingExport: 'nothere',
    });
    expect(describeModuleLoadFailure(error)).toBe(
      'Failed module: /app/exports.mjs\nLoaded via: import\nMissing export: nothere',
    );
    expect(moduleLoadFrameEnricher(error, [])).toEqual([
      { function: IMPORT_FRAME_FUNCTION, file: '/app/exports.mjs' },
    ]);
  });

  it('ignores errors that are not module loads', () => {
    expect(detectModuleLoadFailure(new Error('boom'))).toBeUndefined();
    expect(
      detectModuleLoadFailure(new SyntaxError('Unexpected end of JSON input')),
    ).toBeUndefined();
    expect(
      detectModuleLoadFailure(Object.assign(new Error('x'), { code: 'ENOENT' })),
    ).toBeUndefined();
    expect(detectModuleLoadFailure('ERR_MODULE_NOT_FOUND')).toBeUndefined();
    expect(detectModuleLoadFailure(null)).toBeUndefined();
    const aggregate = new AggregateError([new Error('a')], 'many');
    expect(detectModuleLoadFailure(aggregate)).toBeUndefined();
  });

  it('survives a hostile error whose getters throw', () => {
    const hostile = Object.defineProperties(new Error('x'), {
      code: {
        get() {
          throw new Error('getter');
        },
      },
      name: {
        get() {
          throw new Error('getter');
        },
      },
    });
    expect(detectModuleLoadFailure(hostile)).toBeUndefined();
  });

  it('keeps going when one field is unusable', () => {
    const odd = Object.assign(new Error("Cannot find module 'x'"), {
      code: 'MODULE_NOT_FOUND',
      requireStack: 'not-an-array',
      url: 'file://%zz',
    });
    expect(detectModuleLoadFailure(odd)).toMatchObject({ requireStack: [] });
  });
});

describe('moduleLoadFrameEnricher', () => {
  const internal = [
    {
      function: 'finalizeResolution',
      file: 'node:internal/modules/esm/resolve',
      line: 241,
      column: 11,
    },
  ];

  it('puts the failed module first and keeps the runtime frames', () => {
    const frames = moduleLoadFrameEnricher(nodeEsmNotFound(), internal);
    expect(frames[0]).toEqual({ function: IMPORT_FRAME_FUNCTION, file: '/app/lazy.mjs' });
    expect(frames.slice(1)).toEqual(internal);
  });

  it('is the only frame when the runtime gave none (bun)', () => {
    expect(moduleLoadFrameEnricher(bunResolve(), [])).toEqual([
      { function: IMPORT_FRAME_FUNCTION, file: './nope-dep.mjs' },
    ]);
  });

  it('names a require()', () => {
    expect(moduleLoadFrameEnricher(nodeCjsNotFound(), [])[0]?.function).toBe(
      REQUIRE_FRAME_FUNCTION,
    );
  });

  it('turns a syntax error into a frame at its position, once', () => {
    const frames = moduleLoadFrameEnricher(nodeSyntax(), internal);
    expect(frames[0]).toMatchObject({ file: '/app/named.mjs', line: 1, column: 10 });
    expect(moduleLoadFrameEnricher(nodeSyntax(), frames)).toBe(frames);
    const columnless = bunBuildError(null);
    expect(moduleLoadFrameEnricher(columnless, [])[0]).toEqual({
      file: '/app/syntax.mjs',
      line: 1,
    });
  });

  it('leaves any other error alone, and a failure that names no module', () => {
    const frames = [{ file: 'a.js', line: 1, column: 1 }];
    expect(moduleLoadFrameEnricher(new Error('x'), frames)).toBe(frames);
    const nameless = Object.assign(new Error('Module resolution failed'), {
      code: 'ERR_REQUIRE_ESM',
    });
    expect(moduleLoadFrameEnricher(nameless, frames)).toBe(frames);
  });
});

describe('describeModuleLoadFailure', () => {
  it('lists the module, importer, how it was loaded, the code and the require stack', () => {
    expect(describeModuleLoadFailure(nodeCjsNotFound())).toBe(
      [
        'Failed module: ./missing',
        'Imported from: /app/a.cjs',
        'Loaded via: require()',
        'Code: MODULE_NOT_FOUND',
        'Require stack:',
        '  /app/a.cjs',
        '  /app/main.cjs',
      ].join('\n'),
    );
  });

  it('describes an ESM failure and a syntax error', () => {
    expect(describeModuleLoadFailure(nodeEsmNotFound())).toBe(
      [
        'Failed module: /app/lazy.mjs',
        'Imported from: /app/main.mjs',
        'Loaded via: import',
        'Code: ERR_MODULE_NOT_FOUND',
      ].join('\n'),
    );
    expect(describeModuleLoadFailure(nodeSyntax())).toBe(
      'Syntax error in module: /app/named.mjs:1:10',
    );
    expect(describeModuleLoadFailure(bunBuildError())).toBe(
      'Syntax error in module: /app/syntax.mjs:1:17',
    );
  });

  it('says only what it knows', () => {
    const bare = Object.assign(new Error('nope'), { code: 'ERR_REQUIRE_ESM' });
    expect(describeModuleLoadFailure(bare)).toBe('Loaded via: require()\nCode: ERR_REQUIRE_ESM');
    const noCode = bunResolve({ code: undefined });
    expect(describeModuleLoadFailure(noCode)).not.toContain('Code:');
  });

  it('is undefined for any other error', () => {
    expect(describeModuleLoadFailure(new Error('x'))).toBeUndefined();
  });
});

describe('review follow-ups', () => {
  const coded = (code: string, message: string): Error =>
    Object.assign(new Error(message), { code });

  it('names the module and importer of an unexported package subpath', () => {
    const failure = detectModuleLoadFailure(
      coded(
        'ERR_PACKAGE_PATH_NOT_EXPORTED',
        `Package subpath './sub' is not defined by "exports" in /app/node_modules/pkg/package.json imported from /app/a.mjs`,
      ),
    );
    expect(failure?.module).toBe('pkg/sub');
    expect(failure?.importer).toBe('/app/a.mjs');
  });

  it('names the directory of a directory import and its importer', () => {
    const failure = detectModuleLoadFailure(
      coded(
        'ERR_UNSUPPORTED_DIR_IMPORT',
        "Directory import '/app/dir' is not supported resolving ES modules imported from /app/a.mjs",
      ),
    );
    expect(failure?.module).toBe('/app/dir');
    expect(failure?.importer).toBe('/app/a.mjs');
  });

  it('names the file of an unknown extension', () => {
    const failure = detectModuleLoadFailure(
      coded('ERR_UNKNOWN_FILE_EXTENSION', 'Unknown file extension ".xyz" for /app/component.xyz'),
    );
    expect(failure?.module).toBe('/app/component.xyz');
  });

  it('reports a require() of an ES module as a require, with or without a require stack', () => {
    for (const code of ['ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE']) {
      const text = describeModuleLoadFailure(
        coded(code, "require() of ES Module '/app/esm.mjs' not supported"),
      );
      expect(detectModuleLoadFailure(coded(code, 'x'))?.via).toBe('require');
      expect(text).toBeDefined();
    }
  });

  it('does not claim how a module of unknown name was loaded', () => {
    const text = describeModuleLoadFailure(coded('ERR_UNKNOWN_FILE_EXTENSION', 'something odd'));
    expect(text).toBe('Code: ERR_UNKNOWN_FILE_EXTENSION');
  });

  it('elides the payload of a data: or blob: specifier and caps a long one', () => {
    const data = coded(
      'ERR_MODULE_NOT_FOUND',
      "Cannot find module 'data:text/javascript,SECRET' imported from /app/a.mjs",
    );
    expect(describeModuleLoadFailure(data)).toContain('Failed module: data:<elided>');
    expect(describeModuleLoadFailure(data)).not.toContain('SECRET');
    const long = coded(
      'ERR_MODULE_NOT_FOUND',
      `Cannot find module '/${'a'.repeat(1000)}' imported from /app/a.mjs`,
    );
    expect(describeModuleLoadFailure(long)?.split('\n')[0]?.length).toBeLessThan(400);
  });

  it('reads a Windows drive path and a UNC path from a syntax-error header', () => {
    for (const [header, file] of [
      ['C:\\app\\x.js', 'C:\\app\\x.js'],
      ['\\\\server\\share\\x.js', '\\\\server\\share\\x.js'],
    ] as const) {
      const error = new SyntaxError('Unexpected token');
      error.stack = `${header}:3\nconst = 1;\n      ^\n\nSyntaxError: Unexpected token`;
      expect(detectModuleLoadFailure(error)?.position).toEqual({ file, line: 3, column: 7 });
    }
  });

  it('survives a throwing requireStack index and an errors getter that changes its answer', () => {
    const stack = ['/app/a.cjs'];
    Object.defineProperty(stack, '1', {
      get() {
        throw new Error('hostile');
      },
    });
    stack.length = 2;
    const error = coded('MODULE_NOT_FOUND', "Cannot find module './m'");
    Object.assign(error, { requireStack: stack });
    expect(detectModuleLoadFailure(error)?.requireStack).toEqual(['/app/a.cjs']);

    let reads = 0;
    const aggregate = new AggregateError([], 'bundle failed');
    Object.defineProperty(aggregate, 'errors', {
      get() {
        reads += 1;
        if (reads > 1) throw new Error('hostile');
        return [];
      },
    });
    expect(() => detectModuleLoadFailure(aggregate)).not.toThrow();
  });
});

describe('probed Node message shapes (v26)', () => {
  const coded = (code: string, message: string): Error =>
    Object.assign(new Error(message), { code });

  it('a CommonJS require of an unexported subpath names the package and does not claim an import', () => {
    const failure = detectModuleLoadFailure(
      coded(
        'ERR_PACKAGE_PATH_NOT_EXPORTED',
        `Package subpath './sub' is not defined by "exports" in /app/node_modules/@s/pkg/package.json`,
      ),
    );
    expect(failure?.module).toBe('@s/pkg/sub');
    expect(failure?.via).toBeUndefined();
    expect(failure?.importer).toBeUndefined();
    const frames = moduleLoadFrameEnricher(
      coded(
        'ERR_PACKAGE_PATH_NOT_EXPORTED',
        `Package subpath './sub' is not defined by "exports" in /app/node_modules/@s/pkg/package.json`,
      ),
      [],
    );
    expect(frames[0]?.function).toBe('load()');
  });

  it('an unexported subpath from a bare path (no node_modules) names its directory', () => {
    expect(
      detectModuleLoadFailure(
        coded(
          'ERR_PACKAGE_PATH_NOT_EXPORTED',
          'Package subpath \'./x\' is not defined by "exports" in /p/package.json',
        ),
      )?.module,
    ).toBe('/p/x');
  });

  it('require() of an ES module names the module and its requirer', () => {
    const failure = detectModuleLoadFailure(
      coded(
        'ERR_REQUIRE_ESM',
        'require() of ES Module /app/esm.mjs from /app/t.cjs not supported.\nInstead change ...',
      ),
    );
    expect(failure).toMatchObject({
      module: '/app/esm.mjs',
      importer: '/app/t.cjs',
      via: 'require',
    });
  });

  it('require() of an ESM graph with top-level await names the required module', () => {
    const failure = detectModuleLoadFailure(
      coded(
        'ERR_REQUIRE_ASYNC_MODULE',
        'require() cannot be used on an ESM graph with top-level await. Use import() instead.\nRequired module: /app/tla.mjs\nRequire stack:\n- /app/t.cjs',
      ),
    );
    expect(failure).toMatchObject({ module: '/app/tla.mjs', via: 'require' });
  });

  it('an undefined package import names the specifier and its importer', () => {
    const failure = detectModuleLoadFailure(
      coded(
        'ERR_PACKAGE_IMPORT_NOT_DEFINED',
        'Package import specifier "#nope" is not defined in package /app/package.json imported from /app/t.cjs',
      ),
    );
    expect(failure).toMatchObject({ module: '#nope', importer: '/app/t.cjs' });
    // the CommonJS loader raises this too, so `imported from` does not say it was an import()
    expect(failure?.via).toBeUndefined();
  });

  it('the root of a package with no "exports" main names the package, in ESM and CJS messages', () => {
    const esm = detectModuleLoadFailure(
      coded(
        'ERR_PACKAGE_PATH_NOT_EXPORTED',
        'No "exports" main defined in /app/node_modules/pkg/package.json imported from /app/m.mjs',
      ),
    );
    expect(esm).toMatchObject({ module: 'pkg', importer: '/app/m.mjs' });
    const cjs = detectModuleLoadFailure(
      coded(
        'ERR_PACKAGE_PATH_NOT_EXPORTED',
        'No "exports" main defined in /app/node_modules/pkg/package.json',
      ),
    );
    expect(cjs?.module).toBe('pkg');
  });

  it('reads Windows separators in the package path', () => {
    const failure = detectModuleLoadFailure(
      coded(
        'ERR_PACKAGE_PATH_NOT_EXPORTED',
        'Package subpath \'./sub\' is not defined by "exports" in C:\\app\\node_modules\\@s\\pkg\\package.json',
      ),
    );
    expect(failure?.module).toBe('@s/pkg/sub');
  });

  it('require() of an ES module in a path with spaces still names both paths', () => {
    const failure = detectModuleLoadFailure(
      coded(
        'ERR_REQUIRE_ESM',
        'require() of ES Module /my app/x.mjs from /my app/z.cjs not supported.\nInstead ...',
      ),
    );
    expect(failure).toMatchObject({ module: '/my app/x.mjs', importer: '/my app/z.cjs' });
  });

  it('names the directory of a package that is not under node_modules (a workspace package)', () => {
    const main = detectModuleLoadFailure(
      coded(
        'ERR_PACKAGE_PATH_NOT_EXPORTED',
        'No "exports" main defined in /repo/packages/foo/package.json imported from /repo/a.mjs',
      ),
    );
    expect(main?.module).toBe('/repo/packages/foo');
    const sub = detectModuleLoadFailure(
      coded(
        'ERR_PACKAGE_PATH_NOT_EXPORTED',
        'Package subpath \'./sub\' is not defined by "exports" in /repo/packages/foo/package.json',
      ),
    );
    expect(sub?.module).toBe('/repo/packages/foo/sub');
  });

  it('is not misled by a subpath that contains " in "', () => {
    const failure = detectModuleLoadFailure(
      coded(
        'ERR_PACKAGE_PATH_NOT_EXPORTED',
        'Package subpath \'./a in b/c\' is not defined by "exports" in /r/foo/package.json',
      ),
    );
    expect(failure?.module).toBe('/r/foo/a in b/c');
  });
});

describe('withModuleLoadFrames', () => {
  const missing = () => bunResolve();
  const mark = (file: string) =>
    ({ file, line: 1, column: 1 }) as import('@bugsee/core').StackFrame;

  it('adds the failed module when no other enricher is configured', () => {
    const out = withModuleLoadFrames()(missing(), [], { depth: 0 });
    expect(out).toHaveLength(1);
    expect(out[0]?.file).toContain('nope-dep.mjs');
  });

  it('runs the configured enrichers first, so the failed module ends up ahead of what they produced', () => {
    const seen: number[] = [];
    const configured = (_e: unknown, frames: import('@bugsee/core').StackFrame[]) => {
      seen.push(frames.length);
      return [...frames, mark('locals.js')];
    };
    const out = withModuleLoadFrames(configured)(missing(), [], { depth: 0 });
    expect(seen).toEqual([0]); // the configured enricher saw the runtime's frames, before the failed module was added
    expect(out.map((f) => f.file)).toEqual([expect.stringContaining('nope-dep.mjs'), 'locals.js']);
  });

  it('leaves an unrelated error as the configured enrichers left it', () => {
    const frames = [mark('app.js')];
    expect(withModuleLoadFrames()(new Error('x'), frames, { depth: 0 })).toBe(frames);
  });
});
