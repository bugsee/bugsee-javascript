import { transformSync } from '@babel/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import componentAnnotatePlugin from './index';

/**
 * Property-based tests for the JSX component-annotation transform.
 *
 * This plugin's input is ARBITRARY USER SOURCE, which is exactly the input class hand-written examples
 * under-sample: real `.tsx` files nest components in each other, spread props onto host elements, mix
 * host and component tags at every depth, and get re-run by a second build pass. Every property below is
 * an invariant or a differential (idempotence, no double-annotation, exact attribution counts,
 * byte-identity for input the plugin must ignore), so a counterexample is a defect rather than a changed
 * opinion.
 *
 * Kept to a few hundred runs so it stays in the normal `pnpm test` run.
 */

const ATTRIBUTE = 'data-bugsee-component';
/** A pre-existing annotation the plugin must never overwrite or duplicate. */
const MANUAL = 'ManuallyPinned';

const transform = (code: string): string =>
  transformSync(code, {
    plugins: ['@babel/plugin-syntax-jsx', componentAnnotatePlugin],
    configFile: false,
    babelrc: false,
  })?.code ?? '';

/** The same babel run WITHOUT our plugin — the differential baseline (parse + reprint only). */
const baseline = (code: string): string =>
  transformSync(code, {
    plugins: ['@babel/plugin-syntax-jsx'],
    configFile: false,
    babelrc: false,
  })?.code ?? '';

const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

// ── generators ────────────────────────────────────────────────────────────────────────────────────────
// PascalCase (a component by this plugin's heuristic) and camelCase (a plain helper — never a component).
const componentName = fc.stringMatching(/^[A-Z][A-Za-z0-9]{0,7}$/);
// …filtered against the reserved words, or the generator eventually emits `function if() {}` and the
// counterexample is a JS syntax error rather than anything about this plugin. (PascalCase needs no such
// filter — every reserved word is lowercase.)
const RESERVED = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);
const helperName = fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/).filter((n) => !RESERVED.has(n));

const HOST_TAGS = ['div', 'span', 'p', 'li', 'button', 'section', 'em', 'input', 'img'] as const;
const COMPONENT_TAGS = ['Widget', 'Box', 'Child', 'Panel'] as const;

interface JsxNode {
  tag: string;
  host: boolean;
  /** Already carries `data-bugsee-component="ManuallyPinned"` in the SOURCE. */
  manual: boolean;
  /** Carries a `{...spread}` — the shape that made the attribute walker's type guard load-bearing. */
  spread: boolean;
  children: JsxNode[];
}

const jsxTree: fc.Arbitrary<JsxNode> = fc.letrec<{ node: JsxNode }>((tie) => ({
  node: fc
    .record({
      tag: fc.oneof(fc.constantFrom(...HOST_TAGS), fc.constantFrom(...COMPONENT_TAGS)),
      manual: fc.boolean(),
      spread: fc.boolean(),
      // depth-capped, or the recursion blows the stack before it ever reaches the transform
      children: fc.oneof(
        { maxDepth: 3, depthIdentifier: 'jsx' },
        fc.constant([] as JsxNode[]),
        fc.array(tie('node'), { maxLength: 2 }),
      ),
    })
    .map((n) => {
      const host = HOST_TAGS.includes(n.tag as (typeof HOST_TAGS)[number]);
      // a hand-written `data-bugsee-component` only makes sense on a HOST tag (on a component tag it is
      // an ordinary prop) — keeping it host-only makes every attribute on a component tag the plugin's.
      return { ...n, host, manual: host && n.manual };
    }),
})).node;

function render(node: JsxNode): string {
  const attrs = `${node.spread ? ' {...rest}' : ''}${
    node.manual ? ` ${ATTRIBUTE}="${MANUAL}"` : ''
  }`;
  if (node.children.length === 0) return `<${node.tag}${attrs} />`;
  return `<${node.tag}${attrs}>${node.children.map(render).join('')}</${node.tag}>`;
}

/** Host elements that the plugin should stamp (a manual annotation is left alone, not replaced). */
function countAnnotatable(node: JsxNode): number {
  const self = node.host && !node.manual ? 1 : 0;
  return node.children.reduce((n, c) => n + countAnnotatable(c), self);
}
function countManual(node: JsxNode): number {
  return node.children.reduce((n, c) => n + countManual(c), node.manual ? 1 : 0);
}

