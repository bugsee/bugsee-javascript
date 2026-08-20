import fc from 'fast-check';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import { componentAnnotatePreprocessor } from './index';

/**
 * Property-based tests for the Svelte markup transform, driven through the REAL `svelte/compiler` parser.
 *
 * The unit tests next to `annotate.ts` feed it hand-built ASTs, which is the only way to pin the walker's
 * shape handling — but it also means nothing there proves the SPLICE MATH is right against a parser that
 * actually produced the offsets. This file closes that: it generates arbitrary Svelte markup, runs the
 * real preprocessor over it, and asserts invariants that a broken offset, a mishandled attribute or a
 * missed idempotency check would all violate.
 *
 * The strongest of them is the reconstruction property — deleting every attribute the plugin inserted must
 * give back the ORIGINAL source, byte for byte. A transform that only ever inserts its own attribute at a
 * correct offset satisfies it; almost any other bug does not.
 */

const ATTRIBUTE = 'data-bugsee-component';
const MANUAL = 'HandWritten';
const NAME = 'Probe';
const FILENAME = `/src/lib/${NAME}.svelte`;

const pre = componentAnnotatePreprocessor();
const run = (content: string, filename = FILENAME): string | undefined =>
  pre.markup({ content, filename })?.code;

// ── a small Svelte markup grammar ─────────────────────────────────────────────────────────────────────
// `p` is deliberately absent: HTML's implicit-close rule for <p> makes `<p><hr/></p>` a genuine syntax
// error, which would generate INVALID Svelte rather than an interesting case.
const HOST_TAGS = ['div', 'span', 'li', 'section', 'b', 'em', 'a'] as const;
const VOID_TAGS = ['input', 'img', 'br', 'hr'] as const;
const COMPONENT_TAGS = ['Widget', 'Box', 'Card'] as const;
const ATTRS = ['', ' class="a"', ' {...rest}', ' style="color:red"', ' id={id}'] as const;

type Markup =
  | { kind: 'text'; value: string }
  | { kind: 'el'; tag: string; attrs: string; manual: boolean; children: Markup[] }
  | { kind: 'void'; tag: string; attrs: string; manual: boolean }
  | { kind: 'block'; open: string; close: string; children: Markup[] };

const isHost = (tag: string): boolean =>
  (HOST_TAGS as readonly string[]).includes(tag) || (VOID_TAGS as readonly string[]).includes(tag);

const markup: fc.Arbitrary<Markup> = fc.letrec<{ node: Markup }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3, depthIdentifier: 'markup' },
    fc.record({
      kind: fc.constant('text' as const),
      // no `<`, `{` or `}`: those would start markup of their own and change what is being generated
      value: fc.stringMatching(/^[a-zA-Z0-9 .,!?éü😀-]{0,12}$/u),
    }),
    fc.record({
      kind: fc.constant('void' as const),
      tag: fc.constantFrom(...VOID_TAGS),
      attrs: fc.constantFrom(...ATTRS),
      manual: fc.boolean(),
    }),
    fc.record({
      kind: fc.constant('el' as const),
      tag: fc.oneof(fc.constantFrom(...HOST_TAGS), fc.constantFrom(...COMPONENT_TAGS)),
      attrs: fc.constantFrom(...ATTRS),
      manual: fc.boolean(),
      children: fc.array(tie('node'), { maxLength: 3 }),
    }),
    fc
      .record({
        block: fc.constantFrom(
          { open: '{#if cond}', close: '{/if}' },
          { open: '{#each items as item}', close: '{/each}' },
          { open: '{#key k}', close: '{/key}' },
        ),
        children: fc.array(tie('node'), { maxLength: 3 }),
      })
      .map(({ block, children }) => ({
        kind: 'block' as const,
        open: block.open,
        close: block.close,
        children,
      })),
  ),
})).node;

/** A `manual` flag only makes sense on a host tag — on a component it is an ordinary prop. */
const normalise = (node: Markup): Markup => {
  if (node.kind === 'el') {
    return {
      ...node,
      manual: node.manual && isHost(node.tag),
      children: node.children.map(normalise),
    };
  }
  if (node.kind === 'block') return { ...node, children: node.children.map(normalise) };
  return node;
};

function render(node: Markup): string {
  const manualAttr = (m: boolean): string => (m ? ` ${ATTRIBUTE}="${MANUAL}"` : '');
  switch (node.kind) {
    case 'text':
      return node.value;
    case 'void':
      return `<${node.tag}${node.attrs}${manualAttr(node.manual)} />`;
    case 'block':
      return `${node.open}${node.children.map(render).join('')}${node.close}`;
    default:
      return `<${node.tag}${node.attrs}${manualAttr(node.manual)}>${node.children
        .map(render)
        .join('')}</${node.tag}>`;
  }
}

