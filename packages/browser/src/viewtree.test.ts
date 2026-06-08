import type { CaptureDataEntry } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDomSnapshot,
  createViewtreeSnapshotSource,
  type DomSnapshotEnv,
  type ViewNode,
} from './viewtree';

afterEach(() => vi.unstubAllGlobals());

// A fake element: structural fields for describeTarget + getBoundingClientRect + element children.
function el(props: {
  tag: string;
  id?: string;
  attrs?: Record<string, string>;
  type?: string;
  text?: string;
  masked?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  children?: unknown[];
  throws?: boolean;
}) {
  const attrs = props.attrs ?? {};
  return {
    tagName: props.tag.toUpperCase(),
    id: props.id ?? '',
    type: props.type,
    textContent: props.text,
    isContentEditable: false,
    getAttribute: (name: string) => attrs[name] ?? null,
    closest: (selector: string) => {
      if (props.throws) throw new SyntaxError('exotic node');
      return selector === '[data-bugsee-hidden]' && props.masked ? {} : null;
    },
    getBoundingClientRect: () => props.rect ?? { x: 0, y: 0, width: 0, height: 0 },
    children: props.children ?? [],
  };
}

const snap = (env: DomSnapshotEnv) => createDomSnapshot(env)();

describe('createDomSnapshot', () => {
  it('builds a nested view tree with descriptors + rounded rects + children', () => {
    const tree = snap({
      document: {
        body: el({
          tag: 'body',
          rect: { x: 0, y: 0, width: 100, height: 200 },
          children: [
            el({
              tag: 'button',
              id: 'ok',
              attrs: { class: 'btn' },
              text: 'OK',
              rect: { x: 10.4, y: 20.6, width: 50.5, height: 30.1 },
            }),
          ],
        }),
      },
    });
    expect(tree).toEqual({
      tag: 'body',
      rect: { x: 0, y: 0, width: 100, height: 200 },
      children: [
        {
          tag: 'button',
          id: 'ok',
          class: 'btn',
          text: 'OK',
          rect: { x: 10, y: 21, width: 51, height: 30 }, // Math.round each
        },
      ],
    });
  });

  it('captures a form-control type on its node', () => {
    const tree = snap({
      document: {
        body: el({
          tag: 'body',
          children: [
            el({ tag: 'input', type: 'email', rect: { x: 0, y: 0, width: 5, height: 5 } }),
          ],
        }),
      },
    });
    expect((tree as ViewNode).children?.[0]).toEqual({
      tag: 'input',
      type: 'email',
      rect: { x: 0, y: 0, width: 5, height: 5 },
    });
  });

  it('masks a data-bugsee-hidden subtree to {tag, masked, rect} with no children/text', () => {
    const tree = snap({
      document: {
        body: el({
          tag: 'body',
          children: [
            el({
              tag: 'div',
              id: 'secret',
              text: 'private',
              masked: true,
              rect: { x: 1, y: 2, width: 3, height: 4 },
              children: [el({ tag: 'span', text: 'card number' })],
            }),
          ],
        }),
      },
    });
    expect((tree as ViewNode).children).toEqual([
      { tag: 'div', masked: true, rect: { x: 1, y: 2, width: 3, height: 4 } },
    ]);
  });

  it('skips non-visual nodes (script/style/noscript/template)', () => {
    const tree = snap({
      document: {
        body: el({
          tag: 'body',
          children: [
            el({ tag: 'script', text: 'evil()' }),
            el({ tag: 'style', text: 'body{}' }),
            el({ tag: 'noscript' }),
            el({ tag: 'template' }),
            el({ tag: 'p', text: 'kept' }),
          ],
        }),
      },
    });
    expect((tree as ViewNode).children?.map((c) => c.tag)).toEqual(['p']);
  });

  it('stops recursing at maxDepth', () => {
    const leaf = el({ tag: 'span' });
    const mid = el({ tag: 'div', children: [leaf] });
    const tree = snap({ document: { body: el({ tag: 'body', children: [mid] }) }, maxDepth: 1 });
    // depth 0 = body, depth 1 = div (kept), depth 2 = span (beyond maxDepth → dropped).
    const div = (tree as ViewNode).children?.[0];
    expect(div?.tag).toBe('div');
    expect(div?.children).toBeUndefined();
  });

  it('stops once maxNodes is exhausted', () => {
    const body = el({
      tag: 'body',
      children: [el({ tag: 'a' }), el({ tag: 'b' }), el({ tag: 'i' })],
    });
    // budget 2 = body + the first child only.
    const tree = snap({ document: { body }, maxNodes: 2 });
    expect((tree as ViewNode).children?.map((c) => c.tag)).toEqual(['a']);
  });

  it('handles minimal/edge child nodes (no rect, no children property, no tag)', () => {
    const tree = snap({
      document: {
        body: el({
          tag: 'body',
          children: [
            { tagName: 'DIV' }, // no getBoundingClientRect (→ no rect) and no children property (→ ?? [])
            {}, // no tagName → describeTarget yields {} → node dropped
          ],
        }),
      },
    });
    expect((tree as ViewNode).children).toEqual([{ tag: 'div' }]);
  });

  it('falls back to documentElement when there is no body', () => {
    const tree = snap({ document: { documentElement: el({ tag: 'html' }) } });
    expect((tree as ViewNode).tag).toBe('html');
  });

  it('returns undefined when no root element is available', () => {
    expect(snap({ document: {} })).toBeUndefined();
    expect(snap({})).toBeUndefined(); // no document at all (non-DOM context)
  });

  it('skips a node that throws (exotic/instrumented DOM), keeping the rest of the tree', () => {
    const tree = snap({
      document: {
        body: el({
          tag: 'body',
          children: [el({ tag: 'web-component', throws: true }), el({ tag: 'p', text: 'safe' })],
        }),
      },
    });
    expect((tree as ViewNode).children?.map((c) => c.tag)).toEqual(['p']);
  });

  it('defaults to the global document', () => {
    vi.stubGlobal('document', { body: el({ tag: 'body', children: [el({ tag: 'main' })] }) });
    const tree = createDomSnapshot()();
    expect((tree as ViewNode).children?.[0]?.tag).toBe('main');
  });
});

describe('createViewtreeSnapshotSource', () => {
  it('produces a single viewtree CaptureDataEntry stamped with the report time', () => {
    const source = createViewtreeSnapshotSource({
      document: { body: el({ tag: 'body', rect: { x: 0, y: 0, width: 9, height: 9 } }) },
    });
    const entries = source(1234) as CaptureDataEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe('viewtree');
    expect(entries[0]?.timestamp).toBe(1234);
    expect(entries[0]?.data).toEqual({ tag: 'body', rect: { x: 0, y: 0, width: 9, height: 9 } });
  });

  it('produces no entry when there is no DOM to snapshot', () => {
    const source = createViewtreeSnapshotSource({ document: {} });
    expect(source(1)).toEqual([]);
  });
});
