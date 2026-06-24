import type { types as BabelTypes, NodePath, PluginObj } from '@babel/core';

// @bugsee/babel-plugin-component-annotate (frontend-adapters depth pass D3). Annotates each HOST (lowercase-
// tag) JSX element with `data-bugsee-component="<ComponentName>"` — the name of the enclosing framework
// component — so the @bugsee/browser D2 runtime can attribute a click/error to a COMPONENT name that
// survives minification (the literal name is emitted at build time). Covers the JSX ecosystems (React /
// Preact / Solid). A component is a PascalCase function/class; host elements are lowercase tags (component
// elements like <Widget/> become props, not DOM attributes, so they are skipped). JSX in a nested callback
// (e.g. a `.map`) is attributed to the enclosing component (the callback is not itself a component).

const ATTRIBUTE = 'data-bugsee-component';
const isComponentName = (name: string): boolean => /^[A-Z]/.test(name); // PascalCase heuristic
const isHostTag = (tag: string): boolean => /^[a-z]/.test(tag); // lowercase = a DOM/host element

type FnOrClassPath = NodePath<
  | BabelTypes.FunctionDeclaration
  | BabelTypes.FunctionExpression
  | BabelTypes.ArrowFunctionExpression
  | BabelTypes.ClassDeclaration
  | BabelTypes.ClassExpression
>;

/** The name of the const a fn/class EXPRESSION is assigned to — directly (`const Foo = () => …`) or through a
 *  single wrapping call (`const Foo = memo(() => …)` / `forwardRef((p, ref) => …)`) — else undefined. */
function assignedVariableName(t: typeof BabelTypes, path: FnOrClassPath): string | undefined {
  const node = path.node;
  if (
    !t.isArrowFunctionExpression(node) &&
    !t.isFunctionExpression(node) &&
    !t.isClassExpression(node)
  ) {
    return undefined; // a declaration, not an expression — handled by its own id below
  }
  // Unwrap one wrapping call (memo / forwardRef / observer / …): `const Foo = memo(fn)`.
  const parent = t.isCallExpression(path.parent) ? path.parentPath?.parent : path.parent;
  return t.isVariableDeclarator(parent) && t.isIdentifier(parent.id) ? parent.id.name : undefined;
}

/** The component name a function/class path defines, or undefined when it is not a (PascalCase) component.
 *  The assigned-const name wins (so `const Foo = class Bar {}` and `const Foo = memo(fn)` both → `Foo`); a
 *  bare declaration falls back to its own id (`function Foo(){}` / `class Foo {}`). */
function componentNameOf(t: typeof BabelTypes, path: FnOrClassPath): string | undefined {
  const variable = assignedVariableName(t, path);
  if (variable !== undefined) return isComponentName(variable) ? variable : undefined;
  const node = path.node;
  if ((t.isFunctionDeclaration(node) || t.isClassDeclaration(node)) && node.id) {
    return isComponentName(node.id.name) ? node.id.name : undefined;
  }
  return undefined;
}

function hasAttribute(node: BabelTypes.JSXOpeningElement): boolean {
  return node.attributes.some(
    (attr) =>
      attr.type === 'JSXAttribute' &&
      attr.name.type === 'JSXIdentifier' &&
      attr.name.name === ATTRIBUTE,
  );
}

export default function componentAnnotatePlugin(babel: { types: typeof BabelTypes }): PluginObj {
  const t = babel.types;
  // The enclosing-component name stack — a closure reset per file in `pre()` (babel transforms sequentially
  // per plugin instance, so a single closure is safe).
  let componentStack: string[] = [];
  const componentVisit = {
    enter(path: FnOrClassPath): void {
      const name = componentNameOf(t, path);
      if (name !== undefined) componentStack.push(name);
    },
    exit(path: FnOrClassPath): void {
      if (componentNameOf(t, path) !== undefined) componentStack.pop();
    },
  };
  return {
    name: 'bugsee-component-annotate',
    pre(): void {
      componentStack = [];
    },
    visitor: {
      FunctionDeclaration: componentVisit,
      FunctionExpression: componentVisit,
      ArrowFunctionExpression: componentVisit,
      ClassDeclaration: componentVisit,
      ClassExpression: componentVisit,
      JSXOpeningElement(path): void {
        const current = componentStack[componentStack.length - 1];
        if (current === undefined) return; // not inside a component
        const name = path.node.name;
        if (name.type !== 'JSXIdentifier' || !isHostTag(name.name)) return; // member/namespaced/component → skip
        if (hasAttribute(path.node)) return; // already annotated (manual / a prior pass)
        path.node.attributes.push(
          t.jsxAttribute(t.jsxIdentifier(ATTRIBUTE), t.stringLiteral(current)),
        );
      },
    },
  };
}

export { componentAnnotatePlugin };
