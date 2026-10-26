import type { eventWithTime } from '@bugsee/rrweb';
import { describe, expect, it, vi } from 'vitest';
import { createIframeGuard } from './iframe-guard';

// Node shapes as the recorder emits them. Types: 0 document, 2 element, 3 text.
let nextId = 1;
const text = (value: string) => ({ type: 3, textContent: value, id: nextId++ });
const el = (tagName: string, attributes: Record<string, unknown>, childNodes: unknown[] = []) => ({
  type: 2,
  tagName,
  attributes,
  childNodes,
  id: nextId++,
});
const doc = (childNodes: unknown[]) => ({ type: 0, childNodes, id: nextId++ });

const snapshot = (node: unknown) =>
  ({
    type: 2,
    timestamp: 1,
    data: { node, initialOffset: { top: 0, left: 0 } },
  }) as unknown as eventWithTime;
const incremental = (data: Record<string, unknown>) =>
  ({ type: 3, timestamp: 2, data }) as unknown as eventWithTime;
const mutation = (
  m: Partial<Record<'adds' | 'texts' | 'attributes' | 'removes', unknown[]>> & {
    isAttachIframe?: boolean;
  },
) => incremental({ source: 0, adds: [], texts: [], attributes: [], removes: [], ...m });

const SOURCE = {
  Mutation: 0,
  MouseMove: 1,
  MouseInteraction: 2,
  Scroll: 3,
  Input: 5,
  TouchMove: 6,
  MediaInteraction: 7,
  StyleSheetRule: 8,
  Selection: 14,
  AdoptedStyleSheet: 15,
  StyleDeclaration: 13,
  Drag: 12,
} as const;

const make = (overrides: Partial<Parameters<typeof createIframeGuard>[0]> = {}) => {
  const onViolation = vi.fn();
  const guard = createIframeGuard({
    blockSelector: 'img,iframe',
    unblockSelector: '.bugsee-show',
    blockClass: 'rr-block',
    onViolation,
    ...overrides,
  });
  return { guard, onViolation };
};

const SECRET = 'GUARD-SECRET';