const countHosts = (node: Markup): number => {
  if (node.kind === 'void') return 1;
  if (node.kind === 'text') return 0;
  const children = node.children.reduce((n, c) => n + countHosts(c), 0);
  return node.kind === 'block' ? children : children + (isHost(node.tag) ? 1 : 0);
};
const countManual = (node: Markup): number => {
  if (node.kind === 'text') return 0;
  if (node.kind === 'void') return node.manual ? 1 : 0;
  const children = node.children.reduce((n, c) => n + countManual(c), 0);
  return node.kind === 'block' ? children : children + (node.manual ? 1 : 0);
};

const documents = fc
  .array(markup, { minLength: 1, maxLength: 4 })
  .map((nodes) => nodes.map(normalise));
const sourceOf = (nodes: Markup[]): string => nodes.map(render).join('');

/** Only markup the real compiler accepts is in scope — the plugin defers to Svelte for syntax errors. */
const parses = (source: string): boolean => {
  try {
    parse(source, { filename: FILENAME });
    return true;
  } catch {
    return false;
  }
};

describe('annotateMarkup — properties against the real svelte/compiler parser', () => {
  it('annotates EVERY host element exactly once and leaves hand-written ones alone', () => {
    fc.assert(
      fc.property(documents, (nodes) => {
        const source = sourceOf(nodes);
        fc.pre(parses(source));
        const hosts = nodes.reduce((n, x) => n + countHosts(x), 0);
        const manual = nodes.reduce((n, x) => n + countManual(x), 0);
        const out = run(source) ?? source;
        expect(out.split(`${ATTRIBUTE}="${NAME}"`).length - 1).toBe(hosts - manual);
        expect(out.split(`${ATTRIBUTE}="${MANUAL}"`).length - 1).toBe(manual);
        expect(out.split(`${ATTRIBUTE}=`).length - 1).toBe(hosts);
      }),
      { numRuns: 200 },
    );
  });

  it('RECONSTRUCTS the original source when its own insertions are removed (pure insertion)', () => {
    // The offsets come from the parser but are applied to the raw string, and the insertions are applied
    // highest-first so earlier offsets stay valid. One arithmetic slip corrupts the user's markup —
    // silently, at build time. Nothing but the plugin's own attribute may differ from the input.
    fc.assert(
      fc.property(documents, (nodes) => {
        const source = sourceOf(nodes);
        fc.pre(parses(source));
        const out = run(source) ?? source;
        expect(out.split(` ${ATTRIBUTE}="${NAME}"`).join('')).toBe(source);
      }),
      { numRuns: 200 },
    );
  });

  it('emits markup that the real Svelte parser still accepts', () => {
    fc.assert(
      fc.property(documents, (nodes) => {
        fc.pre(parses(sourceOf(nodes)));
        const out = run(sourceOf(nodes));
        if (out !== undefined) expect(() => parse(out, { filename: FILENAME })).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('preserves line numbers (the attribute is spliced inline, never on a new line)', () => {
    // Every downstream tool — Svelte's own error reporting, the source maps this SDK uploads — indexes by
    // line. A transform that reflowed the markup would shift all of them.
    fc.assert(
      fc.property(documents, (nodes) => {
        const source = `${sourceOf(nodes)}\n<em>tail</em>\n`;
        fc.pre(parses(source));
        const out = run(source) ?? source;
        expect(out.split('\n').length).toBe(source.split('\n').length);
      }),
      { numRuns: 150 },
    );
  });

  it('is IDEMPOTENT — a second pass over its own output finds nothing left to do', () => {
    fc.assert(
      fc.property(documents, (nodes) => {
        fc.pre(parses(sourceOf(nodes)));
        const once = run(sourceOf(nodes));
        if (once !== undefined) expect(run(once)).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });

  it('leaves a non-.svelte file completely untouched, whatever its content', () => {
    fc.assert(
      fc.property(documents, fc.constantFrom('/src/app.ts', 'x.js', 'README.md'), (nodes, file) => {
        expect(run(sourceOf(nodes), file)).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});

describe('the component name reaches the markup safely, for any file name', () => {
  // Component names come from PATHS, and a path can contain anything a filesystem allows — including the
  // three characters that would otherwise break out of the attribute value.
  const basename = fc.stringMatching(/^[A-Za-z0-9 "&<>'_.-]{1,12}$/).filter((b) => {
    const n = b.endsWith('.svelte') ? b.slice(0, -7) : b;
    return n !== '' && n !== 'index' && !n.startsWith('+');
  });

  it('emits an attribute value that parses back to exactly the component name', () => {
    fc.assert(
      fc.property(basename, (base) => {
        const out = run('<div>x</div>', `/src/${base}.svelte`);
        expect(out).toBeDefined();
        const ast = parse(out as string) as { html?: { children?: unknown[] } };
        const el = ast.html?.children?.[0] as {
          attributes: Array<{ name: string; value: Array<{ data: string }> | true }>;
        };
        const attr = el.attributes.find((a) => a.name === ATTRIBUTE);
        expect(attr).toBeDefined();
        const value = attr?.value;
        // an empty name would parse as a boolean attribute; ours always has a text value
        expect(Array.isArray(value) ? value.map((v) => v.data).join('') : '').toBe(base);
      }),
      { numRuns: 200 },
    );
  });
});
