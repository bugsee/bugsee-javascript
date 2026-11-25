// Is a bundle a FACADE: no code of its own, only imports and re-exports? Rollup writes `sources: []` and an empty
// `mappings` for such a chunk (a barrel `export { a } from './main.js'`, an empty chunk), and that empty map is correct.
// A chunk with real code and an empty map is a stripped one, so the doctor has to tell the two apart by reading the
// bundle: parsed (acorn), and every top-level statement checked against the small language a facade is written in.
import { parse } from 'acorn';

/** The global the runtime stub writes the id into: the stamp's registration line carries it. */
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
/** `Object.<name>(...)` calls a re-export block makes. */
// (a regular expression, not a list of strings: the wire-name drift test reads string literals in product code)
const OBJECT_CALL = /^(?:keys|defineProperty|getOwnPropertyDescriptor|create|freeze)$/;

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

const isFunction = (n: Node): boolean =>
  n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';

/** A function Rollup writes into a re-export block: plain parameters and a body of re-export statements. */
function pureFunction(fn: Node): boolean {
  if (!nodes(fn, 'params').every((param) => param.type === 'Identifier')) {
    return false;
  }
  const body = node(fn, 'body') as Node; // a function always has a body
  return body.type === 'BlockStatement'
    ? nodes(body, 'body').every(pureStatement)
    : pureExpression(body);
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
    const target = node(callee, 'object');
    const callback = args[0];
    return (
      target !== undefined &&
      pureExpression(target) &&
      args.length === 1 &&
      callback !== undefined &&
      isFunction(callback) &&
      pureFunction(callback)
    );
  }
  return false;
}

/** The expressions a re-export is written with: references, literals, whitelisted calls, getters. */
function pureExpression(maybe: Node | undefined): boolean {
  const expression = maybe as Node; // the grammar guarantees the children asked for; `undefined` falls to `default`
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
      return (
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
        return property.type === 'Property' && (isGetter || pureExpression(value));
      });
    case 'CallExpression':
      return pureCall(expression);
    default:
      return false;
  }
}

function pureStatement(statement: Node): boolean {
  switch (statement.type) {
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

/** One top-level statement of a facade. */
function facadeStatement(statement: Node): boolean {
  switch (statement.type) {
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
      return true;
    case 'ExportNamedDeclaration':
      return statement.declaration === null; // `export { a }` / `export { a } from '...'`, not `export function f(){}`
    case 'ExpressionStatement': {
      // a directive, or an assignment / call of the re-export language: never a bare reference or literal
      const expression = node(statement, 'expression');
      return (
        statement.directive !== undefined ||
        ((expression?.type === 'AssignmentExpression' || expression?.type === 'CallExpression') &&
          pureExpression(expression))
      );
    }
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
 * Whether a bundle holds no code of its own: only imports and re-exports (ESM, or Rollup's CommonJS shape with its
 * `export *` loop and interop helpers), plus the Bugsee registration the stamp appended: ONE trailing line carrying the
 * marker, accepted only when the stamp's `//# debugId=` comment follows it. A marker earlier in the file is the
 * bundle's own code (an SDK reads `_bugseeDebugIds`), so it stays. Anything it cannot read, or that does something
 * (a function, a call, a declaration), is real code, and an empty map for it is a stripped one.
 */
export function isFacadeCode(code: string): boolean {
  const lines = code.split('\n');
  let sawDebugId = false;
  let removedStub = false;
  for (let last = lines.at(-1); last !== undefined; last = lines.at(-1)) {
    const text = last.trim();
    if (text.startsWith('//')) {
      sawDebugId ||= text.startsWith('//# debugId=');
    } else if (text !== '') {
      if (!(sawDebugId && !removedStub && text.includes(REGISTRATION))) {
        break;
      }
      removedStub = true; // the one registration line the stamp appended
    }
    lines.pop();
  }
  let program: Node;
  try {
    program = parse(lines.join('\n'), {
      ecmaVersion: 'latest',
      sourceType: 'module',
    }) as unknown as Node;
  } catch {
    return false; // unreadable: not a facade
  }
  return nodes(program, 'body').every(facadeStatement);
}
