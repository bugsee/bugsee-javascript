// Rollup has no `define`, so the app-identity constants are baked into each rendered chunk here, with a source
// map (a replacement changes the length of a line, and a stale map would point every later column wrong).
//
// Only real READS of a constant are rewritten, found on the chunk's AST (Rollup's own `this.parse`). A lexical
// match would also hit string, template and comment text: `"__BUGSEE_APP_VERSION__"` became `""2.4.1""`, a
// syntax error in the app's production bundle, and a quoted name in the app's data was silently changed.
import MagicString from 'magic-string';

/** The pieces of a rendered chunk Rollup chains: the new code and the map that produced it. */
export interface BakedChunk {
  code: string;
  map: ReturnType<MagicString['generateMap']>;
}

/** Parses a chunk to an ESTree program with `start`/`end` offsets (Rollup's `this.parse`). May throw. */
export type ParseChunk = (code: string) => unknown;

interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const isNode = (value: unknown): value is AstNode =>
  typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';

/** Node types whose every identifier is a name, never a read (`import { X }`, `export { X }`, `new.target`). */
const NAME_ONLY = new Set([
  'ImportSpecifier',
  'ImportDefaultSpecifier',
  'ImportNamespaceSpecifier',
  'ImportAttribute',
  'ExportSpecifier',
  'ExportAllDeclaration',
  'MetaProperty',
]);

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/**
 * Whether `parent[key]` is a BINDING or assignment target (a declared name, a parameter, the left side of an
 * assignment, an update operand): a literal there is a syntax error and the name is not the global anyway.
 */
function isTarget(parent: AstNode, key: string): boolean {
  switch (parent.type) {
    case 'VariableDeclarator':
    case 'ClassDeclaration':
    case 'ClassExpression':
      return key === 'id';
    case 'CatchClause':
      return key === 'param';
    case 'AssignmentExpression':
    case 'AssignmentPattern':
    case 'ForInStatement':
    case 'ForOfStatement':
      return key === 'left';
    case 'UpdateExpression':
      return key === 'argument';
    default:
      return FUNCTIONS.has(parent.type) && (key === 'id' || key === 'params');
  }
}

/**
 * Collect every Identifier that READS one of `names`, as `[start, end, shorthand]`. `binding` is true inside a
 * declaration or assignment target, where only a default value or a computed key is a read again.
 */
function collectReads(
  node: AstNode,
  names: ReadonlySet<string>,
  binding: boolean,
  out: Array<{ start: number; end: number; name: string; shorthand: boolean }>,
): void {
  if (NAME_ONLY.has(node.type)) {
    return;
  }
  if (node.type === 'Identifier') {
    if (!binding && names.has(node.name as string)) {
      out.push({ start: node.start, end: node.end, name: node.name as string, shorthand: false });
    }
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    // A statement label (`X: for …`, `break X`) is a name; the labelled body is still code.
    if (key === 'label') {
      continue;
    }
    // A non-computed property name (`o.X`, `{ X: 1 }`, `class { X() {} }`) is a name, not a read.
    if (key === 'key' || key === 'property') {
      if (node.computed !== true) {
        continue;
      }
      visit(value, names, false, out);
      continue;
    }
    if (node.type === 'Property' && node.shorthand === true && key === 'value') {
      // `{ X }` reads X only as an expression; `({ X } = o)` / `const { X } = o` binds it.
      const ident = value as AstNode;
      if (!binding && ident.type === 'Identifier' && names.has(ident.name as string)) {
        out.push({ start: ident.start, end: ident.end, name: ident.name as string, shorthand: true });
        continue;
      }
    }
    // An object/computed member's object, a default value, a computed key: reads again inside a pattern.
    const childBinding =
      isTarget(node, key) ||
      (binding && !(node.type === 'AssignmentPattern' && key === 'right') && node.type !== 'MemberExpression');
    visit(value, names, childBinding, out);
  }
}

function visit(
  value: unknown,
  names: ReadonlySet<string>,
  binding: boolean,
  out: Array<{ start: number; end: number; name: string; shorthand: boolean }>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, names, binding, out);
    }
  } else if (isNode(value)) {
    collectReads(value, names, binding, out);
  }
}

/**
 * Replace each READ of a constant (`__BUGSEE_APP_VERSION__`) with its value expression; a shorthand
 * `{ X }` becomes `{ X: value }`. `null` when there is nothing to replace — including a chunk with no parser
 * or one the parser rejects, which is left exactly as Rollup produced it rather than guessed at — so Rollup
 * keeps the chunk (and its map) untouched.
 */
export function bakeIdentity(
  code: string,
  defines: Record<string, string>,
  parse: ParseChunk | undefined,
): BakedChunk | null {
  const names = new Set(Object.keys(defines).filter((name) => code.includes(name)));
  if (names.size === 0 || parse === undefined) {
    return null;
  }
  let program: unknown;
  try {
    program = parse(code);
  } catch {
    return null;
  }
  const reads: Array<{ start: number; end: number; name: string; shorthand: boolean }> = [];
  visit(program, names, false, reads);
  if (reads.length === 0) {
    return null;
  }
  const out = new MagicString(code);
  for (const { start, end, name, shorthand } of reads) {
    out.overwrite(start, end, shorthand ? `${name}: ${defines[name]}` : (defines[name] as string));
  }
  return { code: out.toString(), map: out.generateMap({ hires: true }) };
}
