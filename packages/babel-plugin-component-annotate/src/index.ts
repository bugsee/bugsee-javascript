import type { types as BabelTypes, NodePath, PluginObj, PluginPass } from '@babel/core';

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
 *  The assigned-const name wins (so `const Foo = class Bar {}` and `const Foo = memo(fn)` both → `Foo`);
 *  otherwise the node's OWN id is used, for a declaration (`function Foo(){}` / `class Foo {}`) and for a
 *  named EXPRESSION alike.
 *
 *  The named-expression fallback is not an edge case: `export default memo(function Card() { … })` and
 *  `export default forwardRef(function Input(props, ref) { … })` are the shapes React's own documentation
 *  shows, and with no enclosing `const` there is nothing else to name them by. Without it they produced
 *  zero annotations — silently, since the build still succeeded. */
function componentNameOf(t: typeof BabelTypes, path: FnOrClassPath): string | undefined {
  const variable = assignedVariableName(t, path);
  if (variable !== undefined) return isComponentName(variable) ? variable : undefined;
  const node = path.node;
  // ArrowFunctionExpression is the one member of the union with no `id` at all — hence the guard.
  if (!t.isArrowFunctionExpression(node) && node.id) {
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

/** The per-transform state this plugin keeps — babel's own `PluginPass` (one per `transformSync`), plus
 *  our stack. Intersecting rather than redeclaring keeps the visitor signatures assignable to babel's. */
type AnnotateState = PluginPass & { bugseeComponentStack?: string[] };

export default function componentAnnotatePlugin(babel: { types: typeof BabelTypes }): PluginObj {
  const t = babel.types;

  /**
   * The enclosing-component name stack, held on the per-transform STATE rather than in a closure.
   *
   * It used to be a closure on the plugin INSTANCE, reset in `pre()`. Babel calls `pre()` per File, but the
   * instance is shared — so a peer plugin that runs a nested `transformSync` mid-traversal (the
   * `babel-plugin-macros` / `preval` / `codegen` family) re-entered `pre()` and wiped the OUTER file's
   * stack, silently dropping every remaining annotation in it. Measured in the review: 2 expected
   * annotations became 0.
   *
   * Babel creates one `PluginPass` per transform, including a nested one, so keying on the state makes the
   * stacks independent by construction — the inner transform can no longer reach the outer one's.
   */
  const stackOf = (state: AnnotateState): string[] => {
    state.bugseeComponentStack ??= [];
    return state.bugseeComponentStack;
  };

  const componentVisit = {
    enter(path: FnOrClassPath, state: AnnotateState): void {
      const name = componentNameOf(t, path);
      if (name !== undefined) stackOf(state).push(name);
    },
    exit(path: FnOrClassPath, state: AnnotateState): void {
      // POP, not shift: the innermost component is the one that closed.
      if (componentNameOf(t, path) !== undefined) stackOf(state).pop();
    },
  };
  return {
    name: 'bugsee-component-annotate',
    visitor: {
      FunctionDeclaration: componentVisit,
      FunctionExpression: componentVisit,
      ArrowFunctionExpression: componentVisit,
      ClassDeclaration: componentVisit,
      ClassExpression: componentVisit,
      JSXOpeningElement(path, state: AnnotateState): void {
        // The INNERMOST enclosing component owns the element — the last entry, not the first.
        const stack = stackOf(state);
        const current = stack[stack.length - 1];
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
