import { describe, expect, it, vi } from 'vitest';
import { annotateMarkup } from './annotate';

// Unit-tested with FAKE ASTs (a `parse` fn returning a hand-built tree) — no `svelte` dependency here. The
// element `start` offsets are made to match real positions inside the `content` string so the splice math is
// exercised for real. Both AST shapes are covered: legacy (`html`/`children`/type `Element`) and modern
// (`fragment`/`nodes`/type `RegularElement`).

const legacyParse = (children: unknown[]) => () => ({ html: { type: 'Fragment', children } });
const modernParse = (nodes: unknown[]) => () => ({ fragment: { type: 'Fragment', nodes } });

const el = (name: string, start: number, over: Record<string, unknown> = {}) => ({
  type: 'Element',
  name,
  start,
  attributes: [],
  children: [],
  ...over,
});

describe('annotateMarkup', () => {
  it('annotates a single host element (legacy AST shape)', () => {
    const content = '<div></div>';
    const code = annotateMarkup(content, 'Foo', legacyParse([el('div', 0)]));
    expect(code).toBe('<div data-bugsee-component="Foo"></div>');
  });

  it('annotates a host element in the modern AST shape (RegularElement / fragment.nodes)', () => {
    const content = '<p></p>';
    const code = annotateMarkup(
      content,
      'Bar',
      modernParse([
        { type: 'RegularElement', name: 'p', start: 0, attributes: [], fragment: { nodes: [] } },
      ]),
    );
    expect(code).toBe('<p data-bugsee-component="Bar"></p>');
  });

  it('annotates ALL host elements, descending into children (correct offsets via descending splice)', () => {
    const content = '<div><span>x</span></div>';
    const inner = el('span', 5);
    const code = annotateMarkup(content, 'C', legacyParse([el('div', 0, { children: [inner] })]));
    // Each opening tag gets the attribute right after its tag name — offset math must be exact.
    expect(code).toContain('<div data-bugsee-component="C">');
    expect(code).toContain('<span data-bugsee-component="C">');
    expect(code).toBe(
      '<div data-bugsee-component="C"><span data-bugsee-component="C">x</span></div>',
    );
  });

  it('skips component nodes (PascalCase / non-Element type) but annotates their slotted host children', () => {
    const content = '<Child><b>hi</b></Child>';
    const slotted = el('b', 7);
    const code = annotateMarkup(
      content,
      'Page',
      legacyParse([{ type: 'InlineComponent', name: 'Child', start: 0, children: [slotted] }]),
    );
    expect(code).toBe('<Child><b data-bugsee-component="Page">hi</b></Child>');
  });

  it('descends into a control-flow block to annotate the element inside it', () => {
    const content = '{#if x}<p>hi</p>{/if}';
    const inner = el('p', 7);
    const code = annotateMarkup(
      content,
      'Cond',
      legacyParse([{ type: 'IfBlock', start: 0, children: [inner] }]),
    );
    expect(code).toBe('{#if x}<p data-bugsee-component="Cond">hi</p>{/if}');
  });

  it('does not re-annotate an element that already carries the attribute', () => {
    const content = '<div data-bugsee-component="Manual"></div>';
    const node = el('div', 0, {
      attributes: [{ type: 'Attribute', name: 'data-bugsee-component' }],
    });
    expect(annotateMarkup(content, 'Auto', legacyParse([node]))).toBeUndefined();
  });

  it('skips an Element node whose tag name is not lowercase (only host/DOM tags are annotated)', () => {
    // pins isHostTag: a `type:'Element'` node with a PascalCase / capitalized name (e.g. an invalid
    // capitalized custom element) must NOT be annotated.
    const content = '<Foo></Foo>';
    expect(annotateMarkup(content, 'X', legacyParse([el('Foo', 0)]))).toBeUndefined();
  });

  it('annotates a host element that has no attributes field at all (array guard tolerates its absence)', () => {
    const content = '<hr>';
    const node = { type: 'Element', name: 'hr', start: 0 }; // no `attributes` key
    expect(annotateMarkup(content, 'Y', legacyParse([node]))).toBe(
      '<hr data-bugsee-component="Y">',
    );
  });

  it('escapes characters that are unsafe in an attribute value', () => {
    const content = '<i></i>';
    const code = annotateMarkup(content, 'A"&<B', legacyParse([el('i', 0)]));
    expect(code).toBe('<i data-bugsee-component="A&quot;&amp;&lt;B"></i>');
  });

  it('returns undefined when the markup has no host elements', () => {
    expect(
      annotateMarkup(
        '<Child/>',
        'X',
        legacyParse([{ type: 'InlineComponent', name: 'Child', start: 0 }]),
      ),
    ).toBeUndefined();
    expect(
      annotateMarkup('text', 'X', legacyParse([{ type: 'Text', data: 'text', start: 0 }])),
    ).toBeUndefined();
  });

  it('returns undefined when parse throws (lets Svelte report the real syntax error)', () => {
    const throwingParse = vi.fn(() => {
      throw new Error('Unexpected token');
    });
    expect(annotateMarkup('<div', 'X', throwingParse)).toBeUndefined();
    expect(throwingParse).toHaveBeenCalledOnce();
  });

  it('returns undefined when the parse result has no markup root (neither fragment nor html)', () => {
    expect(annotateMarkup('x', 'X', () => ({ instance: {} }))).toBeUndefined();
    expect(annotateMarkup('x', 'X', () => null)).toBeUndefined();
  });

  it('ignores an element node with a non-numeric start (cannot compute an insertion offset)', () => {
    const content = '<div></div>';
    const broken = { type: 'Element', name: 'div', start: 'nope', attributes: [] };
    expect(annotateMarkup(content, 'X', legacyParse([broken]))).toBeUndefined();
  });

  it('does not loop forever on an AST with a back-reference (visited guard)', () => {
    const content = '<div></div>';
    const node: Record<string, unknown> = el('div', 0);
    node.self = node; // cyclic reference
    const code = annotateMarkup(content, 'Cyc', legacyParse([node]));
    expect(code).toBe('<div data-bugsee-component="Cyc"></div>');
  });
});

