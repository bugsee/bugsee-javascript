import { describe, expect, it } from 'vitest';
import {
  describeModuleLoadFailure,
  detectModuleLoadFailure,
  IMPORT_FRAME_FUNCTION,
  moduleLoadFrameEnricher,
  REQUIRE_FRAME_FUNCTION,
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
    expect(describeModuleLoadFailure(bare)).toBe('Loaded via: import\nCode: ERR_REQUIRE_ESM');
    const noCode = bunResolve({ code: undefined });
    expect(describeModuleLoadFailure(noCode)).not.toContain('Code:');
  });

  it('is undefined for any other error', () => {
    expect(describeModuleLoadFailure(new Error('x'))).toBeUndefined();
  });
});
