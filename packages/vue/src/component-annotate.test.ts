import { COMPONENT_ATTRIBUTE } from '@bugsee/browser';
import { describe, expect, it, vi } from 'vitest';
import { createBugseeVueComponentMixin, type VueComponentInstanceLike } from './component-annotate';

// A structural DOM-element fake: records attribute writes + answers getAttribute from them (so the mixin's
// idempotence guard can be exercised). No real DOM / vue import.
function fakeEl() {
  const attrs: Record<string, string> = {};
  return {
    setAttribute: vi.fn((k: string, v: string) => {
      attrs[k] = v;
    }),
    getAttribute: vi.fn((k: string): string | null => attrs[k] ?? null),
    attrs,
  };
}

const inst = (over: Record<string, unknown>): VueComponentInstanceLike =>
  over as VueComponentInstanceLike;

describe('createBugseeVueComponentMixin', () => {
  it('returns a mixin object with mounted + updated hooks', () => {
    const m = createBugseeVueComponentMixin();
    expect(typeof m.mounted).toBe('function');
    expect(typeof m.updated).toBe('function');
  });

  it('stamps the root element with data-bugsee-component=<name> on mount', () => {
    const el = fakeEl();
    createBugseeVueComponentMixin().mounted.call(inst({ $el: el, $options: { name: 'UserCard' } }));
    expect(el.setAttribute).toHaveBeenCalledWith(COMPONENT_ATTRIBUTE, 'UserCard');
    expect(el.attrs[COMPONENT_ATTRIBUTE]).toBe('UserCard');
  });

  it('resolves the name via the shared precedence ($.type.__name for <script setup>)', () => {
    const el = fakeEl();
    createBugseeVueComponentMixin().mounted.call(
      inst({ $el: el, $: { type: { __name: 'Dashboard' } } }),
    );
    expect(el.setAttribute).toHaveBeenCalledWith(COMPONENT_ATTRIBUTE, 'Dashboard');
  });

  it('does nothing for a nameless component (no element write)', () => {
    const el = fakeEl();
    createBugseeVueComponentMixin().mounted.call(inst({ $el: el, $options: {} }));
    expect(el.setAttribute).not.toHaveBeenCalled();
  });

  it('skips a fragment / text root whose $el has no setAttribute (returns BEFORE the write path)', () => {
    const m = createBugseeVueComponentMixin();
    // A fragment/text anchor has getAttribute but NO setAttribute. The element guard must return up front:
    // getAttribute being consulted would prove the code fell through to the write path (then only swallowed
    // the TypeError in the catch) — so we assert getAttribute was never touched.
    const getAttribute = vi.fn();
    expect(() =>
      m.mounted.call(inst({ $el: { nodeType: 8, getAttribute }, $options: { name: 'Frag' } })),
    ).not.toThrow();
    expect(getAttribute).not.toHaveBeenCalled();
  });

  it('skips a null or absent $el (no throw)', () => {
    const m = createBugseeVueComponentMixin();
    expect(() => m.mounted.call(inst({ $el: null, $options: { name: 'X' } }))).not.toThrow();
    expect(() => m.mounted.call(inst({ $options: { name: 'X' } }))).not.toThrow();
  });

  it('stamps even when the element has no getAttribute (idempotence guard tolerates its absence)', () => {
    const setAttribute = vi.fn();
    createBugseeVueComponentMixin().mounted.call(
      inst({ $el: { setAttribute }, $options: { name: 'NoGet' } }),
    );
    expect(setAttribute).toHaveBeenCalledWith(COMPONENT_ATTRIBUTE, 'NoGet');
  });

  it('is idempotent — skips the write on update when the attribute already holds the same name', () => {
    const el = fakeEl();
    const m = createBugseeVueComponentMixin();
    const i = inst({ $el: el, $options: { name: 'Stable' } });
    m.mounted.call(i);
    m.updated.call(i); // same element, already stamped → no second write
    expect(el.setAttribute).toHaveBeenCalledTimes(1);
  });

  it('re-stamps on update when the root element swapped to a new (unstamped) element', () => {
    const m = createBugseeVueComponentMixin();
    const el1 = fakeEl();
    const el2 = fakeEl();
    const i = inst({ $el: el1, $options: { name: 'Swappy' } });
    m.mounted.call(i);
    i.$el = el2; // a root-level v-if swapped the element
    m.updated.call(i);
    expect(el2.setAttribute).toHaveBeenCalledWith(COMPONENT_ATTRIBUTE, 'Swappy');
  });

  it('swallows a hostile setAttribute (observe-only — never disrupts the host app)', () => {
    const el = {
      setAttribute: vi.fn(() => {
        throw new Error('denied');
      }),
      getAttribute: (): string | null => null,
    };
    const m = createBugseeVueComponentMixin();
    expect(() => m.mounted.call(inst({ $el: el, $options: { name: 'Hostile' } }))).not.toThrow();
  });
});
