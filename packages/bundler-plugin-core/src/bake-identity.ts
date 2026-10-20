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

/** Node types whose every identifier is a name, never a read (`import { X }`, `export { X }`, `export * as X`). */
const NAME_ONLY = new Set([
  'ImportSpecifier',
  'ImportDefaultSpecifier',
  'ImportNamespaceSpecifier',
  'ExportSpecifier',
  'ExportAllDeclaration',
]);

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

interface Read {
  start: number;
  end: number;
  name: string;
  shorthand: boolean;
}

interface Walk {
  names: ReadonlySet<string>;
  /** Strict-mode code: a function declared in a block is scoped to that block (no Annex B hoisting). */
  strict: boolean;
  /** Names of the constants bound by each enclosing scope, innermost last; a read bound here is a local. */
  scopes: Array<Set<string>>;
  out: Read[];
}

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
    case 'ForInStatement':
    case 'ForOfStatement':
      return key === 'left';
    case 'UpdateExpression':
      return key === 'argument';
    default:
      return FUNCTIONS.has(parent.type) && (key === 'id' || key === 'params');
  }
}

/** Add to `into` every name in `names` that the binding pattern `pattern` declares (nested, defaulted, rest). */
function patternNames(pattern: unknown, names: ReadonlySet<string>, into: Set<string>): void {
  if (!isNode(pattern)) {
    return;
  }
  switch (pattern.type) {
    case 'Identifier':
      if (names.has(pattern.name as string)) {
        into.add(pattern.name as string);
      }
      return;
    case 'ObjectPattern':
      for (const property of pattern.properties as unknown[]) {
        patternNames(
          isNode(property) && property.type === 'Property' ? property.value : property,
          names,
          into,
        );
      }
      return;
    case 'ArrayPattern':
      for (const element of pattern.elements as unknown[]) {
        patternNames(element, names, into);
      }
      return;
    case 'AssignmentPattern':
      patternNames(pattern.left, names, into);
      return;
    case 'RestElement':
      patternNames(pattern.argument, names, into);
      return;
    default:
  }
}

/** Names declared directly by one statement of a block, module or case list (not hoisted out of nested blocks). */
function declaredBy(statement: unknown, names: ReadonlySet<string>, into: Set<string>): void {
  if (!isNode(statement)) {
    return;
  }
  switch (statement.type) {
    case 'VariableDeclaration':
      for (const declarator of statement.declarations as AstNode[]) {
        patternNames(declarator.id, names, into);
      }
      return;
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      patternNames(statement.id, names, into);
      return;
    case 'ImportDeclaration':
      for (const specifier of statement.specifiers as AstNode[]) {
        patternNames(specifier.local, names, into);
      }
      return;
    case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration':
      declaredBy(statement.declaration, names, into);
      return;
    default:
  }
}

/**
 * `var` declarations hoist to the enclosing function. In SLOPPY code (Annex B) a function declared inside a
 * block is also function-scoped, so it is collected through nested blocks too; in strict code (ES modules, and
 * the `use strict` Rollup emits for cjs/iife/umd) it stays in its block. Never into nested functions.
 */
function hoisted(node: unknown, walk: Walk, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      hoisted(item, walk, into);
    }
    return;
  }
  if (!isNode(node)) {
    return;
  }
  if (node.type === 'FunctionDeclaration') {
    if (!walk.strict) {
      patternNames(node.id, walk.names, into);
    }
    return;
  }
  if (FUNCTIONS.has(node.type) || node.type === 'ClassBody') {
    return;
  }
  if (node.type === 'VariableDeclaration' && node.kind === 'var') {
    declaredBy(node, walk.names, into);
  }
  for (const value of Object.values(node)) {
    hoisted(value, walk, into);
  }
}

/**
 * The scopes a node opens: `own` covers all its children (for a function: its parameters), `body` (functions
 * only) is a SEPARATE scope for the body, because a default value cannot see the body's `var`s.
 */
function scopesOf(
  node: AstNode,
  walk: Walk,
): { own: Set<string>; body?: Set<string>; only?: string } | undefined {
  const names = walk.names;
  const own = new Set<string>();
  switch (node.type) {
    case 'Program':
    case 'StaticBlock':
      for (const statement of node.body as unknown[]) {
        declaredBy(statement, names, own);
      }
      hoisted(node.body, walk, own);
      return { own };
    case 'BlockStatement':
      for (const statement of node.body as unknown[]) {
        declaredBy(statement, names, own);
      }
      return { own };
    case 'SwitchStatement':
      for (const switchCase of node.cases as AstNode[]) {
        for (const statement of switchCase.consequent as unknown[]) {
          declaredBy(statement, names, own);
        }
      }
      // The discriminant is evaluated outside the case block.
      return { own, only: 'cases' };
    case 'ForStatement':
      declaredBy(node.init, names, own);
      return { own };
    case 'ForInStatement':
    case 'ForOfStatement':
      declaredBy(node.left, names, own);
      return { own };
    case 'CatchClause':
      patternNames(node.param, names, own);
      return { own };
    case 'ClassExpression':
      patternNames(node.id, names, own);
      return { own };
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const params = node.params as AstNode[];
      for (const param of params) {
        patternNames(param, names, own);
      }
      if (node.type === 'FunctionExpression') {
        patternNames(node.id, names, own);
      }
      // The body's own `var`s and (sloppy) functions: a scope of their own, so a default value cannot see them.
      // With simple parameters the two scopes would be one; resolving through both stacked gives the same answer.
      const body = new Set<string>();
      hoisted(node.body, walk, body);
      return { own, body };
    }
    default:
      return undefined;
  }
}