/** The declaration forms a component is written in — every one of them names the component `name`. */
const WRAPPERS: ReadonlyArray<(name: string, jsx: string) => string> = [
  (name, jsx) => `function ${name}() { return ${jsx}; }`,
  (name, jsx) => `const ${name} = () => (${jsx});`,
  (name, jsx) => `const ${name} = memo(() => (${jsx}));`,
  (name, jsx) => `const ${name} = memo(function Inner() { return ${jsx}; });`,
  (name, jsx) => `class ${name} extends C { render() { return ${jsx}; } }`,
  // the named-EXPRESSION shapes — no enclosing const, so the function's own id is the only name there is
  (name, jsx) => `export default memo(function ${name}() { return ${jsx}; });`,
  (name, jsx) => `export default forwardRef(function ${name}(p, ref) { return ${jsx}; });`,
];
const wrapper = fc.constantFrom(...WRAPPERS.keys());

describe('componentAnnotatePlugin — properties', () => {
  it('stamps EVERY host element in a component with that component name, and nothing else', () => {
    fc.assert(
      fc.property(componentName, jsxTree, wrapper, (name, tree, w) => {
        const src = (WRAPPERS[w] as (n: string, j: string) => string)(name, render(tree));
        const out = transform(src);
        // exactly one attribute per host element — no misses, no duplicates
        expect(countOf(out, `${ATTRIBUTE}=`)).toBe(countAnnotatable(tree) + countManual(tree));
        expect(countOf(out, `${ATTRIBUTE}="${name}"`)).toBe(countAnnotatable(tree));
        expect(countOf(out, `${ATTRIBUTE}="${MANUAL}"`)).toBe(countManual(tree));
      }),
      { numRuns: 250 },
    );
  });

  it('is IDEMPOTENT — a second pass over its own output changes nothing', () => {
    fc.assert(
      fc.property(componentName, jsxTree, wrapper, (name, tree, w) => {
        const src = (WRAPPERS[w] as (n: string, j: string) => string)(name, render(tree));
        const once = transform(src);
        expect(transform(once)).toBe(once);
      }),
      { numRuns: 250 },
    );
  });

  it('emits output that still PARSES (the transform never produces broken source)', () => {
    fc.assert(
      fc.property(componentName, jsxTree, wrapper, (name, tree, w) => {
        const src = (WRAPPERS[w] as (n: string, j: string) => string)(name, render(tree));
        expect(() => baseline(transform(src))).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('leaves source with no component BYTE-IDENTICAL to the plugin-free baseline', () => {
    // A helper is not a component, so nothing in it may be touched — the transform must be a no-op, not
    // merely "produce no attribute".
    fc.assert(
      fc.property(helperName, jsxTree, (name, tree) => {
        const src = `function ${name}() { return ${render(tree)}; }`;
        expect(transform(src)).toBe(baseline(src));
      }),
      { numRuns: 250 },
    );
  });

  it('never annotates a COMPONENT (PascalCase) JSX tag — only host tags', () => {
    fc.assert(
      fc.property(componentName, jsxTree, (name, tree) => {
        const out = transform(`function ${name}() { return ${render(tree)}; }`);
        for (const tag of COMPONENT_TAGS) expect(out).not.toContain(`<${tag} ${ATTRIBUTE}`);
      }),
      { numRuns: 200 },
    );
  });

  it('attributes to the INNERMOST component when components are nested arbitrarily deep', () => {
    fc.assert(
      fc.property(fc.uniqueArray(componentName, { minLength: 2, maxLength: 4 }), (names) => {
        // function A() { function B() { … } return <span />; } — each level declares the next and
        // returns exactly ONE host element, so each name must appear exactly once in the output.
        const build = (i: number): string =>
          i === names.length ? '' : `function ${names[i]}() { ${build(i + 1)} return <span />; }`;
        const out = transform(build(0));
        for (const n of names) expect(countOf(out, `${ATTRIBUTE}="${n}"`)).toBe(1);
      }),
      { numRuns: 100 },
    );
  });
});