// The walker's defensive guards were entirely unpinned: every one of them could be deleted and the suite
// stayed green, even though removing them turns a malformed node into a THROWN build error rather than a
// skipped element. A preprocessor that throws takes the user's build down with it.
describe('annotateMarkup — malformed / exotic AST nodes are skipped, never fatal', () => {
  it('ignores an element node whose name is not a string', () => {
    // Without the typeof guard, `isHostTag(undefined)` stringifies to "undefined" — which starts with a
    // lowercase letter, so the node is taken for a host element and `name.length` then throws.
    const content = '<div></div>';
    for (const name of [undefined, 42, null, { toString: () => 'div' }]) {
      const node = { type: 'Element', name, start: 0, attributes: [] };
      expect(annotateMarkup(content, 'X', legacyParse([node]))).toBeUndefined();
    }
  });

  it('ignores a null / primitive entry inside an element’s attributes array', () => {
    // Reading `.type` off a null attribute throws. The element must simply be treated as un-annotated.
    const content = '<div></div>';
    const node = el('div', 0, { attributes: [null, 'stray', 7, undefined] });
    expect(annotateMarkup(content, 'X', legacyParse([node]))).toBe(
      '<div data-bugsee-component="X"></div>',
    );
  });

  it('only a real Attribute counts as already-annotated — a same-named directive/spread does not', () => {
    // `isAnnotated` matches on NAME; without the `type === 'Attribute'` check any node that happened to
    // carry that name would suppress the annotation and the component would go unattributed.
    const content = '<div></div>';
    const node = el('div', 0, {
      attributes: [{ type: 'Spread', name: 'data-bugsee-component' }],
    });
    expect(annotateMarkup(content, 'X', legacyParse([node]))).toBe(
      '<div data-bugsee-component="X"></div>',
    );
  });
});
