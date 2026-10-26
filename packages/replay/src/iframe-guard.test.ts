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

const attach = (frameId: number, inner: unknown) =>
  mutation({
    isAttachIframe: true,
    adds: [{ parentId: frameId, nextId: null, node: doc([inner]) }],
  });
const classChange = (id: number, value: string | null) =>
  mutation({ attributes: [{ id, attributes: { class: value } }] });

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

  it('drops events whose shape it cannot read (fail closed), and says so once', () => {
    const { guard, onViolation } = make();
    const malformed = [
      { type: 2 },
      { type: 2, data: null },
      { type: 2, data: {} },
      { type: 3, data: null },
      { type: 3, data: { source: 0 } },
      { type: 3, data: { source: 0, adds: {}, texts: [], attributes: [], removes: [] } },
      { type: 3, data: { source: 0, adds: [], texts: 1, attributes: [], removes: [] } },
      { type: 3, data: { source: 0, adds: [], texts: [], attributes: null, removes: [] } },
      { type: 3, data: { source: 0, adds: [], texts: [], attributes: [], removes: 'x' } },
      { type: 3, data: { source: 1 } },
      { type: 3, data: { source: 6, positions: {} } },
      { type: 3, data: { source: 14 } },
      { type: 3, data: { source: 3, x: 1 } },
      { type: 3, data: { source: 5, id: '7' } },
    ].map((e) => e as unknown as eventWithTime);
    for (const e of malformed) expect(guard(e)).toBeUndefined();
    expect(onViolation).toHaveBeenCalledTimes(1);
  });

  it('lets events that have nothing to do with nodes through (meta, custom, font, log, viewport, custom elements)', () => {
    const { guard, onViolation } = make();
    const fine = [
      { type: 4, data: { href: 'x', width: 1, height: 1 } },
      { type: 5, data: { tag: 't', payload: {} } },
      { type: 3, data: { source: 4, width: 1, height: 1 } },
      { type: 3, data: { source: 10, family: 'f' } },
      { type: 3, data: { source: 11, level: 'log' } },
      { type: 3, data: { source: 16, define: { name: 'x-y' } } },
    ].map((e) => e as unknown as eventWithTime);
    for (const e of fine) expect(guard(e)).toBe(e);
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

  describe('an iframe that becomes blocked after it was recorded', () => {
    it('is reclassified by an attribute mutation: its content, and the content of nested iframes, is dropped from then on', () => {
      const { guard, onViolation } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', { id: 'f' });
      guard(snapshot(doc([frame])));
      const inner = el('p', {}, [text('seen while allowed')]);
      const nested = el('iframe', {});
      const innerDoc = el('div', {}, [inner, nested]);
      const a = attach(frame.id, innerDoc);
      expect(guard(a)).toBe(a); // allowed so far
      const deep = el('p', {}, [text(SECRET)]);
      const deepAttach = attach(nested.id, deep);
      expect(guard(deepAttach)).toBe(deepAttach);
      const late = el('b', {}, [text('added later')]);
      const lateAdd = mutation({ adds: [{ parentId: inner.id, nextId: null, node: late }] });
      expect(guard(lateAdd)).toBe(lateAdd);
      expect(onViolation).not.toHaveBeenCalled();

      // the class change itself is the iframe's own attribute and passes; the content it hides is gone from now on
      const change = classChange(frame.id, 'private');
      expect(guard(change)).toBe(change);
      expect(onViolation).not.toHaveBeenCalled(); // an app blocking an iframe is not a violation by itself
      for (const id of [inner.id, late.id, deep.id, (inner.childNodes[0] as { id: number }).id]) {
        expect(guard(mutation({ texts: [{ id, value: SECRET }] }))).toBeUndefined();
      }
      expect(
        guard(incremental({ source: SOURCE.Input, id: deep.id, text: SECRET, isChecked: false })),
      ).toBeUndefined();
      // a later attach under the now blocked iframe is dropped too
      expect(onViolation).toHaveBeenCalledTimes(1); // reported when something still came out of it
      expect(guard(attach(frame.id, el('p', {}, [text(SECRET)])))).toBeUndefined();
    });

    it('stays recorded when a class change does not block it, and when attributes are removed', () => {
      const { guard, onViolation } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', { class: 'private-ish' });
      guard(snapshot(doc([frame])));
      const inner = el('p', {}, [text('ok')]);
      guard(attach(frame.id, inner));
      for (const value of ['other', null]) {
        guard(classChange(frame.id, value));
        const t = mutation({
          texts: [{ id: (inner.childNodes[0] as { id: number }).id, value: 'x' }],
        });
        expect(guard(t)).toBe(t);
      }
      expect(onViolation).not.toHaveBeenCalled();
    });

    it('classifies by the merged attributes: an existing attribute survives, the unblock rule wins once added', () => {
      const { guard } = make({ blockSelector: 'iframe.private', unblockSelector: '.bugsee-show' });
      const frame = el('iframe', { class: 'x' });
      guard(snapshot(doc([frame])));
      const inner = text('x');
      guard(attach(frame.id, inner));
      const ping = () => mutation({ texts: [{ id: inner.id, value: 'y' }] });
      // 'private' is added next to an unblocking class: the unblock rule wins, the content stays recorded
      const both = ping();
      guard(classChange(frame.id, 'private bugsee-show'));
      expect(guard(both)).toBe(both);
      // merging a data attribute keeps the class that is already there
      guard(mutation({ attributes: [{ id: frame.id, attributes: { 'data-a': '1' } }] }));
      const still = ping();
      expect(guard(still)).toBe(still);
      // without the unblocking class the same attributes block it, and it stays blocked
      guard(classChange(frame.id, 'private'));
      expect(guard(ping())).toBeUndefined();
      guard(classChange(frame.id, 'x'));
      expect(guard(ping())).toBeUndefined();
    });

    it('a placeholder marker added later blocks it', () => {
      const { guard } = make({ blockSelector: '' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const inner = el('p', {}, [text(SECRET)]);
      guard(attach(frame.id, inner));
      guard(mutation({ attributes: [{ id: frame.id, attributes: { rr_width: '1px' } }] }));
      expect(
        guard(mutation({ attributes: [{ id: inner.id, attributes: { a: SECRET } }] })),
      ).toBeUndefined();
    });

    it('only taints the content of the iframe that became blocked, not of the open iframes next to it', () => {
      const { guard } = make({ blockSelector: 'iframe.private' });
      const a = el('iframe', {});
      const b = el('iframe', {});
      guard(snapshot(doc([a, b])));
      const inA = text('a');
      const inB = text('b');
      guard(attach(a.id, inA));
      guard(attach(b.id, inB));
      guard(classChange(a.id, 'private'));
      expect(guard(mutation({ texts: [{ id: inA.id, value: 'x' }] }))).toBeUndefined();
      const ok = mutation({ texts: [{ id: inB.id, value: 'x' }] });
      expect(guard(ok)).toBe(ok);
    });

    it('a removed attribute is really removed before the rules are evaluated', () => {
      const { guard } = make({ blockSelector: 'iframe', unblockSelector: '[data-open]' });
      const frame = el('iframe', { 'data-open': '1' });
      guard(snapshot(doc([frame])));
      const inner = text('x');
      guard(attach(frame.id, inner));
      guard(mutation({ attributes: [{ id: frame.id, attributes: { 'data-open': null } }] }));
      expect(guard(mutation({ texts: [{ id: inner.id, value: 'y' }] }))).toBeUndefined();
    });

    it('successive attribute mutations accumulate', () => {
      const { guard } = make({ blockSelector: 'iframe[data-p][data-q]' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const inner = text('x');
      guard(attach(frame.id, inner));
      guard(mutation({ attributes: [{ id: frame.id, attributes: { 'data-p': '1' } }] }));
      const still = mutation({ texts: [{ id: inner.id, value: 'y' }] });
      expect(guard(still)).toBe(still); // one of the two attributes is not enough
      guard(mutation({ attributes: [{ id: frame.id, attributes: { 'data-q': '1' } }] }));
      expect(guard(mutation({ texts: [{ id: inner.id, value: 'z' }] }))).toBeUndefined();
    });

    it('forgets the open iframes with every full snapshot', () => {
      const { guard, onViolation } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      guard(snapshot(doc([text('fresh')]))); // the iframe is gone
      guard(classChange(frame.id, 'private'));
      expect(onViolation).not.toHaveBeenCalled();
    });

    it('drops an attach that arrives in the SAME event as the attribute change that blocks the iframe', () => {
      const { guard } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const inner = text(SECRET);
      const both = mutation({
        isAttachIframe: true,
        attributes: [{ id: frame.id, attributes: { class: 'private' } }],
        adds: [{ parentId: frame.id, nextId: null, node: doc([inner]) }],
      });
      const out = guard(both)!;
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(
        (out as unknown as { data: { adds: unknown[]; attributes: unknown[] } }).data.adds,
      ).toEqual([]);
      expect((out as unknown as { data: { attributes: unknown[] } }).data.attributes).toHaveLength(
        1,
      );
      expect(guard(mutation({ texts: [{ id: inner.id, value: 'x' }] }))).toBeUndefined();
    });

    it('forgets removed subtrees: a node removed before the iframe became blocked is not carried along', () => {
      const { guard } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const gone = el('p', {}, [text('gone')]);
      const kept = el('p', {}, [text('kept')]);
      const root = el('div', {}, [gone, kept]);
      guard(attach(frame.id, root));
      guard(mutation({ removes: [{ parentId: root.id, id: gone.id }] }));
      guard(classChange(frame.id, 'private'));
      expect(
        guard(mutation({ texts: [{ id: (kept.childNodes[0] as { id: number }).id, value: 'x' }] })),
      ).toBeUndefined();
      // the removed node and its child were pruned, so nothing about them is tainted
      const stale = mutation({
        texts: [{ id: (gone.childNodes[0] as { id: number }).id, value: 'x' }],
      });
      expect(guard(stale)).toBe(stale);
    });

    it('a node removed and added again in one event (a move) stays owned', () => {
      const { guard } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const a = el('div', {});
      const b = el('div', {});
      const moved = el('p', {}, [text('m')]);
      guard(attach(frame.id, el('div', {}, [a, b, moved])));
      guard(
        mutation({
          removes: [{ parentId: 1, id: moved.id }],
          adds: [{ parentId: b.id, nextId: null, node: moved }],
        }),
      );
      guard(classChange(frame.id, 'private'));
      expect(
        guard(
          mutation({ texts: [{ id: (moved.childNodes[0] as { id: number }).id, value: 'x' }] }),
        ),
      ).toBeUndefined();
    });

    it('forgets an open iframe that was removed from the page (and its content)', () => {
      const { guard, onViolation } = make({ blockSelector: 'iframe.private' });
      const holder = el('div', {});
      const frame = el('iframe', {});
      holder.childNodes.push(frame);
      guard(snapshot(doc([holder])));
      guard(attach(frame.id, text('x')));
      guard(mutation({ removes: [{ parentId: holder.id, id: frame.id }] }));
      guard(classChange(frame.id, 'private'));
      expect(onViolation).not.toHaveBeenCalled();
    });

    it('holds only what the recorded iframes hold now: churn does not accumulate, a snapshot clears everything', () => {
      const { guard } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const root = el('div', {});
      guard(attach(frame.id, root));
      const baseline = guard.tracked();
      for (let i = 0; i < 200; i++) {
        const child = el('p', {}, [text(`n${i}`)]);
        guard(mutation({ adds: [{ parentId: root.id, nextId: null, node: child }] }));
        guard(mutation({ removes: [{ parentId: root.id, id: child.id }] }));
      }
      expect(guard.tracked()).toBe(baseline);
      guard(snapshot(doc([])));
      expect(guard.tracked()).toBe(0);
    });

    it('a node moved to another parent (an add with no removal) is no longer forgotten with its old parent', () => {
      const { guard } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const x = el('p', {}, [text('x')]);
      const p = el('div', {}, [x]);
      const b = el('div', {});
      guard(attach(frame.id, el('div', {}, [p, b])));
      guard(mutation({ adds: [{ parentId: b.id, nextId: null, node: { ...x, childNodes: [] } }] })); // the move
      guard(mutation({ removes: [{ parentId: 1, id: p.id }] })); // the old parent goes away
      guard(classChange(frame.id, 'private'));
      expect(guard(mutation({ texts: [{ id: x.id, value: 'secret' }] }))).toBeUndefined();
      expect(
        guard(mutation({ texts: [{ id: (x.childNodes[0] as { id: number }).id, value: 's' }] })),
      ).toBeUndefined();
    });

    it('a removal naming the wrong parent still clears the real parent', () => {
      const { guard } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const root = el('div', {});
      guard(attach(frame.id, root));
      const baseline = guard.tracked();
      const a = el('p', {});
      guard(mutation({ adds: [{ parentId: root.id, nextId: null, node: a }] }));
      expect(guard.tracked()).toBeGreaterThan(baseline);
      guard(mutation({ removes: [{ parentId: 424242, id: a.id }] })); // wrong parent on purpose
      expect(guard.tracked()).toBe(baseline);
    });

    it('removing one child keeps its siblings tracked until their own parent goes', () => {
      const { guard } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const before = guard.tracked();
      const root = el('div', {});
      const a = el('p', {});
      const b = el('p', {});
      guard(attach(frame.id, root));
      guard(
        mutation({
          adds: [
            { parentId: root.id, nextId: null, node: a },
            { parentId: root.id, nextId: null, node: b },
          ],
        }),
      );
      guard(mutation({ removes: [{ parentId: root.id, id: a.id }] }));
      guard(classChange(frame.id, 'private'));
      expect(guard(mutation({ texts: [{ id: b.id, value: 'x' }] }))).toBeUndefined();
      // the whole subtree goes with its parent, the sibling included
      guard(snapshot(doc([frame])));
      expect(guard.tracked()).toBeLessThanOrEqual(before);
    });

    it('forgetting a parent forgets all of its remaining children', () => {
      const { guard } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const root = el('div', {});
      const a = el('p', {});
      const b = el('p', {});
      guard(attach(frame.id, root));
      const attached = guard.tracked();
      guard(
        mutation({
          adds: [
            { parentId: root.id, nextId: null, node: a },
            { parentId: root.id, nextId: null, node: b },
          ],
        }),
      );
      guard(mutation({ removes: [{ parentId: root.id, id: a.id }] }));
      guard(mutation({ removes: [{ parentId: frame.id, id: root.id }] }));
      expect(guard.tracked()).toBe(attached - 3); // root: owner + parent + kids entry of its parent; a and b went with it
    });

    it('applies every attribute of one mutation, not just the first', () => {
      const { guard } = make({ blockSelector: 'iframe[data-p][data-q]' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const inner = text('x');
      guard(attach(frame.id, inner));
      guard(
        mutation({ attributes: [{ id: frame.id, attributes: { 'data-p': '1', 'data-q': '1' } }] }),
      );
      expect(guard(mutation({ texts: [{ id: inner.id, value: 'y' }] }))).toBeUndefined();
    });

    it('removing a container of an open iframe forgets the iframe and everything attached under it', () => {
      const { guard, onViolation } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', {});
      const inner = el('div', {}, [frame]);
      const sibling = el('p', {}, [text('s')]);
      const wrap = el('div', {}, [inner, sibling]); // the open iframe is NOT the last child on its way up
      const outer = el('div', {}, [wrap]);
      const page = doc([outer]);
      guard(snapshot(page));
      guard(attach(frame.id, el('div', {}, [text('attached')])));
      expect(guard.tracked()).toBeGreaterThan(0);
      guard(mutation({ removes: [{ parentId: page.id, id: outer.id }] }));
      expect(guard.tracked()).toBe(0);
      guard(classChange(frame.id, 'private')); // the iframe is gone: nothing to reclassify
      expect(onViolation).not.toHaveBeenCalled();
    });

    it('does not link nodes that have no open iframe below them', () => {
      const { guard } = make({ blockSelector: 'iframe.private' });
      guard(snapshot(doc([el('div', {}, [el('p', {}, [text('plain')])])])));
      expect(guard.tracked()).toBe(0);
      const blocked = el('iframe', { rr_width: '1px' });
      guard(snapshot(doc([el('div', {}, [blocked])])));
      expect(guard.tracked()).toBe(0); // a blocked iframe is not tracked either
    });

    it('closes iframes nested three levels deep: the whole chain is tainted', () => {
      const { guard } = make({ blockSelector: 'iframe.private' });
      const a = el('iframe', {});
      guard(snapshot(doc([a])));
      const b = el('iframe', {});
      guard(attach(a.id, el('div', {}, [b])));
      const c = el('iframe', {});
      guard(attach(b.id, el('div', {}, [c])));
      const deepest = text('deep');
      guard(attach(c.id, deepest));
      guard(classChange(a.id, 'private'));
      expect(guard(mutation({ texts: [{ id: deepest.id, value: 'x' }] }))).toBeUndefined();
      expect(
        guard(mutation({ attributes: [{ id: c.id, attributes: { x: '1' } }] })),
      ).toBeUndefined();
    });
  });

  describe('adopted style sheets, named by styleId', () => {
    const adopted = (id: number, styleIds: number[], styles: unknown[] = []) =>
      incremental({ source: SOURCE.AdoptedStyleSheet, id, styleIds, styles });
    const rule = (styleId: number) =>
      incremental({ source: SOURCE.StyleSheetRule, styleId, adds: [{ rule: 'a{}' }] });
    const decl = (styleId: number) =>
      incremental({ source: SOURCE.StyleDeclaration, styleId, set: { property: 'a', value: 'b' } });

    it('a sheet adopted inside a blocked iframe taints its styleId: later rule and declaration events are dropped', () => {
      const { guard } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', { rr_width: '1px' });
      guard(snapshot(doc([frame])));
      const inner = el('p', {});
      const innerDoc = doc([inner]);
      guard(
        mutation({
          isAttachIframe: true,
          adds: [{ parentId: frame.id, nextId: null, node: innerDoc }],
        }),
      );
      expect(
        guard(adopted(innerDoc.id, [41], [{ styleId: 41, rules: [{ rule: 'p{}', index: 0 }] }])),
      ).toBeUndefined();
      expect(guard(rule(41))).toBeUndefined();
      expect(guard(decl(41))).toBeUndefined();
      const other = rule(42);
      expect(guard(other)).toBe(other);
    });

    it('a sheet adopted while the iframe was open is tainted when it becomes blocked', () => {
      const { guard } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const innerDoc = doc([el('p', {})]);
      guard(
        mutation({
          isAttachIframe: true,
          adds: [{ parentId: frame.id, nextId: null, node: innerDoc }],
        }),
      );
      const ev = adopted(innerDoc.id, [51], [{ styleId: 51, rules: [] }]);
      expect(guard(ev)).toBe(ev);
      const ok = rule(51);
      expect(guard(ok)).toBe(ok);
      guard(classChange(frame.id, 'private'));
      expect(guard(rule(51))).toBeUndefined();
      expect(guard(decl(51))).toBeUndefined();
      expect(guard(adopted(innerDoc.id, [52]))).toBeUndefined();
      expect(guard(rule(52))).toBeUndefined(); // tainted by the dropped event that named it
    });

    it('a sheet of the top document, and rule events that name a node id, are untouched', () => {
      const { guard } = make();
      const top = doc([]);
      guard(snapshot(top));
      const a = adopted(top.id, [61], [{ styleId: 61, rules: [] }]);
      expect(guard(a)).toBe(a);
      const r = rule(61);
      expect(guard(r)).toBe(r);
      const byNode = incremental({ source: SOURCE.StyleSheetRule, id: top.id, adds: [] });
      expect(guard(byNode)).toBe(byNode);
    });

    it('forgets sheets with every full snapshot', () => {
      const { guard } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const innerDoc = doc([]);
      guard(
        mutation({
          isAttachIframe: true,
          adds: [{ parentId: frame.id, nextId: null, node: innerDoc }],
        }),
      );
      guard(adopted(innerDoc.id, [71]));
      guard(classChange(frame.id, 'private'));
      expect(guard(rule(71))).toBeUndefined();
      guard(snapshot(doc([])));
      expect(guard.tracked()).toBe(0);
      const fresh = rule(71);
      expect(guard(fresh)).toBe(fresh);
    });
  });

  describe('reporting', () => {
    it('reports AFTER the content is removed: a sink that reacts (a blackout) never sees an unfiltered state', () => {
      let seenWhenReported: unknown;
      const holder: { guard?: ReturnType<typeof make>['guard'] } = {};
      const { guard } = make({
        onViolation: () => {
          // by the time the sink runs, the later event naming the removed content is already dropped
          seenWhenReported = holder.guard?.(mutation({ texts: [{ id: inner.id, value: 'x' }] }));
        },
      });
      holder.guard = guard;
      const inner = text(SECRET);
      const frame = el('iframe', { rr_width: '1px' }, [inner]);
      guard(snapshot(doc([frame])));
      expect(seenWhenReported).toBeUndefined();
    });

    it('reports a late attach to a reclassified iframe only after its content was tainted', () => {
      const states: unknown[] = [];
      const holder: { guard?: ReturnType<typeof make>['guard']; probe?: number } = {};
      const { guard } = make({
        blockSelector: 'iframe.private',
        onViolation: () => {
          states.push(
            holder.guard?.(mutation({ texts: [{ id: holder.probe as number, value: 'x' }] })),
          );
        },
      });
      holder.guard = guard;
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const inner = text('x');
      holder.probe = inner.id;
      guard(
        mutation({
          isAttachIframe: true,
          adds: [{ parentId: frame.id, nextId: null, node: doc([inner]) }],
        }),
      );
      guard(classChange(frame.id, 'private'));
      expect(states).toEqual([]); // blocking is not reported
      guard(
        mutation({
          isAttachIframe: true,
          adds: [{ parentId: frame.id, nextId: null, node: doc([text('late')]) }],
        }),
      );
      expect(states).toEqual([undefined]);
    });

    it('text and attribute mutations from a blocked iframe are reported too, a removal of its nodes is not', () => {
      const { guard, onViolation } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const inner = el('p', {}, [text('x')]);
      guard(attach(frame.id, inner));
      guard(classChange(frame.id, 'private'));
      // the app tears the blocked iframe's content down: nothing to report
      guard(mutation({ removes: [{ parentId: frame.id, id: inner.id }] }));
      expect(onViolation).not.toHaveBeenCalled();
      expect(guard(mutation({ texts: [{ id: inner.id, value: 'x' }] }))).toBeUndefined();
      expect(onViolation).toHaveBeenCalledTimes(1);
    });

    it('an attribute mutation from a blocked iframe is reported as well', () => {
      const { guard, onViolation } = make({ blockSelector: 'iframe.private' });
      const frame = el('iframe', {});
      guard(snapshot(doc([frame])));
      const inner = el('p', {});
      guard(attach(frame.id, inner));
      guard(classChange(frame.id, 'private'));
      expect(
        guard(mutation({ attributes: [{ id: inner.id, attributes: { a: '1' } }] })),
      ).toBeUndefined();
      expect(onViolation).toHaveBeenCalledTimes(1);
    });
  });
});
