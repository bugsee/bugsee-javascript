// Is a bundle a FACADE: no code of its own, only imports and re-exports? Rollup writes `sources: []` and an empty
// `mappings` for such a chunk (a barrel `export { a } from './main.js'`, an empty chunk), and that empty map is correct.
// A chunk with real code and an empty map is a stripped one, so the doctor has to tell the two apart by reading the
// bundle: parsed (acorn), and every top-level statement checked against the small language a facade is written in.
// Conservative by construction: anything it cannot positively read as that language is real code.
import { parse } from 'acorn';

/** The global the runtime stub writes the id into: the stamp's registration statement carries it. */
const REGISTRATION = '_bugseeDebugIds';

type Node = { type: string } & Record<string, unknown>;
const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
const node = (parent: Node, key: string): Node | undefined => {
  const child = parent[key];
  return isNode(child) ? child : undefined;
};
const nodes = (parent: Node, key: string): Node[] => {
  const list = parent[key];
  return Array.isArray(list) ? list.filter(isNode) : [];
};
const name = (n: Node | undefined): string | undefined =>
  n?.type === 'Identifier' ? (n.name as string) : undefined;
const literalString = (n: Node | undefined): boolean =>
  n?.type === 'Literal' && typeof n.value === 'string';
const isFunction = (n: Node | undefined): boolean =>
  n?.type === 'FunctionExpression' || n?.type === 'ArrowFunctionExpression';

/** Rollup's interop helpers: `_interopDefault`, `_interopNamespaceDefault`, `_interopNamespace`, ... */
const HELPER_NAME = /^_interop[A-Za-z]*$/;
/** `Object.<name>(...)` calls a re-export block makes (a regular expression: the drift test reads string literals). */
const OBJECT_CALL =
  /^(?:keys|defineProperty|defineProperties|getOwnPropertyDescriptor|create|freeze)$/;

