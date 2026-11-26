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

/** How deep the walk goes before it gives up ("not a facade"): a hostile chain must not exhaust the stack. */
const MAX_DEPTH = 64;
let depth = 0;
/** The variables of the functions being walked (params and declarations): a helper may write to those only. */
let scopes: Array<Set<string>> = [];
/** Inside a SystemJS setter: the factory's export callback, the one name whose calls are the module system's own. */
let systemExport: string | undefined;

const reset = (): void => {
  depth = 0;
  scopes = [];
  systemExport = undefined;
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
  if (!params.every((param) => param.type === 'Identifier')) {
    return false;
  }
  const body = node(fn, 'body') as Node; // a function always has a body
  scopes.push(new Set(params.map((param) => param.name as string)));
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
  if (calleeName !== undefined && calleeName === systemExport) {
    return args.every(pureExpression);
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
    if (name(current) === 'exports') {
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
      if (left.type === 'VariableDeclaration') {
        const scope = scopes.at(-1);
        for (const bound of declared(left)) {
          scope?.add(bound);
        }
      }
      return (
        isBinding &&
        pureExpression(node(statement, 'right')) &&
        pureStatement(node(statement, 'body') as Node)
      );
    }
    case 'BlockStatement':
      return nodes(statement, 'body').every(pureStatement);
    case 'VariableDeclaration': {
      const scope = scopes.at(-1);
      return nodes(statement, 'declarations').every((declarator) => {
        const id = name(node(declarator, 'id'));
        if (id === undefined) {
          return false;
        }
        scope?.add(id);
        return pureExpression(node(declarator, 'init'));
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
          (pureCall(init) || (HELPER_NAME.test(binding) && isFunction(init) && pureFunction(init)))
        );
      });
    case 'FunctionDeclaration':
      return HELPER_NAME.test(name(node(statement, 'id')) ?? '') && pureFunction(statement);
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

/**
 * The factory of a wrapper (AMD / IIFE / UMD): plain parameters and a body of facade statements, optionally ending in
 * a `return <reference>` (default-export mode, or an IIFE returning its `exports`).
 */
function factoryBody(factory: Node | undefined): boolean {
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
  const statements = nodes(body, 'body');
  const last = statements.at(-1);
  const returns = last?.type === 'ReturnStatement';
  return (
    (!returns || pureReference(node(last as Node, 'argument'))) &&
    (returns ? statements.slice(0, -1) : statements).every(facadeStatement)
  );
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
    factoryBody(factory)
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

/** `(function (exports, extA) { ...facade body... return exports; })({}, A)`: Rollup's IIFE. */
function isIifeCall(call: Node | undefined): boolean {
  const callee = call?.type === 'CallExpression' ? node(call, 'callee') : undefined;
  if (call === undefined || callee?.type !== 'FunctionExpression') {
    return false;
  }
  const args = nodes(call, 'arguments');
  return (
    args.length === nodes(callee, 'params').length &&
    args.every(
      (arg) => arg.type === 'ThisExpression' || pureExpression(arg), // (`{}` is pure)
    ) &&
    factoryBody(callee)
  );
}

/** The UMD preamble's expression: `typeof exports === 'object' ? factory(...) : define(...) : (global = ..., factory(...))`. */
function umdExpression(expression: Node | undefined, global: string, factory: string): boolean {
  return bounded(() => umdNode(expression, global, factory));
}

function umdNode(expression: Node | undefined, global: string, factory: string): boolean {
  const recurse = (n: Node | undefined): boolean => umdExpression(n, global, factory);
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
      // `global = typeof globalThis !== ... : global || self`, and `global.Lib = {}` as a factory argument
      const left = node(expression, 'left');
      return (
        expression.operator === '=' &&
        (name(left) === global ||
          (left?.type === 'MemberExpression' && chainRoot(left) === global)) &&
        chainPure(left) &&
        recurse(node(expression, 'right'))
      );
    }
    case 'ObjectExpression':
      return nodes(expression, 'properties').length === 0;
    case 'CallExpression': {
      const callee = name(node(expression, 'callee'));
      const args = nodes(expression, 'arguments');
      if (callee === factory) {
        return args.every(recurse);
      }
      if (callee === 'define') {
        return (
          args.length === 2 &&
          args[0]?.type === 'ArrayExpression' &&
          nodes(args[0], 'elements').every((element) => literalString(element)) &&
          name(args[1]) === factory
        );
      }
      return pureCall(expression);
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
  return (
    params.length === 2 &&
    global !== undefined &&
    factory !== undefined &&
    args.length === 2 &&
    (args[0]?.type === 'ThisExpression' || pureExpression(args[0])) &&
    preamble.length === 1 &&
    preamble[0]?.type === 'ExpressionStatement' &&
    /^(?:Conditional|Sequence|Call)Expression$/.test(node(preamble[0], 'expression')?.type ?? '') &&
    umdExpression(node(preamble[0], 'expression'), global, factory) &&
    factoryBody(args[1])
  );
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
  const expression =
    statement.type === 'ExpressionStatement' ? node(statement, 'expression') : undefined;
  if (expression?.type === 'CallExpression') {
    return isIifeCall(expression) || isUmdCall(expression);
  }
  if (expression?.type !== 'AssignmentExpression' || expression.operator !== '=') {
    return false;
  }
  const target = thisChain(node(expression, 'left'));
  const right = node(expression, 'right');
  if (target === undefined) {
    return false;
  }
  // `this.my = this.my || {};` (a dotted `output.name`'s namespace) or `this.my.Lib = (function () {...})({})`
  return right?.type === 'LogicalExpression'
    ? right.operator === '||' &&
        thisChain(node(right, 'left')) === target &&
        node(right, 'right')?.type === 'ObjectExpression' &&
        nodes(node(right, 'right') as Node, 'properties').length === 0
    : isIifeCall(right);
}

/** Whether a setter declares `callback` (as a parameter or a variable anywhere in its body): that shadows the export callback. */
function shadows(fn: Node, callback: string): boolean {
  if (nodes(fn, 'params').some((param) => name(param) === callback)) {
    return true;
  }
  const visit = (statement: Node | undefined): boolean => {
    switch (statement?.type) {
      case 'VariableDeclaration':
        return declared(statement).includes(callback);
      case 'BlockStatement':
        return nodes(statement, 'body').some(visit);
      case 'IfStatement':
        return visit(node(statement, 'consequent')) || visit(node(statement, 'alternate'));
      case 'ForInStatement':
        return visit(node(statement, 'left')) || visit(node(statement, 'body'));
      default:
        return false;
    }
  };
  const body = node(fn, 'body');
  return body?.type === 'BlockStatement' ? visit(body) : false;
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
  const prelude = statements
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
    return (
      nodes(execute as Node, 'params').length === 0 &&
      executeBody.type === 'BlockStatement' &&
      nodes(executeBody, 'body').every((item) => item.type === 'EmptyStatement') &&
      setterFunctions.length === (setters.elements as unknown[]).length &&
      setterFunctions.every(
        (setter) =>
          isFunction(setter) &&
          !(callback !== undefined && shadows(setter, callback)) &&
          pureFunction(setter),
      )
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
    return (isStub ? body.slice(0, -1) : body).every(facadeTopLevel);
  } catch {
    return false; // unreadable, or too deep for the walk: not a facade
  } finally {
    reset();
  }
}
