// Extracts every promise-returning method declared in TypeScript's lib.dom.d.ts. This is the SOURCE OF TRUTH for the
// async-origin patch table (docs/design/async-origin-capture.md §3, §5): the committed snapshot is regenerated from it, and
// a drift test fails when a new TypeScript release adds an API, forcing a classification decision.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

/**
 * `statics`: promise-returning methods on the CONSTRUCTOR side (`declare var X: { requestPermission(): Promise<…> }`), which the
 * prototype wrapper does not reach. `constructors`: every declared global constructor (to validate a mixin row's targets); it is
 * not written to the committed snapshot.
 * @returns {{ typescript: string, interfaces: Record<string, { mixin: boolean, methods: string[] }>, statics: Record<string, string[]>, constructors: string[] }}
 */
export function extractDomPromiseMethods(
  libDomPath = createRequire(import.meta.url).resolve('typescript/lib/lib.dom.d.ts'),
) {
  const source = ts.createSourceFile(
    'lib.dom.d.ts',
    readFileSync(libDomPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const constructible = new Set(); // `declare var X: {...}` — a real global with a prototype
  const methods = new Map();
  const statics = new Map();
  const returnsPromise = (node) => {
    const type = node.type;
    return (
      type !== undefined &&
      ts.isTypeReferenceNode(type) &&
      type.typeName.getText(source) === 'Promise'
    );
  };
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(source);
        constructible.add(name);
        const type = declaration.type;
        if (type !== undefined && ts.isTypeLiteralNode(type)) {
          const found = type.members
            .filter((member) => ts.isMethodSignature(member) && returnsPromise(member))
            .map((member) => member.name.getText(source));
          if (found.length > 0) {
            statics.set(name, found.sort());
          }
        }
      }
    } else if (ts.isInterfaceDeclaration(statement)) {
      const found = methods.get(statement.name.text) ?? new Set();
      for (const member of statement.members) {
        if (ts.isMethodSignature(member) && returnsPromise(member)) {
          found.add(member.name.getText(source));
        }
      }
      if (found.size > 0) {
        methods.set(statement.name.text, found);
      }
    }
  }
  const interfaces = {};
  for (const name of [...methods.keys()].sort()) {
    interfaces[name] = { mixin: !constructible.has(name), methods: [...methods.get(name)].sort() };
  }
  return {
    typescript: ts.version,
    interfaces,
    statics: Object.fromEntries([...statics].sort(([a], [b]) => (a < b ? -1 : 1))),
    constructors: [...constructible].sort(),
  };
}
