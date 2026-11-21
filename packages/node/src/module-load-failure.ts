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
/** The frame function when the failing load was a `require()` (CommonJS). */
export const REQUIRE_FRAME_FUNCTION = 'require()';

const FAILED_RESOLUTION_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_PACKAGE_IMPORT_NOT_DEFINED',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_INVALID_MODULE_SPECIFIER',
  'ERR_REQUIRE_ESM',
  'ERR_REQUIRE_ASYNC_MODULE',
]);

// `Cannot find module '/abs/x.mjs' imported from /abs/y.mjs`, `Cannot find package 'p' imported from ...`.
const NOT_FOUND = /Cannot find (?:module|package) '([^']+)'(?: imported from (.+?))?$/m;
// Bun's stackless SyntaxError for a missing named export: `Export named 'x' not found in module '/abs/y.mjs'.`
const BUN_MISSING_EXPORT = /^Export named '([^']+)' not found in module '([^']+)'\.?$/;
// Node's SyntaxError header: `<file>:<line>` / the source line / the caret line.
const SYNTAX_HEADER = /^((?:file:\/\/)?\/[^\n]*?):(\d+)\n[^\n]*\n( *)\^/;

export interface ModuleLoadFailure {
  /** What failed: a SyntaxError found in a module's source, or a module that could not be resolved/loaded. */
  kind: 'resolution' | 'syntax';
  /** The module that could not be found or loaded (file path, or the bare specifier). */
  module?: string;
  /** The module that asked for it. */
  importer?: string;
  /** Node's / Bun's error code (`ERR_MODULE_NOT_FOUND`). */
  code?: string;
  /** `import` or `require`: how the load was requested. */
  via: 'import' | 'require';
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
    return decodeURIComponent(new URL(location).pathname);
  } catch {
    return location.slice('file://'.length);
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function syntaxPosition(value: unknown): ModuleLoadFailure['position'] | undefined {
  // Bun: the build error itself, or the first of an AggregateError's `errors`.
  const candidates = [
    value,
    ...(Array.isArray(prop(value, 'errors')) ? (prop(value, 'errors') as unknown[]) : []),
  ];
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
  const found = NOT_FOUND.exec(message);
  const url = str(value, 'url');
  const module =
    str(value, 'specifier') ?? (url !== undefined ? toPath(url) : undefined) ?? found?.[1];
  const importer = str(value, 'referrer') ?? found?.[2] ?? requireStack[0];
  const importKind = str(value, 'importKind');
  const viaRequire = requireStack.length > 0 || importKind === 'require-call';
  return {
    kind: 'resolution',
    via: viaRequire ? 'require' : 'import',
    requireStack,
    ...(module !== undefined ? { module } : {}),
    ...(importer !== undefined ? { importer } : {}),
    ...(code !== undefined ? { code } : {}),
  };
}

function scrub(path: string): string {
  return parseLocation(path).file ?? path;
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
    function: failure.via === 'require' ? REQUIRE_FRAME_FUNCTION : IMPORT_FRAME_FUNCTION,
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
    lines.push(`Loaded via: ${failure.via === 'require' ? 'require()' : 'import'}`);
    if (failure.missingExport !== undefined) lines.push(`Missing export: ${failure.missingExport}`);
    if (failure.code !== undefined) lines.push(`Code: ${failure.code}`);
    if (failure.requireStack.length > 0) {
      lines.push('Require stack:');
      for (const entry of failure.requireStack) lines.push(`  ${scrub(entry)}`);
    }
  }
  return lines.join('\n');
}