/** What an interop helper's body mentions: `__esModule`, the namespace object it builds, or `'default' in e` (`compat`). */
const INTEROP_SHAPE = /__esModule|Object\.(?:create|freeze)\(|["']default["']\s*in\b/;

/** How deep the walk goes before it gives up ("not a facade"): a hostile chain must not exhaust the stack. */
const MAX_DEPTH = 64;
let depth = 0;
/** The variables of the functions being walked (params and declarations): a helper may write to those only. */
let scopes: Array<Set<string>> = [];
/** Inside a SystemJS setter: the factory's export callback, the one name whose calls are the module system's own. */
let systemExport: string | undefined;
/** What a wrapper's factory calls its `exports` parameter (terser renames it to `e`): writes to it are export writes. */
let exportAlias: string | undefined;
/**
 * The lexical scopes of the facade being read, innermost last: the helper functions declared in a scope (Rollup's interop
 * helpers, however a minifier renamed them) and every other name bound there (imports, variables, parameters, a name
 * declared twice). A call is a helper call only when the name RESOLVES to a helper: the nearest scope that binds it
 * declares it as one.
 */
type HelperScope = { helpers: Set<string>; bound: Set<string> };
let helperScopes: HelperScope[] = [];
/** The bundle text, for the one textual question the grammar asks (is this function interop-shaped). */
let source = '';

const reset = (): void => {
  depth = 0;
  scopes = [];
  systemExport = undefined;
  exportAlias = undefined;
  helperScopes = [];
  source = '';
};

/** Runs `fn` one level deeper, or gives up ("not a facade") past the cap. */
function bounded(fn: () => boolean): boolean {
  if (depth >= MAX_DEPTH) {
    return false;
  }
  depth++;
  try {
    return fn();
  } finally {
    depth--;
  }
}

/** `Object.prototype.hasOwnProperty.call`, as Rollup's `export *` loop writes it. */
function isHasOwnCall(callee: Node): boolean {
  const target = node(callee, 'object');
  const proto = target && node(target, 'object');
  return (
    name(node(callee, 'property')) === 'call' &&
    target?.type === 'MemberExpression' &&
    name(node(target, 'property')) === 'hasOwnProperty' &&
    proto?.type === 'MemberExpression' &&
    name(node(proto, 'object')) === 'Object' &&
    name(node(proto, 'property')) === 'prototype'
  );
}

/** `Object.keys(...)` with pure arguments: the only receiver a `forEach` re-export loop has. */
function isObjectKeysCall(n: Node | undefined): boolean {
  const callee = n?.type === 'CallExpression' ? node(n, 'callee') : undefined;
  return (
    callee?.type === 'MemberExpression' &&
    callee.computed !== true &&
    name(node(callee, 'object')) === 'Object' &&
    name(node(callee, 'property')) === 'keys' &&
    nodes(n as Node, 'arguments').every(pureExpression)
  );
}

/** The names a pattern-free declaration or parameter list binds. */
const declared = (declaration: Node): string[] =>
  nodes(declaration, 'declarations').flatMap((declarator) => name(node(declarator, 'id')) ?? []);

/** A function Rollup writes into a re-export block: plain parameters and a body of re-export statements. */
function pureFunction(fn: Node): boolean {
  const params = nodes(fn, 'params');
  if (
    !params.every((param) => param.type === 'Identifier') ||
    // a binding named like the SystemJS export callback shadows it, at any depth
    params.some((param) => systemExport !== undefined && param.name === systemExport)
  ) {
    return false;
  }
  const body = node(fn, 'body') as Node; // a function always has a body
  // a function EXPRESSION's own name is bound inside it (`(function n(e){ return n(e) })` calls itself, not an outer `n`)
  const own = fn.type === 'FunctionExpression' ? name(node(fn, 'id')) : undefined;
  scopes.push(
    new Set([...params.map((param) => param.name as string), ...(own === undefined ? [] : [own])]),
  );
  try {
    return body.type === 'BlockStatement'
      ? nodes(body, 'body').every(pureStatement)
      : pureExpression(body);
  } finally {
    scopes.pop();
  }
}

function pureCall(call: Node): boolean {
  const callee = node(call, 'callee');
  const args = nodes(call, 'arguments');
  if (callee === undefined) {
    return false;
  }
  const calleeName = name(callee);
  if (calleeName === 'require') {
    return args.length === 1 && literalString(args[0]);
  }
  if (isFunction(callee)) {
    // `(e => e && e.__esModule ? e : { default: e })(require('x'))`: an interop helper applied where it is written
    return (
      args.length === nodes(callee, 'params').length &&
      INTEROP_SHAPE.test(source.slice(callee.start as number, callee.end as number)) &&
      pureFunction(callee) &&
      args.every(pureExpression)
    );
  }
  if (calleeName !== undefined && calleeName === systemExport) {
    return args.every(pureExpression);
  }
  if (calleeName !== undefined) {
    return isHelper(calleeName) && args.every(pureExpression);
  }
  if (callee.type !== 'MemberExpression' || callee.computed === true) {
    return false;
  }
  const property = name(node(callee, 'property'));
  if (
    name(node(callee, 'object')) === 'Object' &&
    property !== undefined &&
    OBJECT_CALL.test(property)
  ) {
    return args.every(pureExpression);
  }
  if (isHasOwnCall(callee)) {
    return args.every(pureExpression);
  }
  if (property === 'forEach') {
    const callback = args[0];
    return (
      isObjectKeysCall(node(callee, 'object')) &&
      args.length === 1 &&
      callback !== undefined &&
      isFunction(callback) &&
      pureFunction(callback)
    );
  }
  return false;
}

/** The computed keys along a member chain are code too: `exports[track()]` calls `track`. */
function chainPure(target: Node | undefined): boolean {
  let current = target;
  while (current?.type === 'MemberExpression') {
    if (current.computed === true && !pureExpression(node(current, 'property'))) {
      return false;
    }
    current = node(current, 'object');
  }
  return true;
}

/** The identifier a member chain starts from (`acc` in `acc.x[k]`). */
function chainRoot(target: Node | undefined): string | undefined {
  let current = target;
  while (current?.type === 'MemberExpression') {
    current = node(current, 'object');
  }
  return name(current);
}

/** `exports.a`, `exports['a']`, `exports.a.b`, `module.exports`, `module.exports.a`: where a CommonJS facade writes. */
function isExportTarget(target: Node | undefined): boolean {
  const isModuleExports = (n: Node): boolean =>
    n.computed !== true &&
    name(node(n, 'object')) === 'module' &&
    name(node(n, 'property')) === 'exports';
  let current = target;
  while (current?.type === 'MemberExpression') {
    if (isModuleExports(current)) {
      return chainPure(target);
    }
    current = node(current, 'object');
    const root = name(current);
    if (root !== undefined && (root === 'exports' || root === exportAlias)) {
      return chainPure(target);
    }
  }
  return false;
}

/** An assignment inside a helper: to its own variables (a parameter, a `var`, an accumulator's member) or an export. */
function localAssignmentTarget(target: Node | undefined): boolean {
  if (target?.type === 'Identifier') {
    return scopes.some((scope) => scope.has(target.name as string));
  }
  if (target?.type !== 'MemberExpression') {
    return false;
  }
  const root = chainRoot(target);
  return (
    chainPure(target) &&
    ((root !== undefined && scopes.some((scope) => scope.has(root))) || isExportTarget(target))
  );
}

/** The expressions a re-export is written with: references, literals, whitelisted calls, getters. */
function pureExpression(expression: Node | undefined): boolean {
  return bounded(() => pureExpressionNode(expression));
}

function pureExpressionNode(expression: Node | undefined): boolean {
  switch (expression?.type) {
    case 'Identifier':
    case 'Literal':
      return true;
    case 'MemberExpression':
      return (
        pureExpression(node(expression, 'object')) &&
        (expression.computed !== true || pureExpression(node(expression, 'property')))
      );
    case 'UnaryExpression':
      return pureExpression(node(expression, 'argument'));
    case 'BinaryExpression':
    case 'LogicalExpression':
      return pureExpression(node(expression, 'left')) && pureExpression(node(expression, 'right'));
    case 'ConditionalExpression':
      return (
        pureExpression(node(expression, 'test')) &&
        pureExpression(node(expression, 'consequent')) &&
        pureExpression(node(expression, 'alternate'))
      );
    case 'SequenceExpression':
      // terser joins statements with commas: `return e && f(e), r.default = e, Object.freeze(r)`
      return nodes(expression, 'expressions').every(pureExpression);
    case 'AssignmentExpression':
      // only inside a helper, and only to its own variables or the exports: a top-level write is `facadeExpression`'s
      return (
        scopes.length > 0 &&
        expression.operator === '=' &&
        localAssignmentTarget(node(expression, 'left')) &&
        pureExpression(node(expression, 'right'))
      );
    case 'ObjectExpression':
      return nodes(expression, 'properties').every((property) => {
        const value = node(property, 'value');
        const isGetter =
          name(node(property, 'key')) === 'get' &&
          value !== undefined &&
          isFunction(value) &&
          pureFunction(value);
        return (
          property.type === 'Property' &&
          (property.computed !== true || pureExpression(node(property, 'key'))) &&
          (isGetter || pureExpression(value))
        );
      });
    case 'CallExpression':
      return pureCall(expression);
    default:
      return false;
  }
}

function pureStatement(statement: Node): boolean {
  return bounded(() => pureStatementNode(statement));
}

function pureStatementNode(statement: Node): boolean {
  switch (statement.type) {
    case 'EmptyStatement':
      return true;
    case 'ExpressionStatement':
      return pureExpression(node(statement, 'expression'));
    case 'ReturnStatement':
      return statement.argument === null || pureExpression(node(statement, 'argument'));
    case 'IfStatement': {
      const consequent = node(statement, 'consequent');
      const alternate = node(statement, 'alternate');
      return (
        pureExpression(node(statement, 'test')) &&
        consequent !== undefined &&
        pureStatement(consequent) &&
        (alternate === undefined || pureStatement(alternate))
      );
    }
    case 'ForInStatement': {
      // Rollup's es2015 interop helper: `for (const k in e) { ... }`; the left side is a plain binding, never a pattern
      const left = node(statement, 'left') as Node;
      const isBinding =
        left.type === 'Identifier' ||
        (left.type === 'VariableDeclaration' &&
          nodes(left, 'declarations').every(
            (declarator) => node(declarator, 'id')?.type === 'Identifier',
          ));
      const bodyStatement = node(statement, 'body') as Node;
      if (
        left.type === 'Identifier' &&
        (left.name === systemExport || !scopes.some((scope) => scope.has(left.name as string)))
      ) {
        return false; // a bare loop target is a write: to the export callback, or to something that is not a local
      }
      let shadowed = false;
      if (left.type === 'VariableDeclaration') {
        const scope = scopes.at(-1);
        for (const bound of declared(left)) {
          if (bound === systemExport) {
            // block-scoped to the loop (terser reuses the callback's name for `for (const t in e)`): fine in `var`-free
            // form, but inside the loop that name is NOT the callback, so no call of it counts there
            if (left.kind === 'var') {
              return false;
            }
            shadowed = true;
          }
          scope?.add(bound);
        }
      }
      if (!isBinding || !pureExpression(node(statement, 'right'))) {
        return false;
      }
      if (!shadowed) {
        return pureStatement(bodyStatement);
      }
      const outer = systemExport;
      systemExport = undefined;
      try {
        return pureStatement(bodyStatement);
      } finally {
        systemExport = outer;
      }
    }
    case 'BlockStatement':
      return nodes(statement, 'body').every(pureStatement);
    case 'VariableDeclaration': {
      const scope = scopes.at(-1);
      return nodes(statement, 'declarations').every((declarator) => {
        const id = name(node(declarator, 'id'));
        if (id === undefined || id === systemExport) {
          return false;
        }
        scope?.add(id);
        return declarator.init === null || pureExpression(node(declarator, 'init')); // (`var k;` declares only)
      });
    }
    default:
      return false;
  }
}

/** A top-level expression statement of a facade: a whitelisted call, a write to the exports, or a `&&`/`||` chain of them. */
function facadeExpression(expression: Node | undefined): boolean {
  switch (expression?.type) {
    case 'CallExpression':
      return pureCall(expression);
    case 'AssignmentExpression':
      return (
        expression.operator === '=' &&
        isExportTarget(node(expression, 'left')) &&
        pureExpression(node(expression, 'right'))
      );
    case 'LogicalExpression':
      // `has(ext, k) && !has(exports, k) && Object.defineProperty(...)` (externalLiveBindings: false): the chain must
      // END in a call, and every operand is pure
      return node(expression, 'right')?.type === 'CallExpression' && pureExpression(expression);
    case 'SequenceExpression':
      // terser: `exports.a = r.a, exports.b = s.b, Object.defineProperty(...)`: every element is a facade expression
      return nodes(expression, 'expressions').every(facadeExpression);
    default:
      return false;
  }
}

/** One top-level statement of a facade (or of the body of a wrapper). */
function facadeStatement(statement: Node): boolean {
  switch (statement.type) {
    case 'EmptyStatement':
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
      return true;
    case 'ExportNamedDeclaration':
      return statement.declaration === null; // `export { a }` / `export { a } from '...'`, not `export function f(){}`
    case 'ExpressionStatement':
      // a directive, or a call / export write of the re-export language: never a bare reference or literal
      return statement.directive !== undefined || facadeExpression(node(statement, 'expression'));
    case 'VariableDeclaration':
      // `var main = require('./main.js')` / `var ns = _interopNamespaceDefault(x)`: a call, never a value of its own;
      // or `const _interopDefault = e => ...`, a helper function bound to its fixed name
      return nodes(statement, 'declarations').every((declarator) => {
        const init = node(declarator, 'init');
        const binding = name(node(declarator, 'id'));
        return (
          binding !== undefined &&
          init !== undefined &&
          (init.type === 'Identifier' || // `var Lib = A;` (an IIFE of a default-only entry)
            pureCall(init) ||
            (isFunction(init) && declaresHelper(binding)))
        );
      });
    case 'FunctionDeclaration':
      return declaresHelper(name(node(statement, 'id')) ?? '');
    default:
      return false;
  }
}

/** A reference a wrapper may return: an identifier, or a member chain of one (`main`, `main.default`). */
function pureReference(n: Node | undefined): boolean {
  if (n?.type === 'Identifier') {
    return true;
  }
  return n?.type === 'MemberExpression' && chainPure(n) && chainRoot(n) !== undefined;
}

/** What a wrapper returns: a reference, or (minified) `exports.a = x, exports.b = y, exports`: facade writes, then a reference. */
function returnedValue(n: Node | undefined): boolean {
  if (n?.type === 'MemberExpression' || n?.type === 'CallExpression') {
    return pureExpression(n); // `main.default`, or (minified AMD default mode) `helper(main).default`
  }
  if (n?.type !== 'SequenceExpression') {
    return pureReference(n);
  }
  const parts = nodes(n, 'expressions');
  return parts.slice(0, -1).every(facadeExpression) && pureReference(parts.at(-1));
}

/** Whether `callee` resolves to a declared helper from where it is called. */
function isHelper(callee: string): boolean {
  if (scopes.some((scope) => scope.has(callee))) {
    return false; // a local of the function being read shadows everything outside it
  }
  for (let i = helperScopes.length - 1; i >= 0; i--) {
    const scope = helperScopes[i] as HelperScope;
    if (scope.helpers.has(callee)) {
      return true;
    }
    if (scope.bound.has(callee)) {
      return false; // bound to something that is not a helper
    }
  }
  return false;
}

/** Whether the declaration of `id` in the statement list being read is a helper. */
const declaresHelper = (id: string): boolean => helperScopes.at(-1)?.helpers.has(id) === true;

/**
 * Runs `fn` with a lexical scope for `statements` (a program, or a wrapper's factory body) whose `params` are bound in
 * it. A function declared once in the scope, whose body is made of the re-export language, and that is shaped like an
 * interop helper (named `_interop*`, or touching `__esModule` / `Object.create` / `Object.freeze` / `'default' in`),
 * is a helper; every other name bound in it (an import, a variable, a parameter, a name declared TWICE) is not, and
 * shadows any helper of the scopes outside. Hoisting: helpers are known before any statement is judged.
 */
function withHelperScope(statements: Node[], params: string[], fn: () => boolean): boolean {
  const counts = new Map<string, number>(params.map((param) => [param, 1]));
  const candidates: Array<[string, Node]> = [];
  const bind = (id: string | undefined): void => {
    if (id !== undefined) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  };
  for (const statement of statements) {
    if (statement.type === 'FunctionDeclaration') {
      const id = name(node(statement, 'id'));
      bind(id);
      if (id !== undefined) {
        candidates.push([id, statement]);
      }
    } else if (statement.type === 'VariableDeclaration') {
      for (const declarator of nodes(statement, 'declarations')) {
        const id = name(node(declarator, 'id'));
        const init = node(declarator, 'init');
        bind(id);
        if (id !== undefined && init !== undefined && isFunction(init)) {
          candidates.push([id, init]);
        }
      }
    } else if (statement.type === 'ImportDeclaration') {
      for (const specifier of nodes(statement, 'specifiers')) {
        bind(name(node(specifier, 'local')));
      }
    }
  }
  const scope: HelperScope = { helpers: new Set(), bound: new Set(counts.keys()) };
  helperScopes.push(scope);
  try {
    // a helper's own name resolves to itself while its body is read (a recursive helper), but it only counts once the
    // body has passed
    for (const [id, definition] of candidates) {
      const text = source.slice(definition.start as number, definition.end as number);
      if (
        counts.get(id) === 1 &&
        (HELPER_NAME.test(id) || INTEROP_SHAPE.test(text)) &&
        pureFunction(definition)
      ) {
        scope.helpers.add(id);
        scope.bound.delete(id);
      }
    }
    return fn();
  } finally {
    helperScopes.pop();
  }
}

/**
 * The factory of a wrapper (AMD / IIFE / UMD): plain parameters and a body of facade statements, optionally ending in
 * a `return <value>` (default-export mode, or an IIFE returning its `exports`). `exportsFirst`: the first parameter
 * is the `exports` object (a minifier renames it), so writes to it are export writes.
 */
function factoryBody(factory: Node | undefined, exportsFirst: boolean): boolean {
  if (
    !isFunction(factory) ||
    !nodes(factory as Node, 'params').every((param) => param.type === 'Identifier')
  ) {
    return false;
  }
  const body = node(factory as Node, 'body') as Node;
  if (body.type !== 'BlockStatement') {
    return false;
  }
  const previous = exportAlias;
  exportAlias = exportsFirst ? name(nodes(factory as Node, 'params')[0]) : undefined;
  try {
    const statements = nodes(body, 'body');
    const last = statements.at(-1);
    const returns = last?.type === 'ReturnStatement';
    return withHelperScope(
      statements,
      nodes(factory as Node, 'params').map((param) => param.name as string),
      () =>
        (!returns || returnedValue(node(last as Node, 'argument'))) &&
        (returns ? statements.slice(0, -1) : statements).every(facadeStatement),
    );
  } finally {
    exportAlias = previous;
  }
}

/**
 * Rollup's AMD wrapper: `define(['exports', './main.js'], function (exports, main) { ...facade body... })`, with an
 * optional leading module id. The body is judged by the same statements as a top-level facade (no nesting).
 */
function isAmdFacade(statement: Node): boolean {
  const expression =
    statement.type === 'ExpressionStatement' ? node(statement, 'expression') : undefined;
  if (expression?.type !== 'CallExpression' || name(node(expression, 'callee')) !== 'define') {
    return false;
  }
  const args = nodes(expression, 'arguments');
  if (args.length > 0 && literalString(args[0])) {
    args.shift(); // the module id
  }
  const [dependencies, factory] = args;
  return (
    args.length === 2 &&
    dependencies?.type === 'ArrayExpression' &&
    nodes(dependencies, 'elements').every((element) => literalString(element)) &&
    factoryBody(factory, nodes(dependencies, 'elements')[0]?.value === 'exports')
  );
}

/** Whether `a` and `b` are the same chain of plain properties rooted at `this` (`this.my.Lib`). */
function thisChain(n: Node | undefined): string | undefined {
  const parts: string[] = [];
  let current = n;
  while (current?.type === 'MemberExpression') {
    const property = current.computed === true ? undefined : name(node(current, 'property'));
    if (property === undefined) {
      return undefined;
    }
    parts.unshift(property);
    current = node(current, 'object');
  }
  return current?.type === 'ThisExpression' ? parts.join('.') : undefined;
}

/** `this.my = this.my || {}`: a dotted `output.name`'s namespace, or an IIFE's `extend` argument. */
function isThisNamespaceInit(n: Node | undefined): boolean {
  const target =
    n?.type === 'AssignmentExpression' && n.operator === '='
      ? thisChain(node(n, 'left'))
      : undefined;
  const right = n === undefined ? undefined : node(n, 'right');
  return (
    target !== undefined &&
    right?.type === 'LogicalExpression' &&
    right.operator === '||' &&
    thisChain(node(right, 'left')) === target &&
    node(right, 'right')?.type === 'ObjectExpression' &&
    nodes(node(right, 'right') as Node, 'properties').length === 0
  );
}

/** `(function (exports, extA) { ...facade body... return exports; })({}, A)`: Rollup's IIFE. */
function isIifeCall(call: Node | undefined): boolean {
  const callee = call?.type === 'CallExpression' ? node(call, 'callee') : undefined;
  if (call === undefined || callee?.type !== 'FunctionExpression') {
    return false;
  }
  const args = nodes(call, 'arguments');
  const first = args[0];
  return (
    args.length === nodes(callee, 'params').length &&
    args.every(
      (arg) => arg.type === 'ThisExpression' || isThisNamespaceInit(arg) || pureExpression(arg), // (`{}` is pure)
    ) &&
    factoryBody(
      callee,
      first !== undefined &&
        (isThisNamespaceInit(first) ||
          (first.type === 'ObjectExpression' && nodes(first, 'properties').length === 0)),
    )
  );
}

type UmdState = { global: string; factory: string; exports: boolean };

/** The UMD preamble's expression: `typeof exports === 'object' ? factory(...) : define(...) : (global = ..., factory(...))`. */
function umdExpression(expression: Node | undefined, state: UmdState): boolean {
  return bounded(() => umdNode(expression, state));
}

/** `global`, `global.Lib`, `(global = ...).Lib`: where the UMD preamble writes the library. */
function umdTarget(n: Node | undefined, state: UmdState): boolean {
  if (n?.type === 'Identifier') {
    return n.name === state.global;
  }
  if (n?.type === 'MemberExpression') {
    return chainPure(n) && umdTarget(node(n, 'object'), state);
  }
  return (
    n?.type === 'AssignmentExpression' &&
    n.operator === '=' &&
    name(node(n, 'left')) === state.global &&
    umdExpression(node(n, 'right'), state)
  );
}

/**
 * Rollup's `noConflict` preamble: `(function () { var current = global.Lib; var exports = global.Lib = {};
 * factory(exports, global.A); exports.noConflict = function () { global.Lib = current; return exports; }; })()`.
 */
function umdNoConflict(call: Node, state: UmdState): boolean {
  const fn = node(call, 'callee');
  if (
    !isFunction(fn) ||
    nodes(call, 'arguments').length > 0 ||
    nodes(fn as Node, 'params').length > 0
  ) {
    return false;
  }
  const locals = new Set<string>();
  const local = (n: Node | undefined): boolean =>
    n?.type === 'Identifier' && locals.has(n.name as string);
  const restorer = (n: Node | undefined): boolean => {
    // `function () { global.Lib = current; return exports; }`; minified: `() => (global.Lib = current, exports)`
    if (!isFunction(n) || nodes(n as Node, 'params').length > 0) {
      return false;
    }
    const body = node(n as Node, 'body') as Node;
    const parts = (e: Node | undefined): Node[] =>
      e?.type === 'SequenceExpression' ? nodes(e, 'expressions') : e ? [e] : [];
    let flat: Node[];
    if (body.type === 'BlockStatement') {
      const statements = nodes(body, 'body');
      if (statements.at(-1)?.type !== 'ReturnStatement') {
        return false;
      }
      flat = statements.flatMap((st) =>
        st.type === 'ExpressionStatement'
          ? parts(node(st, 'expression'))
          : st.type === 'ReturnStatement'
            ? parts(node(st, 'argument'))
            : [st],
      );
    } else {
      flat = parts(body);
    }
    return (
      flat.length > 1 && // at least one restore, then the returned `exports`
      local(flat.at(-1)) &&
      flat
        .slice(0, -1)
        .every(
          (part) =>
            part.type === 'AssignmentExpression' &&
            part.operator === '=' &&
            umdTarget(node(part, 'left'), state) &&
            local(node(part, 'right')),
        )
    );
  };
  const expressionOk = (e: Node | undefined): boolean => {
    if (e?.type === 'SequenceExpression') {
      return nodes(e, 'expressions').every(expressionOk);
    }
    if (e?.type === 'AssignmentExpression' && e.operator === '=') {
      const left = node(e, 'left');
      const right = node(e, 'right');
      const key = left === undefined ? undefined : node(left, 'property');
      return (
        left?.type === 'MemberExpression' &&
        local(node(left, 'object')) &&
        // the generated target: `exports.noConflict` or `exports['noConflict']`, never a key that runs code
        (left.computed === true
          ? key?.type === 'Literal' && key.value === 'noConflict'
          : name(key) === 'noConflict') &&
        restorer(right)
      );
    }
    return (
      e?.type === 'CallExpression' &&
      name(node(e, 'callee')) === state.factory &&
      nodes(e, 'arguments').every((arg) => local(arg) || umdExpression(arg, state))
    );
  };
  const body = node(fn as Node, 'body') as Node;
  return nodes(body, 'body').every((st) => {
    if (st.type === 'VariableDeclaration') {
      return nodes(st, 'declarations').every((declarator) => {
        const id = name(node(declarator, 'id'));
        const init = node(declarator, 'init');
        if (id !== undefined) {
          locals.add(id);
        }
        return id !== undefined && init !== undefined && umdExpression(init, state);
      });
    }
    return st.type === 'ExpressionStatement' && expressionOk(node(st, 'expression'));
  });
}

function umdNode(expression: Node | undefined, state: UmdState): boolean {
  const recurse = (n: Node | undefined): boolean => umdExpression(n, state);
  switch (expression?.type) {
    case 'ConditionalExpression':
      return (
        recurse(node(expression, 'test')) &&
        recurse(node(expression, 'consequent')) &&
        recurse(node(expression, 'alternate'))
      );
    case 'LogicalExpression':
    case 'BinaryExpression':
      return recurse(node(expression, 'left')) && recurse(node(expression, 'right'));
    case 'UnaryExpression':
      return recurse(node(expression, 'argument'));
    case 'SequenceExpression':
      return nodes(expression, 'expressions').every(recurse);
    case 'AssignmentExpression': {
      // `global = typeof globalThis !== ... : global || self`, `global.Lib = {}` as a factory argument, and in
      // default-export mode `module.exports = factory(...)` / `global.Lib = factory(...)`
      const left = node(expression, 'left');
      return (
        expression.operator === '=' &&
        (umdTarget(left, state) || isExportTarget(left)) &&
        recurse(node(expression, 'right'))
      );
    }
    case 'ObjectExpression':
      return nodes(expression, 'properties').length === 0;
    case 'CallExpression': {
      const callee = name(node(expression, 'callee'));
      const args = nodes(expression, 'arguments');
      if (callee === state.factory) {
        return args.every(recurse);
      }
      if (callee === 'define') {
        const dependencies = args[0];
        state.exports = nodes(dependencies as Node, 'elements')[0]?.value === 'exports';
        return (
          args.length === 2 &&
          dependencies?.type === 'ArrayExpression' &&
          nodes(dependencies, 'elements').every((element) => literalString(element)) &&
          name(args[1]) === state.factory
        );
      }
      return isFunction(node(expression, 'callee'))
        ? umdNoConflict(expression, state)
        : pureCall(expression);
    }
    default:
      return pureExpression(expression);
  }
}

/** `(function (global, factory) { <UMD preamble> })(this, function (exports, ...) { ...facade body... })`. */
function isUmdCall(call: Node | undefined): boolean {
  const callee = call?.type === 'CallExpression' ? node(call, 'callee') : undefined;
  if (call === undefined || callee?.type !== 'FunctionExpression') {
    return false;
  }
  const params = nodes(callee, 'params');
  const args = nodes(call, 'arguments');
  const [global, factory] = params.map(name);
  const wrapper = node(callee, 'body') as Node;
  const preamble = nodes(wrapper, 'body');
  if (
    params.length !== 2 ||
    global === undefined ||
    factory === undefined ||
    args.length !== 2 ||
    !(args[0]?.type === 'ThisExpression' || pureExpression(args[0])) ||
    preamble.length !== 1 ||
    preamble[0]?.type !== 'ExpressionStatement' ||
    !/^(?:Conditional|Sequence|Call)Expression$/.test(node(preamble[0], 'expression')?.type ?? '')
  ) {
    return false;
  }
  const state: UmdState = { global, factory, exports: false };
  return (
    umdExpression(node(preamble[0], 'expression'), state) && factoryBody(args[1], state.exports)
  );
}

/** One expression of an IIFE / UMD wrapper statement (terser joins several with commas). */
function wrapperExpression(expression: Node | undefined): boolean {
  return bounded(() => {
    let current = expression;
    if (current?.type === 'UnaryExpression' && /^(?:!|void)$/.test(current.operator as string)) {
      current = node(current, 'argument'); // terser: `!function (e) { ... }(...)`
    }
    if (current?.type === 'SequenceExpression') {
      return nodes(current, 'expressions').every(wrapperExpression);
    }
    if (current?.type === 'CallExpression') {
      return isIifeCall(current) || isUmdCall(current);
    }
    if (current?.type !== 'AssignmentExpression' || current.operator !== '=') {
      return false;
    }
    // `this.my = this.my || {};` (a dotted `output.name`'s namespace), `this.my.Lib = (function () {...})({})`, or (a
    // default-only entry) `this.Lib = A;`
    return (
      thisChain(node(current, 'left')) !== undefined &&
      (isThisNamespaceInit(current) ||
        isIifeCall(node(current, 'right')) ||
        node(current, 'right')?.type === 'Identifier')
    );
  });
}

/** IIFE and UMD wrappers, bound to a name or a `this.X` namespace, or bare. */
function isWrapperFacade(statement: Node): boolean {
  if (statement.type === 'VariableDeclaration') {
    const declarations = nodes(statement, 'declarations');
    return (
      declarations.length === 1 &&
      name(node(declarations[0] as Node, 'id')) !== undefined &&
      isIifeCall(node(declarations[0] as Node, 'init'))
    );
  }
  return (
    statement.type === 'ExpressionStatement' && wrapperExpression(node(statement, 'expression'))
  );
}

/**
 * Rollup's SystemJS wrapper: `System.register(deps, function (exports) { 'use strict'; var x = {...}; return { setters:
 * [function (module) { exports('a', module.a); }, ...], execute: function () {} }; })`. The setters hold the
 * re-exports (calls of the factory's export callback count only there, and only while no setter shadows it) and
 * `execute` must be empty: a chunk with code has statements in it.
 */
function isSystemFacade(statement: Node): boolean {
  const expression =
    statement.type === 'ExpressionStatement' ? node(statement, 'expression') : undefined;
  const callee = expression?.type === 'CallExpression' ? node(expression, 'callee') : undefined;
  if (
    expression === undefined ||
    callee?.type !== 'MemberExpression' ||
    callee.computed === true ||
    name(node(callee, 'object')) !== 'System' ||
    name(node(callee, 'property')) !== 'register'
  ) {
    return false;
  }
  const args = nodes(expression, 'arguments');
  if (args.length > 0 && literalString(args[0])) {
    args.shift(); // the module id
  }
  const [dependencies, factory] = args;
  if (
    args.length !== 2 ||
    dependencies?.type !== 'ArrayExpression' ||
    !nodes(dependencies, 'elements').every((element) => literalString(element)) ||
    !isFunction(factory) ||
    !nodes(factory as Node, 'params').every((param) => param.type === 'Identifier')
  ) {
    return false;
  }
  const callback = name(nodes(factory as Node, 'params')[0]); // `exports`, whatever the factory calls it
  const body = node(factory as Node, 'body') as Node;
  const statements = body.type === 'BlockStatement' ? nodes(body, 'body') : [];
  const last = statements.at(-1);
  if (last?.type !== 'ReturnStatement') {
    return false;
  }
  // everything before the `return` is a directive or a variable of a pure value (`var _starExcludes = {...}`) that
  // does not shadow the callback
  // (judged inside the factory's own scope: its parameters and these variables shadow any outer helper)
  const factoryParams = nodes(factory as Node, 'params').map((param) => name(param) as string);
  const prelude = withHelperScope(statements.slice(0, -1), factoryParams, () =>
    statements
      .slice(0, -1)
      .every(
        (item) =>
          (item.type === 'ExpressionStatement' && item.directive !== undefined) ||
          (item.type === 'VariableDeclaration' &&
            !(callback !== undefined && declared(item).includes(callback)) &&
            nodes(item, 'declarations').every(
              (declarator) =>
                node(declarator, 'id')?.type === 'Identifier' &&
                pureExpression(node(declarator, 'init')),
            )),
      ),
  );
  const result = node(last, 'argument');
  if (!prelude || result?.type !== 'ObjectExpression') {
    return false;
  }
  const properties = nodes(result, 'properties');
  const property = (key: string): Node | undefined =>
    properties.find((p) => name(node(p, 'key')) === key && p.computed !== true);
  const setters = node(property('setters') ?? result, 'value');
  const execute = node(property('execute') ?? result, 'value');
  if (properties.length !== 2 || setters?.type !== 'ArrayExpression' || !isFunction(execute)) {
    return false;
  }
  const executeBody = node(execute as Node, 'body') as Node;
  const setterFunctions = (setters.elements as unknown[]).filter(isNode);
  systemExport = callback;
  try {
    // the factory's parameters and prelude variables shadow any outer helper of the same name
    return withHelperScope(
      statements.slice(0, -1),
      factoryParams,
      () =>
        nodes(execute as Node, 'params').length === 0 &&
        executeBody.type === 'BlockStatement' &&
        nodes(executeBody, 'body').every((item) => item.type === 'EmptyStatement') &&
        setterFunctions.length === (setters.elements as unknown[]).length &&
        setterFunctions.every((setter) => isFunction(setter) && pureFunction(setter)),
    );
  } finally {
    systemExport = undefined;
  }
}

/** One top-level statement of a facade, in any of Rollup's output formats. */
function facadeTopLevel(statement: Node): boolean {
  return (
    isAmdFacade(statement) ||
    isSystemFacade(statement) ||
    isWrapperFacade(statement) ||
    facadeStatement(statement)
  );
}

/**
 * The generated registration statement, as the stamp appends it (`;!function(){try{var e=...,n=(new e.Error).stack;
 * n&&(e._bugseeDebugIds=e._bugseeDebugIds||{},e._bugseeDebugIds[n]="<id>")}catch(e){}}();`): an immediately invoked
 * function without parameters or arguments, whose body only declares variables of plain values and writes to the
 * marker, in a `try` that swallows. It calls nothing (a `new X.Error` for the stack is the one construction). A
 * statement that merely MENTIONS the marker (`console.log('_bugseeDebugIds')`) is not it.
 */
function isRegistrationStatement(code: string, statement: Node): boolean {
  if (!code.slice(statement.start as number, statement.end as number).includes(REGISTRATION)) {
    return false;
  }
  const expression =
    statement.type === 'ExpressionStatement' ? node(statement, 'expression') : undefined;
  const call =
    expression?.type === 'UnaryExpression' && expression.operator === '!'
      ? node(expression, 'argument')
      : undefined;
  const fn = call?.type === 'CallExpression' ? node(call, 'callee') : undefined;
  return (
    call !== undefined &&
    fn?.type === 'FunctionExpression' &&
    nodes(call, 'arguments').length === 0 &&
    nodes(fn, 'params').length === 0 &&
    nodes(node(fn, 'body') as Node, 'body').every(stubStatement)
  );
}

function stubStatement(statement: Node): boolean {
  return bounded(() => {
    switch (statement.type) {
      case 'ExpressionStatement':
        return stubExpression(node(statement, 'expression'));
      case 'VariableDeclaration':
        return nodes(statement, 'declarations').every(
          (declarator) =>
            node(declarator, 'id')?.type === 'Identifier' &&
            stubExpression(node(declarator, 'init')),
        );
      case 'TryStatement': {
        const handler = node(statement, 'handler');
        return (
          statement.finalizer === null &&
          handler !== undefined &&
          nodes(node(handler, 'body') as Node, 'body').length === 0 &&
          nodes(node(statement, 'block') as Node, 'body').every(stubStatement)
        );
      }
      default:
        return false;
    }
  });
}

function stubExpression(expression: Node | undefined): boolean {
  return bounded(() => {
    switch (expression?.type) {
      case 'Identifier':
      case 'Literal':
        return true;
      case 'MemberExpression':
        return (
          stubExpression(node(expression, 'object')) &&
          (expression.computed !== true || stubExpression(node(expression, 'property')))
        );
      case 'UnaryExpression':
        return (
          (expression.operator === 'typeof' || expression.operator === '!') &&
          stubExpression(node(expression, 'argument'))
        );
      case 'BinaryExpression':
      case 'LogicalExpression':
        return (
          stubExpression(node(expression, 'left')) && stubExpression(node(expression, 'right'))
        );
      case 'ConditionalExpression':
        return (
          stubExpression(node(expression, 'test')) &&
          stubExpression(node(expression, 'consequent')) &&
          stubExpression(node(expression, 'alternate'))
        );
      case 'SequenceExpression':
        return nodes(expression, 'expressions').every(stubExpression);
      case 'AssignmentExpression':
        return (
          expression.operator === '=' &&
          node(expression, 'left')?.type !== 'ObjectPattern' &&
          stubExpression(node(expression, 'left')) &&
          stubExpression(node(expression, 'right'))
        );
      case 'ObjectExpression':
        return nodes(expression, 'properties').length === 0;
      case 'NewExpression': {
        // `new e.Error` for the stack, and nothing else
        const callee = node(expression, 'callee');
        return (
          callee?.type === 'MemberExpression' &&
          callee.computed !== true &&
          stubExpression(node(callee, 'object')) &&
          name(node(callee, 'property')) === 'Error' &&
          nodes(expression, 'arguments').length === 0
        );
      }
      default:
        return false;
    }
  });
}

type Comment = { type: string; value: string; start: number; end: number };

/**
 * Whether a bundle holds no code of its own: only imports and re-exports (ESM, or Rollup's CommonJS / AMD / SystemJS /
 * IIFE / UMD shape with its `export *` loop and interop helpers), plus the Bugsee registration the stamp appended: the
 * ONE trailing statement that is the generated registration, accepted only when the stamp's `//# debugId=` comment
 * follows it. A marker anywhere else, or a statement that only mentions it, is the bundle's own code. Comments are the
 * parser's, so a block comment's delimiters are never mistaken for line comments. Anything it cannot read, that goes
 * deeper than the walk allows, or that does something (a function, a call, a declaration), is real code, and an empty
 * map for it is a stripped one.
 */
export function isFacadeCode(code: string): boolean {
  reset();
  try {
    const comments: Comment[] = [];
    const program = parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      onComment: comments as never,
    }) as unknown as Node;
    source = code;
    const body = nodes(program, 'body');
    const last = body.at(-1);
    const isStub =
      last !== undefined &&
      isRegistrationStatement(code, last) &&
      comments.some(
        (comment) =>
          comment.type === 'Line' &&
          comment.start >= (last.end as number) &&
          comment.value.startsWith('# debugId='),
      );
    const rest = isStub ? body.slice(0, -1) : body;
    return withHelperScope(rest, [], () => rest.every(facadeTopLevel));
  } catch {
    return false; // unreadable, or too deep for the walk: not a facade
  } finally {
    reset();
  }
}
