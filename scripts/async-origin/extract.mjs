// Extracts every promise-returning method declared in TypeScript's lib.dom.d.ts. This is the SOURCE OF TRUTH for the
// async-origin patch table (docs/design/async-origin-capture.md §3, §5): the committed snapshot is regenerated from it, and
// a drift test fails when a new TypeScript release adds an API, forcing a classification decision.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

/** @returns {{ typescript: string, interfaces: Record<string, { mixin: boolean, methods: string[] }> }} */
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
        constructible.add(declaration.name.getText(source));
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
  return { typescript: ts.version, interfaces };
}
