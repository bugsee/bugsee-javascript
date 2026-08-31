import { describe, expect, it } from 'vitest';
import {
  isSensitiveInput,
  SENSITIVE_INPUT_MATCHERS,
  SENSITIVE_INPUT_SELECTOR,
} from './sensitive-input';

/** A duck-typed element whose `matches` is a real (tiny) selector evaluator over the fixture's attrs. */
const el = (attrs: Record<string, string>, throwOnMatch = false) => ({
  matches(selector: string): boolean {
    if (throwOnMatch) throw new Error('bad selector');
    // Evaluate the comma-joined matcher list the same way a browser would for the operators we use.
    return selector.split(',').some((raw) => {
      const m = /^\[([a-z-]+)(?:([*~]?=)"([^"]*)"( i)?)?\]$/.exec(raw.trim());
      if (m === null) return false;
      const [, name, op, wanted] = m;
      const value = attrs[name as string];
      if (value === undefined) return false;
      if (op === undefined) return true; // presence matcher, e.g. [data-rr-is-password]
      const hay = value.toLowerCase();
      const needle = (wanted as string).toLowerCase();
      if (op === '*=') return hay.includes(needle);
      if (op === '~=') return hay.split(/\s+/).includes(needle);
      return hay === needle;
    });
  },
});

describe('the shared sensitive-input definition', () => {
  it('is ONE frozen list, and the selector is exactly that list', () => {
    expect(Object.isFrozen(SENSITIVE_INPUT_MATCHERS)).toBe(true);
    expect(SENSITIVE_INPUT_SELECTOR).toBe(SENSITIVE_INPUT_MATCHERS.join(','));
  });

  it('covers every field class the SDK treats as secret', () => {
    expect([...SENSITIVE_INPUT_MATCHERS]).toStrictEqual([
      '[type="password" i]',
      '[type="tel" i]',
      '[autocomplete*="password" i]',
      '[autocomplete*="cc-" i]',
      '[autocomplete~="one-time-code" i]',
      '[data-rr-is-password]',
    ]);
  });

  it('every matcher is attribute-only, so a consumer can prefix it with an element name', () => {
    for (const m of SENSITIVE_INPUT_MATCHERS) expect(m.startsWith('[')).toBe(true);
  });

  it.each([
    ['password field', { type: 'password' }],
    ['UPPERCASE password field', { type: 'PASSWORD' }],
    ['phone field', { type: 'tel' }],
    ['new-password autocomplete', { autocomplete: 'new-password' }],
    ['uppercase card number', { autocomplete: 'CC-NUMBER' }],
    ['token-list one-time-code', { autocomplete: 'webauthn one-time-code' }],
    ["rrweb's was-a-password stamp", { 'data-rr-is-password': '' }],
  ])('classifies a %s as sensitive', (_label, attrs) => {
    expect(isSensitiveInput(el(attrs))).toBe(true);
  });

  it.each([
    ['plain text field', { type: 'text' }],
    ['search field', { type: 'search' }],
    ['a username autocomplete', { autocomplete: 'username' }],
    ['an unrelated element', {}],
  ])('does NOT classify a %s as sensitive', (_label, attrs) => {
    expect(isSensitiveInput(el(attrs))).toBe(false);
  });

  it('is fail-CLOSED: a node whose matches() throws is treated as sensitive', () => {
    expect(isSensitiveInput(el({ type: 'text' }, true))).toBe(true);
  });

  // A `matches`-only predicate is one missing method away from reporting a password field as ordinary.
  // Real Elements always have `matches`, but instrumented / proxied / partially-stubbed DOMs do not, and
  // the answer there must not be "not secret". The `type` family is therefore ALSO read structurally,
  // straight off the node — derived from the same matcher list, so there is still only one definition.
  it.each([
    ['password', { type: 'password' }],
    ['PASSWORD (case-insensitive)', { type: 'PASSWORD' }],
    ['tel', { type: 'tel' }],
  ])('classifies a %s field with NO matches() method as sensitive', (_label, node) => {
    expect(isSensitiveInput(node)).toBe(true);
  });

  it('does not over-claim structurally: a text field with no matches() is not sensitive', () => {
    expect(isSensitiveInput({ type: 'text' })).toBe(false);
    expect(isSensitiveInput({ type: 7 })).toBe(false);
  });

  it('the structural type set is DERIVED from the matcher list, never hand-written', () => {
    // Every `[type="X" i]` matcher must have a structural counterpart: adding one to the list must not
    // silently leave the no-`matches` path behind.
    const declared = SENSITIVE_INPUT_MATCHERS.flatMap((m) => {
      const parsed = /^\[type="([^"]+)" i\]$/.exec(m);
      return parsed === null ? [] : [parsed[1] as string];
    });
    expect(declared.length).toBeGreaterThan(0);
    for (const type of declared) expect(isSensitiveInput({ type })).toBe(true);
  });

  it('a structurally-sensitive node wins even when matches() says no', () => {
    expect(isSensitiveInput({ type: 'password', matches: () => false })).toBe(true);
  });

  it('is not sensitive for a non-element (no matches method), null or undefined', () => {
    expect(isSensitiveInput({})).toBe(false);
    expect(isSensitiveInput(null)).toBe(false);
    expect(isSensitiveInput(undefined)).toBe(false);
    expect(isSensitiveInput('a string')).toBe(false);
  });
});
