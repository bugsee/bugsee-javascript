import { fileURLToPath } from 'node:url';
import type { FrameEnricher, StackFrame } from '@bugsee/core';
import { parseLocation } from '@bugsee/core';

// Context for an error raised while LOADING a module, so the report names what failed instead of "Error at node:internal/...".
//
// What each runtime hands over (probed on node 26 and bun 1.4):
//  - Node, ESM and CJS resolution failures (`ERR_MODULE_NOT_FOUND`, `MODULE_NOT_FOUND`, `ERR_UNSUPPORTED_DIR_IMPORT`,
//    `ERR_PACKAGE_PATH_NOT_EXPORTED`, ...): a stack made of loader internals. The module and its importer live in the message, plus
//    `url` (ESM) or `requireStack` (CJS) as properties.
//  - Node, a SyntaxError in an imported module: loader internals only. The file and line are in the stack HEADER, above the error
//    line (`file:///app/x.mjs:1`, the source line, a caret line), where no frame parser looks.
//  - Bun, resolution failures: a `ResolveMessage` with NO stack at all, but `specifier`, `referrer`, `importKind` and `code` as
//    properties. A syntax error is an `AggregateError` with no stack whose `errors[]` carry `position.file/line/column`.
// Best-effort and pure reads: every property read goes through `prop`, which contains a throwing getter, and nothing is invented
// that the error does not say.

/** The frame function of a module that failed to resolve or load. */
export const IMPORT_FRAME_FUNCTION = 'import()';
/** The frame function when the failure does not say whether it was an `import()` or a `require()`. */
export const LOAD_FRAME_FUNCTION = 'load()';
/** The frame function when the failing load was a `require()` (CommonJS). */
export const REQUIRE_FRAME_FUNCTION = 'require()';

const FAILED_RESOLUTION_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_PACKAGE_IMPORT_NOT_DEFINED',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_REQUIRE_ESM',
  'ERR_REQUIRE_ASYNC_MODULE',
]);

