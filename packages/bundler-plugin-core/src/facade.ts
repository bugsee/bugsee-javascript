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

/** Rollup's interop helpers: `_interopDefault`, `_interopNamespaceDefault`, `_interopNamespace`, ... */
const HELPER_NAME = /^_interop[A-Za-z]*$/;
/** `Object.<name>(...)` calls a re-export block makes (a regular expression: the drift test reads string literals). */
const OBJECT_CALL =
  /^(?:keys|defineProperty|defineProperties|getOwnPropertyDescriptor|create|freeze)$/;

/** How deep the walk goes before it gives up ("not a facade"): a hostile chain must not exhaust the stack. */
const MAX_DEPTH = 64;
let depth = 0;
/** Inside a function body (a helper, a getter): assignments to its own variables are fine there. */
let inFunction = 0;
/** Inside a SystemJS setter: `exports(...)` is the module system's own call there. */
let inSystem = 0;

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

const isFunction = (n: Node): boolean =>
  n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';

/** A function Rollup writes into a re-export block: plain parameters and a body of re-export statements. */
function pureFunction(fn: Node): boolean {
  if (!nodes(fn, 'params').every((param) => param.type === 'Identifier')) {
    return false;
  }
  const body = node(fn, 'body') as Node; // a function always has a body
  inFunction++;
  try {
    return body.type === 'BlockStatement'
      ? nodes(body, 'body').every(pureStatement)
      : pureExpression(body);
  } finally {
    inFunction--;
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
  if (calleeName === 'exports') {
    return inSystem > 0 && args.every(pureExpression);
  }
  if (calleeName !== undefined) {
    return HELPER_NAME.test(calleeName) && args.every(pureExpression);
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

/** The expressions a re-export is written with: references, literals, whitelisted calls, getters. */
function pureExpression(expression: Node | undefined): boolean {
  if (depth >= MAX_DEPTH) {
    return false;
  }
  depth++;
  try {
    return pureExpressionNode(expression as Node);
  } finally {
    depth--;
  }
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
    case 'AssignmentExpression':
      // only to the variables of a helper's own body: a top-level write is judged by `facadeExpression`
      return (
        inFunction > 0 &&
        expression.operator === '=' &&
        pureExpression(node(expression, 'left')) &&
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
  if (depth >= MAX_DEPTH) {
    return false;
  }
  depth++;
  try {
    return pureStatementNode(statement);
  } finally {
    depth--;
  }
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
      return (
        isBinding &&
        pureExpression(node(statement, 'right')) &&
        pureStatement(node(statement, 'body') as Node)
      );
    }
    case 'BlockStatement':
      return nodes(statement, 'body').every(pureStatement);
    case 'VariableDeclaration':
      return nodes(statement, 'declarations').every(
        (declarator) =>
          node(declarator, 'id')?.type === 'Identifier' && pureExpression(node(declarator, 'init')),
      );
    default:
      return false;
  }
}

/** `exports`, `exports.a`, `exports['a']`, `module.exports`, `module.exports.a`: where a CommonJS facade writes. */
function isExportTarget(target: Node | undefined): boolean {
  if (target?.type !== 'MemberExpression') {
    return false;
  }
  const object = node(target, 'object');
  const isModuleExports = (n: Node | undefined): boolean =>
    n?.type === 'MemberExpression' &&
    n.computed !== true &&
    name(node(n, 'object')) === 'module' &&
    name(node(n, 'property')) === 'exports';
  return isModuleExports(target) || name(object) === 'exports' || isModuleExports(object);
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
    default:
      return false;
  }
}

/** One top-level statement of a facade (or of the body of its AMD wrapper). */
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
          (pureCall(init) || (HELPER_NAME.test(binding) && isFunction(init) && pureFunction(init)))
        );
      });
    case 'FunctionDeclaration':
      return HELPER_NAME.test(name(node(statement, 'id')) ?? '') && pureFunction(statement);
    default:
      return false;
  }
}

/**
 * Rollup's AMD wrapper: `define(['exports', './main.js'], function (exports, main) { ...facade body... })`, with an
 * optional leading module id. The body is judged by the same statements as a top-level facade (no nesting).
 */
