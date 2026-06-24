import { describe, expect, it } from 'vitest';
import { COMPONENT_ATTRIBUTE, componentNameFromElement } from './component-name';

// A fake element supporting `closest(selector)` — returns the nearest annotated ancestor (or self).
interface FakeEl {
  component: string | null | undefined;
  parent?: FakeEl;
  getAttribute: (name: string) => string | null;
  closest: (selector: string) => unknown;
}
function el(component: string | null | undefined, parent?: FakeEl): FakeEl {
  const node: FakeEl = {
    component,
    parent,
    getAttribute: (name) => (name === COMPONENT_ATTRIBUTE ? (component ?? null) : null),
    closest(selector) {
      if (selector !== `[${COMPONENT_ATTRIBUTE}]`) return null;
      // walk self → ancestors for the first with a non-null component
      let cur: FakeEl | undefined = node;
      while (cur) {
        if (cur.component != null) return cur;
        cur = cur.parent;
      }
      return null;
    },
  };
  return node;
}

describe('componentNameFromElement', () => {
  it('returns the nearest annotated component name (self)', () => {
    expect(componentNameFromElement(el('UserCard'))).toBe('UserCard');
  });

  it('walks ancestors for the nearest annotated component', () => {
    const root = el('App');
    const child = el(undefined, root); // unannotated → falls back to the annotated ancestor
    expect(componentNameFromElement(child)).toBe('App');
  });

  it('returns undefined when nothing in the ancestry is annotated', () => {
    expect(componentNameFromElement(el(undefined))).toBeUndefined();
    expect(componentNameFromElement(el(''))).toBeUndefined(); // empty attribute → no name
  });

  it('returns undefined for a non-element (no closest)', () => {
    expect(componentNameFromElement(null)).toBeUndefined();
    expect(componentNameFromElement(undefined)).toBeUndefined();
    expect(componentNameFromElement(42)).toBeUndefined();
    expect(componentNameFromElement({})).toBeUndefined(); // no closest method
  });

  it('swallows a throwing closest (observe-only: never disrupt the app)', () => {
    const hostile = {
      closest: () => {
        throw new Error('hostile');
      },
    };
    expect(() => componentNameFromElement(hostile)).not.toThrow();
    expect(componentNameFromElement(hostile)).toBeUndefined();
  });

  it('returns undefined when the matched element has no/empty attribute value', () => {
    const weird = { closest: () => ({ getAttribute: () => null }) };
    expect(componentNameFromElement(weird)).toBeUndefined();
  });
});