describe('iframe guard: a blocked iframe is a placeholder, whatever the recorder emitted', () => {
  it('passes events that have nothing to do with iframes through untouched (same object)', () => {
    const { guard, onViolation } = make();
    const events = [
      snapshot(doc([el('html', {}, [el('body', {}, [el('p', {}, [text('hello')])])])])),
      mutation({ adds: [{ parentId: 1, nextId: null, node: el('p', {}, [text('x')]) }] }),
      incremental({ source: SOURCE.Input, id: 3, text: 'x', isChecked: false }),
      incremental({ source: SOURCE.Scroll, id: 3, x: 0, y: 1 }),
      incremental({ source: SOURCE.MouseMove, positions: [{ x: 1, y: 1, id: 3, timeOffset: 0 }] }),
    ];
    for (const e of events) expect(guard(e)).toBe(e);
    expect(onViolation).not.toHaveBeenCalled();
  });

  it('control: an iframe that is not blocked keeps its attached document and its live events', () => {
    const { guard, onViolation } = make({ blockSelector: 'img' }); // iframes are not blocked here
    const frame = el('iframe', { id: 'f' });
    expect(guard(snapshot(doc([frame])))).toBeDefined();
    const attach = mutation({
      isAttachIframe: true,
      adds: [{ parentId: frame.id, nextId: null, node: doc([text(SECRET)]) }],
    });
    expect(guard(attach)).toBe(attach);
    const t = text('later');
    const live = mutation({ texts: [{ id: t.id, value: SECRET }] });
    expect(guard(live)).toBe(live);
    expect(onViolation).not.toHaveBeenCalled();
  });

  it('strips children a blocked placeholder iframe carries in a full snapshot, and reports once', () => {
    const { guard, onViolation } = make();
    const inner = el('p', {}, [text(SECRET)]);
    const frame = el('iframe', { class: 'x', rr_width: '10px', rr_height: '5px' }, [doc([inner])]);
    const out = guard(snapshot(doc([el('body', {}, [frame])])))!;
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(frame.childNodes).toEqual([]);
    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(String(onViolation.mock.calls[0]?.[0])).toMatch(/blocked iframe/);
    // further events of that content are dropped
    const t = guard(mutation({ texts: [{ id: inner.id, value: SECRET }] }));
    expect(t).toBeUndefined();
    expect(onViolation).toHaveBeenCalledTimes(1); // once per guard
  });

  it('decides by the block rules when the recorder forgot the placeholder marker (the fork regression case)', () => {
    const { guard, onViolation } = make();
    const frame = el('iframe', { id: 'plain' }, [doc([text(SECRET)])]);
    guard(snapshot(doc([frame])));
    expect(frame.childNodes).toEqual([]);
    expect(onViolation).toHaveBeenCalledTimes(1);
  });

  it('honours blockClass and unblockSelector', () => {
    const { guard } = make({ blockSelector: '' });
    const byClass = el('iframe', { class: 'a rr-block b' }, [text(SECRET)]);
    const open = el('iframe', { class: 'bugsee-show' }, [text('ok')]);
    guard(snapshot(doc([byClass, open])));
    expect(byClass.childNodes).toEqual([]);
    expect(open.childNodes).toHaveLength(1);

    const { guard: g2 } = make();
    const shown = el('iframe', { class: 'bugsee-show' }, [text('visible')]);
    g2(snapshot(doc([shown])));
    expect(shown.childNodes).toHaveLength(1); // unblockSelector beats the iframe block selector
  });

  it('a regexless/odd blockClass option is fine (no blockClass: only the selectors decide)', () => {
    const { guard } = make({ blockClass: undefined, blockSelector: '' });
    const frame = el('iframe', { class: 'rr-block' }, [text('kept')]);
    guard(snapshot(doc([frame])));
    expect(frame.childNodes).toHaveLength(1);
  });

  it('fails closed on a selector that cannot be evaluated', () => {
    const { guard } = make({ blockSelector: ':::bad(' });
    const frame = el('iframe', {}, [text(SECRET)]);
    guard(snapshot(doc([frame])));
    expect(frame.childNodes).toEqual([]);
  });

  it('survives attributes that cannot be set on a detached element', () => {
    const { guard } = make();
    const frame = el('iframe', { 'bad name!': 'x', class: 'ok' }, [text(SECRET)]);
    guard(snapshot(doc([frame])));
    expect(frame.childNodes).toEqual([]);
  });

  it('drops the attach mutation of a blocked iframe and everything that follows from inside it', () => {
    const { guard, onViolation } = make();
    const frame = el('iframe', { rr_width: '1px', rr_height: '1px' });
    expect(guard(snapshot(doc([frame])))).toBeDefined();
    const inner = el('p', {}, [text(SECRET)]);
    const innerDoc = doc([el('html', {}, [inner])]);
    expect(
      guard(
        mutation({
          isAttachIframe: true,
          adds: [{ parentId: frame.id, nextId: null, node: innerDoc }],
        }),
      ),
    ).toBeUndefined();
    expect(onViolation).toHaveBeenCalledTimes(1);

    const innerText = inner.childNodes[0] as { id: number };
    const dropped: eventWithTime[] = [
      mutation({ texts: [{ id: innerText.id, value: SECRET }] }),
      mutation({ attributes: [{ id: inner.id, attributes: { title: SECRET } }] }),
      mutation({ removes: [{ parentId: inner.id, id: innerText.id }] }),
      mutation({ removes: [{ parentId: innerDoc.id, id: inner.id }] }),
      mutation({ adds: [{ parentId: inner.id, nextId: null, node: el('b', {}, [text(SECRET)]) }] }),
      incremental({ source: SOURCE.Input, id: inner.id, text: SECRET, isChecked: false }),
      incremental({ source: SOURCE.Scroll, id: inner.id, x: 1, y: 1 }),
      incremental({ source: SOURCE.MouseInteraction, type: 2, id: inner.id, x: 1, y: 1 }),
      incremental({ source: SOURCE.MediaInteraction, type: 0, id: inner.id }),
      incremental({ source: SOURCE.StyleSheetRule, id: inner.id, adds: [{ rule: SECRET }] }),
      incremental({
        source: SOURCE.StyleDeclaration,
        id: inner.id,
        set: { property: 'x', value: SECRET },
      }),
      incremental({ source: SOURCE.AdoptedStyleSheet, id: inner.id, styles: [], styleIds: [] }),
      incremental({
        source: SOURCE.MouseMove,
        positions: [{ x: 1, y: 1, id: inner.id, timeOffset: 0 }],
      }),
      incremental({
        source: SOURCE.TouchMove,
        positions: [{ x: 1, y: 1, id: innerDoc.id, timeOffset: 0 }],
      }),
      incremental({
        source: SOURCE.Drag,
        positions: [{ x: 1, y: 1, id: inner.id, timeOffset: 0 }],
      }),
      incremental({
        source: SOURCE.Selection,
        ranges: [{ start: inner.id, startOffset: 0, end: inner.id, endOffset: 1 }],
      }),
    ];
    for (const e of dropped) expect(guard(e)).toBeUndefined();
    expect(onViolation).toHaveBeenCalledTimes(1);
  });

  it('keeps the unaffected parts of a mutation that also touches blocked content', () => {
    const { guard } = make();
    const frame = el('iframe', { rr_width: '1px', rr_height: '1px' });
    const outside = text('outside');
    guard(snapshot(doc([frame, outside])));
    const inner = text(SECRET);
    guard(
      mutation({
        isAttachIframe: true,
        adds: [{ parentId: frame.id, nextId: null, node: doc([inner]) }],
      }),
    );
    const mixed = mutation({
      texts: [
        { id: inner.id, value: SECRET },
        { id: outside.id, value: 'new outside' },
      ],
      attributes: [
        { id: inner.id, attributes: { a: SECRET } },
        { id: outside.id, attributes: { b: '1' } },
      ],
      removes: [
        { parentId: 1, id: inner.id },
        { parentId: 1, id: 99 },
      ],
      adds: [{ parentId: 1, nextId: null, node: el('p', {}, [text('fine')]) }],
    });
    const out = guard(mixed)!;
    const data = (out as unknown as { data: Record<string, unknown[]> }).data;
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(data.texts).toHaveLength(1);
    expect(data.attributes).toHaveLength(1);
    expect(data.removes).toHaveLength(1);
    expect(data.adds).toHaveLength(1);
  });

  it('filters tainted positions out of a mixed pointer event and drops mixed selections only when tainted', () => {
    const { guard } = make();
    const frame = el('iframe', { rr_width: '1px', rr_height: '1px' });
    const ok = el('p', {});
    guard(snapshot(doc([frame, ok])));
    const inner = text(SECRET);
    guard(
      mutation({
        isAttachIframe: true,
        adds: [{ parentId: frame.id, nextId: null, node: doc([inner]) }],
      }),
    );
    const move = guard(
      incremental({
        source: SOURCE.MouseMove,
        positions: [
          { x: 1, y: 1, id: inner.id, timeOffset: 0 },
          { x: 2, y: 2, id: ok.id, timeOffset: 1 },
        ],
      }),
    )!;
    expect((move as unknown as { data: { positions: unknown[] } }).data.positions).toHaveLength(1);
    const sel = incremental({
      source: SOURCE.Selection,
      ranges: [{ start: ok.id, startOffset: 0, end: ok.id, endOffset: 1 }],
    });
    expect(guard(sel)).toBe(sel);
    // an event of a source that carries no id, and a custom/meta event, pass
    const font = incremental({ source: 10, family: 'x' });
    expect(guard(font)).toBe(font);
    const custom = {
      type: 5,
      timestamp: 1,
      data: { tag: 't', payload: {} },
    } as unknown as eventWithTime;
    expect(guard(custom)).toBe(custom);
  });

  it('scans nodes added while recording: an added blocked iframe is stripped, its later attach dropped', () => {
    const { guard, onViolation } = make();
    guard(snapshot(doc([el('body', {})])));
    const inner = text(SECRET);
    const added = el('iframe', { rr_width: '1px', rr_height: '1px' }, [doc([inner])]);
    const out = guard(
      mutation({ adds: [{ parentId: 1, nextId: null, node: el('div', {}, [added]) }] }),
    )!;
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(guard(mutation({ texts: [{ id: inner.id, value: SECRET }] }))).toBeUndefined();
    // an add that is ONLY blocked content (nothing else in the event) drops the whole event
    expect(
      guard(
        mutation({
          isAttachIframe: true,
          adds: [{ parentId: added.id, nextId: null, node: doc([text(SECRET)]) }],
        }),
      ),
    ).toBeUndefined();
  });

  it('a new full snapshot starts from a clean slate (ids of a released iframe are forgotten)', () => {
    const { guard } = make();
    const frame = el('iframe', { rr_width: '1px', rr_height: '1px' });
    guard(snapshot(doc([frame])));
    const inner = text(SECRET);
    guard(
      mutation({
        isAttachIframe: true,
        adds: [{ parentId: frame.id, nextId: null, node: doc([inner]) }],
      }),
    );
    expect(guard(mutation({ texts: [{ id: inner.id, value: 'x' }] }))).toBeUndefined();
    guard(snapshot(doc([text('fresh')])));
    const reused = mutation({ texts: [{ id: inner.id, value: 'x' }] });
    expect(guard(reused)).toBe(reused);
  });

  it('lets events of an unknown shape through unchanged (it only ever removes iframe content)', () => {
    const { guard, onViolation } = make();
    const shapes = [
      { type: 2 },
      { type: 2, data: null },
      { type: 2, data: {} },
      { type: 3, data: { source: 0 } },
      { type: 3, data: null },
      { type: 3, data: { source: 1 } },
      { type: 3, data: { source: 14 } },
    ].map((e) => e as unknown as eventWithTime);
    for (const e of shapes) expect(guard(e)).toBe(e);
    expect(onViolation).not.toHaveBeenCalled();
  });

  it('drops the event and reports when the guard itself fails (fail closed)', () => {
    const { guard, onViolation } = make();
    const boom = {
      type: 2,
      data: {
        get node(): never {
          throw new Error('boom');
        },
      },
    } as unknown as eventWithTime;
    expect(guard(boom)).toBeUndefined();
    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(String(onViolation.mock.calls[0]?.[0])).toMatch(/guard failed/);
  });

  it('a throwing onViolation sink never reaches the recorder', () => {
    const { guard } = make({
      onViolation: () => {
        throw new Error('sink');
      },
    });
    const frame = el('iframe', { rr_width: '1px' }, [text(SECRET)]);
    expect(() => guard(snapshot(doc([frame])))).not.toThrow();
  });

  it('trusts the recorder placeholder marker whichever dimension it carries, even when no rule matches', () => {
    for (const marker of [{ rr_width: '1px' }, { rr_height: '1px' }]) {
      const { guard } = make({ blockSelector: '', blockClass: undefined });
      const frame = el('iframe', marker, [text(SECRET)]);
      guard(snapshot(doc([frame])));
      expect(frame.childNodes).toEqual([]);
    }
  });

  it('drops a removal by its parent alone, and a selection by either end', () => {
    const { guard } = make();
    const frame = el('iframe', { rr_width: '1px' });
    guard(snapshot(doc([frame])));
    const inner = el('p', {});
    const other = el('p', {});
    guard(
      mutation({
        isAttachIframe: true,
        adds: [{ parentId: frame.id, nextId: null, node: doc([inner]) }],
      }),
    );
    expect(guard(mutation({ removes: [{ parentId: inner.id, id: 9999 }] }))).toBeUndefined();
    for (const range of [
      { start: inner.id, startOffset: 0, end: other.id, endOffset: 1 },
      { start: other.id, startOffset: 0, end: inner.id, endOffset: 1 },
    ]) {
      expect(guard(incremental({ source: SOURCE.Selection, ranges: [range] }))).toBeUndefined();
    }
  });
});