// The message shapes Node uses. Each is anchored on a fixed prefix and uses no nested or lazy repetition, so none can backtrack
// badly on a hostile message.
// `Cannot find module '/abs/x.mjs' imported from /abs/y.mjs`, `Cannot find package 'p' imported from ...`.
const NOT_FOUND = /Cannot find (?:module|package) '([^']+)'/;
// `Directory import '/abs/dir' is not supported resolving ES modules imported from /abs/y.mjs`
const DIR_IMPORT = /^Directory import '([^']+)'/;
// `Package subpath './sub' is not defined by "exports" in /abs/node_modules/pkg/package.json imported from /abs/y.mjs`
const NOT_EXPORTED = /^Package subpath '([^']+)'/;
// The package a `package.json` path in the message belongs to: `/app/node_modules/@scope/pkg/package.json` -> `@scope/pkg`.
// Either separator: on Windows the path is `C:\app\node_modules\@scope\pkg\package.json`.
const PACKAGE_OF_JSON = /node_modules[\\/]((?:@[^\\/\n]+[\\/])?[^\\/\n]+)[\\/]package\.json/;
// `No \"exports\" main defined in /app/node_modules/pkg/package.json [imported from ...]`: the package root, with no subpath.
// A package that is not under `node_modules` (a symlinked workspace package resolves to its real path): its directory.
const PACKAGE_DIR = /(?:"exports"|main defined) in ([^\n]*?)[\\/]package\.json/;
const NO_EXPORTS_MAIN = /^No "exports" main defined in /;
// `Package import specifier "#x" is not defined in package /app/package.json imported from /app/y.mjs`
const IMPORT_NOT_DEFINED = /^Package import specifier "([^"]+)"/;
// `require() of ES Module /app/esm.mjs from /app/y.js not supported.`
// Lazy but anchored and bounded by `[^\n]`, so a path with a space still matches and nothing backtracks badly.
const REQUIRE_ESM = /^require\(\) of ES Module ([^\n]+?) from ([^\n]+?) not supported/;
// `require() cannot be used on an ESM graph with top-level await. ...\nRequired module: /app/tla.mjs`
const REQUIRED_MODULE = /^Required module: ([^\n]+)/m;
// `Unknown file extension ".xyz" for /abs/component.xyz`
const UNKNOWN_EXTENSION = /^Unknown file extension "[^"]*" for ([^\n]+)/;
// the importer, wherever the message names it
const IMPORTED_FROM = / imported from ([^\n]+)/;
// Longest specifier or path shipped in a frame or description line: a `data:` URL can be kilobytes of inline source.
const MAX_SPECIFIER = 300;
// Bun's stackless SyntaxError for a missing named export: `Export named 'x' not found in module '/abs/y.mjs'.`
const BUN_MISSING_EXPORT = /^Export named '([^']+)' not found in module '([^']+)'\.?$/;
// Node's SyntaxError header: `<file>:<line>` / the source line / the caret line.
// The file is a POSIX path, a `file://` URL, a Windows drive path (`C:\app\x.js`) or a UNC path (`\\server\share\x.js`).
const SYNTAX_HEADER = /^((?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/)[^\n]*?):(\d+)\n[^\n]*\n( *)\^/;

export interface ModuleLoadFailure {
  /** What failed: a SyntaxError found in a module's source, or a module that could not be resolved/loaded. */
  kind: 'resolution' | 'syntax';
  /** The module that could not be found or loaded (file path, or the bare specifier). */
  module?: string;
  /** The module that asked for it. */
  importer?: string;
  /** Node's / Bun's error code (`ERR_MODULE_NOT_FOUND`). */
  code?: string;
  /** `import` or `require`: how the load was requested; undefined when nothing in the error says. */
  via?: 'import' | 'require';
  /** CommonJS `require()` chain, innermost first. */
  requireStack: string[];
  /** A named export the module does not provide (`import { x } from './m'`). */
  missingExport?: string;
  /** The source position of a syntax error. */
  position?: { file: string; line: number; column?: number };
}

function prop(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function str(value: unknown, key: string): string | undefined {
  const v = prop(value, key);
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** `file:///a/b.mjs` -> `/a/b.mjs`; anything else unchanged. */
function toPath(location: string): string {
  if (!location.startsWith('file://')) return location;
  try {
    return fileURLToPath(location);
  } catch {
    return location.slice('file://'.length);
  }
}

/** The package a `package.json` path in the message belongs to: its name under `node_modules`, else its directory. */
function packageOf(message: string): string | undefined {
  const named = PACKAGE_OF_JSON.exec(message);
  if (named !== null) return slashed(named[1] as string);
  const dir = PACKAGE_DIR.exec(message)?.[1];
  return dir === undefined || dir === '' ? undefined : slashed(dir);
}

/** A package name with the platform separator normalized to `/`. */
function slashed(name: string): string {
  return name.replace(/\\/g, '/');
}

/** The array's strings, each element read through `prop` so a throwing index getter costs that element, not the report. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = prop(value, String(i));
    if (typeof entry === 'string') out.push(entry);
  }
  return out;
}

function objectList(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) out.push(prop(value, String(i)));
  return out;
}

function syntaxPosition(value: unknown): ModuleLoadFailure['position'] | undefined {
  // Bun: the build error itself, or the first of an AggregateError's `errors`.
  const candidates = [value, ...objectList(prop(value, 'errors'))];
  for (const candidate of candidates) {
    const position = prop(candidate, 'position');
    const file = str(position, 'file');
    const line = prop(position, 'line');
    if (file !== undefined && typeof line === 'number') {
      const column = prop(position, 'column');
      return { file, line, ...(typeof column === 'number' ? { column } : {}) };
    }
  }
  // Node: the header of the stack.
  const stack = str(value, 'stack');
  const header = stack === undefined ? null : SYNTAX_HEADER.exec(stack);
  if (header !== null) {
    return {
      file: toPath(header[1] as string),
      line: Number(header[2]),
      column: (header[3] as string).length + 1,
    };
  }
  return undefined;
}

/** Describe a module-load error, or undefined when `value` is not one. */
export function detectModuleLoadFailure(value: unknown): ModuleLoadFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const name = str(value, 'name');
  const code = str(value, 'code');
  const message = str(value, 'message') ?? '';

  if (name === 'SyntaxError' || name === 'AggregateError' || name === 'BuildMessage') {
    const position = syntaxPosition(value);
    const missing = BUN_MISSING_EXPORT.exec(message);
    if (position === undefined && missing !== null) {
      return {
        kind: 'resolution',
        via: 'import',
        requireStack: [],
        module: missing[2] as string,
        missingExport: missing[1] as string,
      };
    }
    // An AggregateError that is not a build error carries no position, so it is not ours.
    return position === undefined
      ? undefined
      : { kind: 'syntax', via: 'import', requireStack: [], position };
  }

  const isBunResolve = name === 'ResolveMessage';
  if (!isBunResolve && (code === undefined || !FAILED_RESOLUTION_CODES.has(code))) return undefined;

  const requireStack = stringList(prop(value, 'requireStack'));
  const url = str(value, 'url');
  const requireEsm = REQUIRE_ESM.exec(message);
  const exported = NOT_EXPORTED.exec(message);
  let exportedModule: string | undefined;
  if (exported !== null || NO_EXPORTS_MAIN.test(message)) {
    const pkg = packageOf(message);
    const subpath = exported === null ? undefined : (exported[1] as string).replace(/^\.\//, '');
    // The package name when it sits in `node_modules`, else its directory; the bare subpath only when nothing names the package.
    exportedModule =
      pkg === undefined ? exported?.[1] : subpath === undefined ? pkg : `${pkg}/${subpath}`;
  }
  const module =
    str(value, 'specifier') ??
    (url !== undefined ? toPath(url) : undefined) ??
    exportedModule ??
    (NOT_FOUND.exec(message) ??
      DIR_IMPORT.exec(message) ??
      IMPORT_NOT_DEFINED.exec(message) ??
      UNKNOWN_EXTENSION.exec(message) ??
      REQUIRED_MODULE.exec(message) ??
      requireEsm)?.[1];
  const importedFrom = IMPORTED_FROM.exec(message)?.[1];
  const importer = str(value, 'referrer') ?? importedFrom ?? requireEsm?.[2] ?? requireStack[0];
  const importKind = str(value, 'importKind');
  // Said only on evidence. `require()` of an ES module raises these two codes (no require stack on them); an ESM loader error
  // carries a `url`, an `imported from` clause or Bun's `importKind`. A CommonJS `require('pkg/sub')` blocked by `exports` has
  // none of these, so it stays unknown.
  const viaRequire =
    requireStack.length > 0 ||
    importKind === 'require-call' ||
    code === 'ERR_REQUIRE_ESM' ||
    code === 'ERR_REQUIRE_ASYNC_MODULE';
  // `imported from` does not settle it for the two errors the CommonJS loader shares with the ESM resolver.
  const sharedResolver =
    code === 'ERR_PACKAGE_IMPORT_NOT_DEFINED' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
  const viaImport =
    importKind !== undefined ||
    url !== undefined ||
    (importedFrom !== undefined && !sharedResolver) ||
    isBunResolve;
  const via = viaRequire ? 'require' : viaImport ? 'import' : undefined;
  return {
    kind: 'resolution',
    ...(via !== undefined ? { via } : {}),
    requireStack,
    ...(module !== undefined ? { module } : {}),
    ...(importer !== undefined ? { importer } : {}),
    ...(code !== undefined ? { code } : {}),
  };
}

function scrub(path: string): string {
  // A `data:` / `blob:` specifier IS its payload (inline source, possibly a secret): keep the scheme, drop the rest.
  const inline = /^(data|blob):/i.exec(path);
  if (inline !== null) return `${(inline[1] as string).toLowerCase()}:<elided>`;
  const file = parseLocation(path).file ?? path;
  return file.length > MAX_SPECIFIER ? `${file.slice(0, MAX_SPECIFIER)}...` : file;
}

/** The frame that stands for the failed load, placed at the top of the stack so the report names it. */
function failureFrame(failure: ModuleLoadFailure): StackFrame | undefined {
  const position = failure.position;
  if (position !== undefined) {
    const frame = parseLocation(position.file);
    frame.line = position.line;
    if (position.column !== undefined) frame.column = position.column;
    return frame;
  }
  if (failure.module === undefined) return undefined;
  return {
    function:
      failure.via === 'require'
        ? REQUIRE_FRAME_FUNCTION
        : failure.via === 'import'
          ? IMPORT_FRAME_FUNCTION
          : LOAD_FRAME_FUNCTION,
    file: scrub(failure.module),
  };
}

/**
 * A frame enricher that puts the failed module (or the syntax error's position) FIRST. The frames the runtime did give are kept
 * after it: they are loader internals, but they are the only stack there is, and a frame that is already first is not repeated.
 */
export const moduleLoadFrameEnricher: FrameEnricher = (error, frames) => {
  const failure = detectModuleLoadFailure(error);
  const added = failure === undefined ? undefined : failureFrame(failure);
  if (added === undefined) return frames;
  const first = frames[0];
  if (first !== undefined && first.file === added.file && first.line === added.line) return frames;
  return [added, ...frames];
};

/**
 * Any frame enrichers the platform configured (locals, source context), then the failed module LAST so it sees the runtime's own
 * frames. The one definition of that order: the uncaught-error providers and the client (`logException`, so every framework
 * adapter's error boundary) both build their enricher with it, so neither path can forget the failed module.
 */
export function withModuleLoadFrames(enrichFrames?: FrameEnricher): FrameEnricher {
  return (error, frames, info) =>
    moduleLoadFrameEnricher(
      error,
      enrichFrames === undefined ? frames : enrichFrames(error, frames, info),
      info,
    );
}

/** Description lines for a module-load error, or undefined when `value` is not one. */
export function describeModuleLoadFailure(value: unknown): string | undefined {
  const failure = detectModuleLoadFailure(value);
  if (failure === undefined) return undefined;
  const lines: string[] = [];
  const position = failure.position;
  if (position !== undefined) {
    const at = `${scrub(position.file)}:${position.line}${position.column !== undefined ? `:${position.column}` : ''}`;
    lines.push(`Syntax error in module: ${at}`);
  } else {
    if (failure.module !== undefined) lines.push(`Failed module: ${scrub(failure.module)}`);
    if (failure.importer !== undefined) lines.push(`Imported from: ${scrub(failure.importer)}`);
    // Only said when the load is known: with no module and no stack to go on, a default would be a guess.
    if (failure.via !== undefined) {
      lines.push(`Loaded via: ${failure.via === 'require' ? 'require()' : 'import'}`);
    }
    if (failure.missingExport !== undefined) lines.push(`Missing export: ${failure.missingExport}`);
    if (failure.code !== undefined) lines.push(`Code: ${failure.code}`);
    if (failure.requireStack.length > 0) {
      lines.push('Require stack:');
      for (const entry of failure.requireStack) lines.push(`  ${scrub(entry)}`);
    }
  }
  return lines.join('\n');
}