function amdBody(statement: Node): Node[] | undefined {
  const expression =
    statement.type === 'ExpressionStatement' ? node(statement, 'expression') : undefined;
  if (expression?.type !== 'CallExpression' || name(node(expression, 'callee')) !== 'define') {
    return undefined;
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
    factory === undefined ||
    !isFunction(factory) ||
    !nodes(factory, 'params').every((param) => param.type === 'Identifier')
  ) {
    return undefined;
  }
  const body = node(factory, 'body') as Node;
  return body.type === 'BlockStatement' ? nodes(body, 'body') : undefined;
}

/**
 * Rollup's SystemJS wrapper: `System.register(deps, function (exports) { 'use strict'; var x = {...}; return { setters:
 * [function (module) { exports('a', module.a); }, ...], execute: function () {} }; })`. The setters hold the
 * re-exports (`exports(...)` calls count only there) and `execute` must be empty: a chunk with code has statements in it.
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
    factory === undefined ||
    !isFunction(factory) ||
    !nodes(factory, 'params').every((param) => param.type === 'Identifier')
  ) {
    return false;
  }
  const body = node(factory, 'body') as Node;
  const statements = body.type === 'BlockStatement' ? nodes(body, 'body') : [];
  const last = statements.at(-1);
  if (last?.type !== 'ReturnStatement') {
    return false;
  }
  // everything before the `return` is a directive or a variable of a pure value (`var _starExcludes = {...}`)
  const prelude = statements
    .slice(0, -1)
    .every(
      (item) =>
        (item.type === 'ExpressionStatement' && item.directive !== undefined) ||
        (item.type === 'VariableDeclaration' &&
          nodes(item, 'declarations').every(
            (declarator) =>
              node(declarator, 'id')?.type === 'Identifier' &&
              pureExpression(node(declarator, 'init')),
          )),
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
  if (
    properties.length !== 2 ||
    setters?.type !== 'ArrayExpression' ||
    execute === undefined ||
    !isFunction(execute)
  ) {
    return false;
  }
  const executeBody = node(execute, 'body') as Node;
  inSystem++;
  try {
    return (
      nodes(execute, 'params').length === 0 &&
      executeBody.type === 'BlockStatement' &&
      nodes(executeBody, 'body').every((item) => item.type === 'EmptyStatement') &&
      (setters.elements as unknown[]).every(
        (element) => isNode(element) && isFunction(element) && pureFunction(element),
      )
    );
  } finally {
    inSystem--;
  }
}

/** One top-level statement, or the whole body of an AMD wrapper, or a SystemJS wrapper. */
function facadeTopLevel(statement: Node): boolean {
  const body = amdBody(statement);
  return body === undefined
    ? facadeStatement(statement) || isSystemFacade(statement)
    : body.every(facadeStatement);
}

type Comment = { type: string; value: string; start: number; end: number };

/**
 * Whether a bundle holds no code of its own: only imports and re-exports (ESM, or Rollup's CommonJS / AMD shape with its
 * `export *` loop and interop helpers), plus the Bugsee registration the stamp appended: ONE trailing STATEMENT that
 * carries the marker, accepted only when the stamp's `//# debugId=` comment follows it. A marker anywhere else is the
 * bundle's own code (an SDK reads `_bugseeDebugIds`), so it stays. Comments are the parser's, so a block comment's
 * delimiters are never mistaken for line comments. Anything it cannot read, that goes deeper than the walk allows, or
 * that does something (a function, a call, a declaration), is real code, and an empty map for it is a stripped one.
 */
export function isFacadeCode(code: string): boolean {
  depth = 0;
  inFunction = 0;
  inSystem = 0;
  try {
    const comments: Comment[] = [];
    const program = parse(code, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      onComment: comments as never,
    }) as unknown as Node;
    const body = nodes(program, 'body');
    const last = body.at(-1);
    const isStub =
      last !== undefined &&
      code.slice(last.start as number, last.end as number).includes(REGISTRATION) &&
      comments.some(
        (comment) =>
          comment.type === 'Line' &&
          comment.start >= (last.end as number) &&
          comment.value.startsWith('# debugId='),
      );
    return (isStub ? body.slice(0, -1) : body).every(facadeTopLevel);
  } catch {
    return false; // unreadable, or too deep for the walk: not a facade
  } finally {
    depth = 0;
    inFunction = 0;
    inSystem = 0;
  }
}
