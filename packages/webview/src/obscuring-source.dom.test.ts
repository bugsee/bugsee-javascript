// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { SECURE_INPUT_SELECTOR } from './obscuring-source';

// The native-side masking floor, asserted against REAL elements.
//
// Every other test in this package drives a FAKE document keyed by the literal selector string, so none of
// them can see what the selector actually matches. That is why this floor silently drifted behind
// @bugsee/replay's: it carried only `type=password` and `autocomplete*="cc-"`, with no ` i` flag, while the
// replay floor gained `one-time-code`, `type=tel`, `autocomplete*="password"` and the `data-rr-is-password`
// stamp. These rects are what native paints over in its captured VIDEO frames — a field missing here is
// legible in the recording, whatever the DOM-replay side does.

const matches = (html: string): boolean => {
  document.body.innerHTML = html;
  const el = document.querySelector('input');
  // `?? false` keeps this FAIL-CLOSED: a fixture whose input never parsed reports "not secure" and fails
  // its case loudly, rather than being read as a pass.
  return el?.matches(SECURE_INPUT_SELECTOR) ?? false;
};

describe('the WebView secure-input floor', () => {
  it.each([
    ['type=password', '<input type="password">'],
    ['type=PASSWORD (case)', '<input type="PASSWORD">'],
    ['type=tel', '<input type="tel">'],
    ['type=TEL (case)', '<input type="TEL">'],
    ['autocomplete=cc-number', '<input autocomplete="cc-number">'],
    ['autocomplete=CC-NUMBER (case)', '<input autocomplete="CC-NUMBER">'],
    ['multi-token cc', '<input autocomplete="section-b shipping cc-number">'],
    ['autocomplete=current-password', '<input autocomplete="current-password">'],
    ['autocomplete=new-password', '<input autocomplete="new-password">'],
    ['autocomplete=one-time-code', '<input autocomplete="one-time-code">'],
    ['multi-token one-time-code', '<input autocomplete="webauthn one-time-code">'],
    ['rrweb password stamp', '<input type="text" data-rr-is-password="true">'],
  ])('masks %s', (_label, html) => {
    expect(matches(html)).toBe(true);
  });

  it.each([
    ['a plain text input', '<input type="text">'],
    ['a search box', '<input type="search" autocomplete="off">'],
    ['an email field', '<input type="email" autocomplete="email">'],
    ['a name field', '<input autocomplete="given-name">'],
  ])('does NOT mask %s — the floor stays surgical', (_label, html) => {
    expect(matches(html)).toBe(false);
  });

  it.each([
    ['password', '<input type="password" class="bugsee-show">'],
    ['cc-number', '<input autocomplete="cc-number" class="bugsee-show">'],
    ['one-time-code', '<input autocomplete="webauthn one-time-code" class="bugsee-show">'],
    ['tel', '<input type="tel" class="bugsee-show">'],
  ])('honours the legacy `.bugsee-show` opt-out on %s', (_label, html) => {
    // Every matcher must carry the opt-out, not just the first — the legacy contract is per-element.
    expect(matches(html)).toBe(false);
  });

  // The floor is FORM-CONTROL scoped: it hit-tests `input` elements. Nothing pinned that, so shaping the
  // shared `@bugsee/core` matcher list without the `input` prefix (which widens the floor to any node
  // carrying a `type`/`autocomplete`/`data-rr-is-password` attribute) went unnoticed. Over-masking is
  // fail-safe but it is not the contract, and a rect over an unrelated `<div type="tel">` blanks real UI.
  it('scopes every matcher to an input element', () => {
    for (const fragment of SECURE_INPUT_SELECTOR.split(',')) {
      expect(fragment.trim().startsWith('input[')).toBe(true);
    }
    document.body.innerHTML = '<div type="tel"></div><span data-rr-is-password="true"></span>';
    for (const el of document.body.children) expect(el.matches(SECURE_INPUT_SELECTOR)).toBe(false);
  });

  it('is a selector the DOM can actually parse', () => {
    expect(() => document.createElement('div').matches(SECURE_INPUT_SELECTOR)).not.toThrow();
  });
});
