import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { describeTarget } from './input-source';
import { createDomSnapshot } from './viewtree';

/**
 * Property-based tests for the target-masking rules.
 *
 * These encode the product guarantee — privacy-relevant content is obscured AUTOMATICALLY, to the
 * maximum extent possible — as invariants over generated elements rather than a handful of examples.
 * A masking rule is only as good as its worst untested input, and in a WebView the DOM being described
 * is attacker-influenced.
 *
 * The descriptor is deliberately structural (tag/id/class/type/selector/label), never a value. What
 * these properties pin is the other half: once an element is masked, NONE of those structural fields may
 * be emitted either, because on a masked element they are exactly what identifies the secret.
 */

const MASK_SELECTOR = '[data-bugsee-hidden]';

/** The fields that must never appear on a masked descriptor. */
const VALUE_BEARING = ['id', 'class', 'type', 'text', 'selector'] as const;

interface FakeElement {
  tagName?: unknown;
  id?: unknown;
  type?: unknown;
  textContent?: unknown;
  isContentEditable?: unknown;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

// Distinctive on purpose. An earlier version generated arbitrary short strings and then asserted the
// serialized descriptor did not CONTAIN them — which fails for a one-character secret like "a", since
// that occurs inside `"masked"` itself. A leak check needs a needle that cannot appear by coincidence.
const secret = fc.stringMatching(/^SECRET[a-zA-Z0-9]{6,20}$/);

/** An element that is inside a masked subtree, built so `closest` reports the mask ancestor. */
const maskedElement = (
  extra: Partial<FakeElement> = {},
): fc.Arbitrary<{ el: FakeElement; secrets: string[] }> =>
  fc
    .tuple(
      fc.constantFrom('div', 'span', 'input', 'button', 'a', 'label', 'p', 'section'),
      secret,
      secret,
      secret,
      secret,
    )
    .map(([tag, id, cls, text, aria]) => ({
      secrets: [id, cls, text, aria],
      el: {
        tagName: tag,
        id,
        textContent: text,
        getAttribute: (name: string) =>
          name === 'class' ? cls : name === 'aria-label' ? aria : null,
        closest: (selector: string) => (selector === MASK_SELECTOR ? { tagName: 'DIV' } : null),
        ...extra,
      },
    }));

describe('describeTarget masking (fuzz)', () => {
  it('emits nothing but the tag for an element inside a masked subtree', () => {
    fc.assert(
      fc.property(maskedElement(), ({ el, secrets }) => {
        const desc = describeTarget(el, MASK_SELECTOR) as Record<string, unknown>;
        expect(desc.masked).toBe(true);
        for (const field of VALUE_BEARING) {
          expect(desc[field]).toBeUndefined();
        }
        // Belt and braces: no generated secret may appear anywhere in the serialized descriptor,
        // whatever field a future change might add.
        const serialized = JSON.stringify(desc);
        for (const s of secrets) {
          expect(serialized).not.toContain(s);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('masks every password input regardless of its other attributes', () => {
    fc.assert(
      fc.property(secret, secret, secret, (id, cls, text) => {
        const el: FakeElement = {
          tagName: 'INPUT',
          type: 'password',
          id,
          textContent: text,
          getAttribute: (name: string) =>
            name === 'class' ? cls : name === 'aria-label' ? text : null,
          closest: () => null, // NOT inside a masked subtree — the type alone must be enough
        };
        const desc = describeTarget(el, MASK_SELECTOR) as Record<string, unknown>;
        expect(desc.masked).toBe(true);
        for (const field of VALUE_BEARING) {
          expect(desc[field]).toBeUndefined();
        }
        expect(JSON.stringify(desc)).not.toContain(id);
      }),
      { numRuns: 500 },
    );
  });

  /**
   * When the mask ancestry cannot be determined, nothing is published — and this is where a suspected
   * defect turned out not to be one, which is worth recording so it is not "fixed" later.
   *
   * `closest` is the only channel through which this function learns that an element sits inside a
   * masked subtree, and the reachable failure is an invalid `maskSelector`: one bad character makes
   * `closest` raise SyntaxError on every element. That looked like a silent fail-OPEN — masking degraded
   * to the password check alone — but it is not. The exception propagates out of `describeTarget`, and
   * every caller isolates per node/per event, so the node is skipped and the target omitted entirely.
   * Fail-closed by omission rather than by a mask flag, but fail-closed.
   *
   * The property therefore asserts what actually matters: under a broken selector, no descriptor
   * carrying value-bearing fields is ever produced. Changing this to return `{masked:true}` instead
   * would be a behavior preference, not a security fix — and would cost the deliberate "skip the bad
   * node, keep the rest of the tree" semantics the viewtree and interaction sources rely on.
   */
  it('publishes nothing describable when the mask query itself is broken', () => {
    fc.assert(
      fc.property(maskedElement(), ({ el, secrets }) => {
        const target = {
          ...el,
          closest: () => {
            throw new SyntaxError('bad selector');
          },
        };
        let desc: Record<string, unknown> | undefined;
        try {
          desc = describeTarget(target, ':::not-a-selector') as Record<string, unknown>;
        } catch {
          return; // propagated to the caller's per-node isolation: nothing is published at all
        }
        // If it ever stops throwing, the descriptor must still be masked and secret-free.
        expect(desc.masked).toBe(true);
        const serialized = JSON.stringify(desc);
        for (const s of secrets) {
          expect(serialized).not.toContain(s);
        }
      }),
      { numRuns: 500 },
    );
  });

  // An ABSENT `closest` is a different case from a broken one, and deliberately does NOT mask: the
  // target is not an Element in the document (a non-Element EventTarget, a framework's synthetic
  // target), so "inside a masked subtree" is inapplicable rather than unknown — a node outside the tree
  // cannot sit under a mask ancestor in it. Masking those would degrade ordinary capture for no privacy
  // gain, and would not stop an adversarial page regardless, since it can supply a `closest` returning
  // null. Pinned so the asymmetry stays a decision rather than an accident.
  it('describes a non-Element target normally rather than over-masking it', () => {
    const desc = describeTarget({ tagName: 'DIV' }, MASK_SELECTOR) as Record<string, unknown>;
    expect(desc.masked).toBeUndefined();
    expect(desc.tag).toBe('div');
  });

  /**
   * Editable content is a VALUE, not a label.
   *
   * The descriptor may carry a short label for button-ish elements, read from `textContent`. The moment
   * an element is contentEditable that text is whatever the user typed — the most sensitive category
   * there is — so the label read is suppressed. Nothing else in the suite covered this: removing the
   * `isContentEditable` clause left every other masking property green.
   *
   * Generated across the labelish tags specifically, since those are the only ones that reach the text
   * read at all; a rule that only holds for tags nobody labels is not a rule.
   */
  it('never reads text from a contentEditable element, whatever its tag', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('button', 'a', 'summary', 'label', 'option', 'div', 'span'),
        secret,
        fc.boolean(),
        (tag, typed, viaRole) => {
          const el: FakeElement = {
            tagName: tag.toUpperCase(),
            isContentEditable: true,
            textContent: typed,
            getAttribute: (name: string) => (name === 'role' && viaRole ? 'button' : null),
            closest: () => null,
          };
          const desc = describeTarget(el, MASK_SELECTOR) as Record<string, unknown>;
          expect(desc.text).toBeUndefined();
          expect(JSON.stringify(desc)).not.toContain(typed);
        },
      ),
      { numRuns: 500 },
    );
  });

  // The same rule for form controls: their text content is a value too, and `aria-label` is the only
  // author-set label allowed through.
  it('never reads text content from a form control, even one posing as a button', () => {
    // `role="button"` is what makes this rule load-bearing. Without it a form control is simply not
    // labelish, so the text read is never reached and the exclusion looks redundant — removing it kept
    // every other property green. With it, the element qualifies as labelish and the exclusion is the
    // only thing standing between `textContent` and the capture: for a `<textarea>`, `textContent` IS
    // its value.
    fc.assert(
      fc.property(fc.constantFrom('input', 'textarea', 'select'), secret, (tag, typed) => {
        const el: FakeElement = {
          tagName: tag.toUpperCase(),
          textContent: typed,
          getAttribute: (name: string) => (name === 'role' ? 'button' : null),
          closest: () => null,
        };
        const desc = describeTarget(el, MASK_SELECTOR) as Record<string, unknown>;
        expect(desc.text).toBeUndefined();
        expect(JSON.stringify(desc)).not.toContain(typed);
      }),
      { numRuns: 300 },
    );
  });

  // Totality over well-behaved-but-odd shapes: whatever the target's fields hold, describing it must
  // not throw of its own accord.
  it('never throws, whatever shape the target has', () => {
    const hostile = fc.record(
      {
        tagName: fc.oneof(fc.string(), fc.constant(undefined), fc.integer(), fc.constant(null)),
        id: fc.oneof(fc.string(), fc.constant(undefined), fc.integer()),
        type: fc.oneof(fc.string(), fc.constant(undefined), fc.integer()),
        textContent: fc.oneof(fc.string({ maxLength: 200 }), fc.constant(undefined), fc.integer()),
        isContentEditable: fc.oneof(fc.boolean(), fc.constant(undefined), fc.string()),
        // Accessors that RETURN. A DOM accessor that throws is deliberately propagated — the callers
        // isolate per node and skip it — so totality is asserted for the shapes it must handle itself,
        // not for ones it is designed to hand upward.
        getAttribute: fc.constantFrom(
          () => null,
          () => 'x',
          undefined as unknown as () => null,
        ),
        closest: fc.constantFrom(
          () => null,
          () => ({}),
          undefined as unknown as () => null,
        ),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(fc.oneof(hostile, fc.anything()), (target) => {
        expect(() => describeTarget(target, MASK_SELECTOR)).not.toThrow();
      }),
      { numRuns: 1000 },
    );
  });
});

/**
 * The at-report DOM snapshot reuses `describeTarget`, so its masking rules carry over — but the walk adds
 * one of its own that nothing else can make: a masked node COLLAPSES, and its descendants are never
 * visited. That is the difference between hiding a password field and hiding the form it sits in.
 */
describe('DOM snapshot masking (fuzz)', () => {
  interface FakeEl {
    tagName: string;
    id?: string;
    textContent?: string;
    children?: FakeEl[];
    getAttribute?: (name: string) => string | null;
    closest?: (selector: string) => unknown;
  }

  /** A subtree whose ROOT is masked and whose descendants each carry a distinctive secret. */
  const maskedSubtree = (secrets: readonly string[]): FakeEl => {
    const child = (s: string, depth: number): FakeEl => ({
      tagName: 'DIV',
      id: s,
      textContent: s,
      getAttribute: (name: string) => (name === 'class' ? s : null),
      // Every node inside the subtree reports the mask ancestor, as a real `closest` would.
      closest: (selector: string) => (selector === MASK_SELECTOR ? { tagName: 'DIV' } : null),
      children: depth > 0 ? [child(`${s}x`, depth - 1)] : [],
    });
    return {
      tagName: 'SECTION',
      getAttribute: () => null,
      closest: (selector: string) => (selector === MASK_SELECTOR ? { tagName: 'DIV' } : null),
      children: secrets.map((s) => child(s, 2)),
    };
  };

  it('collapses a masked subtree without visiting its descendants', () => {
    fc.assert(
      fc.property(fc.array(secret, { minLength: 1, maxLength: 4 }), (secrets) => {
        const body = maskedSubtree(secrets);
        const snapshot = createDomSnapshot({
          document: { body } as never,
          maskSelector: MASK_SELECTOR,
        })();

        const serialized = JSON.stringify(snapshot);
        for (const s of secrets) {
          expect(serialized, 'a masked subtree leaked a descendant').not.toContain(s);
        }
        // Collapsed, not merely scrubbed: the masked root carries no children at all.
        expect(snapshot?.masked).toBe(true);
        expect(snapshot?.children).toBeUndefined();
      }),
      { numRuns: 300 },
    );
  });

  it('still walks an UNMASKED tree, so the snapshot keeps its value', () => {
    const body: FakeEl = {
      tagName: 'BODY',
      getAttribute: () => null,
      closest: () => null,
      children: [
        {
          tagName: 'MAIN',
          id: 'content',
          getAttribute: () => null,
          closest: () => null,
          children: [{ tagName: 'BUTTON', getAttribute: () => null, closest: () => null }],
        },
      ],
    };
    const snapshot = createDomSnapshot({
      document: { body } as never,
      maskSelector: MASK_SELECTOR,
    })();
    expect(snapshot?.children?.[0]?.id).toBe('content');
    expect(snapshot?.children?.[0]?.children?.[0]?.tag).toBe('button');
  });
});