/**
 * Collect every Identifier that READS one of `names` as a GLOBAL, as `[start, end, shorthand]`. `binding` is
 * true inside a declaration or assignment target, where only a default value or a computed key is a read
 * again. A read that resolves to a local binding of the same name (a parameter, `var`/`let`/`const`, a
 * function, class, import or catch parameter in an enclosing scope) is the app's own variable, not ours.
 */
function collectReads(node: AstNode, walk: Walk, binding: boolean): void {
  if (NAME_ONLY.has(node.type)) {
    return;
  }
  const bound = (name: string): boolean => walk.scopes.some((scope) => scope.has(name));
  if (node.type === 'Identifier') {
    if (!binding && walk.names.has(node.name as string) && !bound(node.name as string)) {
      walk.out.push({
        start: node.start,
        end: node.end,
        name: node.name as string,
        shorthand: false,
      });
    }
    return;
  }
  const scope = scopesOf(node, walk);
  /** Visit a child with the scopes that apply to that key on the stack. */
  const inScope = (key: string, run: () => void): void => {
    const pushed: Set<string>[] = [];
    if (scope !== undefined && (scope.only === undefined || scope.only === key)) {
      pushed.push(scope.own);
    }
    if (scope?.body !== undefined && key === 'body') {
      pushed.push(scope.body);
    }
    walk.scopes.push(...pushed);
    run();
    walk.scopes.length -= pushed.length;
  };
  for (const [key, value] of Object.entries(node)) {
    // A statement label (`X: for …`, `break X`) is a name; the labelled body is still code.
    if (key === 'label') {
      continue;
    }
    // A non-computed property name (`o.X`, `{ X: 1 }`, `class { X() {} }`) is a name, not a read.
    if (key === 'key' || key === 'property') {
      if (node.computed === true) {
        // (No node that opens a scope has a `key`/`property`, so the stack is already right here.)
        visit(value, walk, false);
      }
      continue;
    }
    if (node.type === 'Property' && node.shorthand === true && key === 'value') {
      // `{ X }` reads X only as an expression; `({ X } = o)` / `const { X } = o` binds it.
      const ident = value as AstNode;
      if (!binding && ident.type === 'Identifier' && walk.names.has(ident.name as string)) {
        if (!bound(ident.name as string)) {
          walk.out.push({
            start: ident.start,
            end: ident.end,
            name: ident.name as string,
            shorthand: true,
          });
        }
        continue;
      }
    }
    // An object/computed member's object, a default value, a computed key: reads again inside a pattern.
    const childBinding =
      isTarget(node, key) ||
      (binding &&
        !(node.type === 'AssignmentPattern' && key === 'right') &&
        node.type !== 'MemberExpression');
    inScope(key, () => visit(value, walk, childBinding));
  }
}

function visit(value: unknown, walk: Walk, binding: boolean): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, walk, binding);
    }
  } else if (isNode(value)) {
    collectReads(value, walk, binding);
  }
}

/**
 * Replace each READ of a constant (`__BUGSEE_APP_VERSION__`) with its value expression; a shorthand
 * `{ X }` becomes `{ X: value }`. `null` when there is nothing to replace — including a chunk with no parser
 * or one the parser rejects, which is left exactly as Rollup produced it rather than guessed at — so Rollup
 * keeps the chunk (and its map) untouched. `onSkipped` is told why when a chunk that mentions a constant could
 * not be examined, so the caller can say the identity was not baked instead of failing silently. `strict` is
 * whether the chunk is strict-mode code (default: sloppy, which binds more names and so bakes fewer reads).
 */
export function bakeIdentity(
  code: string,
  defines: Record<string, string>,
  parse: ParseChunk | undefined,
  onSkipped?: (reason: string) => void,
  strict = false,
): BakedChunk | null {
  const names = new Set(Object.keys(defines).filter((name) => code.includes(name)));
  if (names.size === 0) {
    return null;
  }
  if (parse === undefined) {
    onSkipped?.('the bundler gave the plugin no parser');
    return null;
  }
  let program: unknown;
  try {
    program = parse(code);
  } catch (error) {
    onSkipped?.(
      `the chunk could not be parsed (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
  const walk: Walk = { names, strict, scopes: [], out: [] };
  try {
    visit(program, walk, false);
  } catch (error) {
    // A pathologically deep chunk overflows the recursive walk (RangeError): skip it, never fail the build.
    onSkipped?.(
      `the chunk could not be walked (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
  if (walk.out.length === 0) {
    return null;
  }
  const out = new MagicString(code);
  for (const { start, end, name, shorthand } of walk.out) {
    out.overwrite(start, end, shorthand ? `${name}: ${defines[name]}` : (defines[name] as string));
  }
  return { code: out.toString(), map: out.generateMap({ hires: true }) };
}
