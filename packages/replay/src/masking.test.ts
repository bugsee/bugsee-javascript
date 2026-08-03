import { describe, expect, it } from 'vitest';
import { CANVAS_SELECTOR, MEDIA_SELECTOR, resolveReplayMaskingOptions } from './masking';

describe('resolveReplayMaskingOptions — fail-closed defaults', () => {
  it('defaults to masking ALL text, ALL inputs, and blocking ALL media', () => {
    const m = resolveReplayMaskingOptions();
    expect(m.maskAllInputs).toBe(true);
    expect(m.maskAllText).toBe(true); // every text node masked, with per-element opt-out
    expect(m.blockSelector).toContain(MEDIA_SELECTOR); // blockAllMedia
  });

  it('wires the .bugsee-unmask / .bugsee-show opt-out selectors (D3)', () => {
    const m = resolveReplayMaskingOptions();
    expect(m.unmaskTextSelector).toContain('.bugsee-unmask');
    expect(m.unmaskInputSelector).toContain('.bugsee-unmask');
    expect(m.unblockSelector).toContain('.bugsee-show');
  });

  it('appends caller-provided unmask/unblock selectors', () => {
    const m = resolveReplayMaskingOptions({
      unmaskTextSelector: '.keep-visible',
      unblockSelector: '.show-chart',
    });
    expect(m.unmaskTextSelector).toContain('.keep-visible');
    expect(m.unblockSelector).toContain('.show-chart');
  });

  it('declares the sensitive types the live input observer gates on, with maskAllInputs off', () => {
    // NOTE: this asserts a property of the returned CONFIG. It is not the hard-floor guarantee — rrweb never
    // consults `maskInputOptions` for an element matched by the un-mask selector, which is exactly how the
    // documented floor came to be false while this test passed (docs/review/replay.md SEV1 #1). The floor
    // itself is asserted against real rrweb in masking.integration.test.ts; this only pins that `tel` is
    // declared, since the live observer gates on this map alone.
    const m = resolveReplayMaskingOptions({ maskAllInputs: false });
    expect(m.maskAllInputs).toBe(false);
    expect(m.maskInputOptions).toEqual({ password: true, tel: true });
  });

  it('falls back to the fail-closed defaults when handed a non-object', () => {
    // `replay: null` / a stray string from untyped JS must not produce a half-built config.
    for (const bad of [null, 'yes', 42]) {
      const m = resolveReplayMaskingOptions(bad as never);
      expect(m.maskAllText, String(bad)).toBe(true);
      expect(m.maskAllInputs, String(bad)).toBe(true);
      expect(m.blockSelector, String(bad)).toContain(MEDIA_SELECTOR);
    }
  });

  it('masks an unknown attribute and passes a structural one through', () => {
    const mask = resolveReplayMaskingOptions().maskAttributeFn as (k: string, v: string) => string;
    expect(mask('data-user-email', 'a@b.com')).toBe('*******'); // length preserved, value gone
    expect(mask('CLASS', 'card')).toBe('card'); // matched case-insensitively
  });

  it('returns a non-string attribute value untouched instead of throwing', () => {
    // rrweb hands a boolean/number for some properties; `'*'.repeat(value.length)` would throw on those,
    // and a throw here escapes into the host page's serialization (docs/review/replay.md SEV3 #8). Not
    // reachable through rrweb itself, so it is pinned directly.
    const mask = resolveReplayMaskingOptions().maskAttributeFn as (
      k: string,
      v: unknown,
    ) => unknown;
    expect(() => mask('data-x', true)).not.toThrow();
    expect(mask('data-x', true)).toBe(true);
    expect(mask('data-x', 42)).toBe(42);
  });

  it('never lets a sensitive input match the input un-mask selector', () => {
    const m = resolveReplayMaskingOptions({ unmaskTextSelector: '*' });
    // Every fragment is one of Bugsee's own marks — the caller's `*` reaches TEXT only, never input values.
    for (const fragment of m.unmaskInputSelector.split(',')) {
      expect(
        fragment.startsWith('.bugsee-unmask') || fragment.startsWith('[data-bugsee-unmask]'),
        fragment,
      ).toBe(true);
      // …and each carries the full sensitive guard, so no fragment can admit a sensitive input.
      for (const guard of ['password', 'tel', 'cc-', 'one-time-code']) {
        expect(fragment, guard).toContain(`:not([`);
        expect(fragment, guard).toContain(guard);
      }
    }
    expect(m.unmaskTextSelector).toContain('*'); // the caller's text opt-out is untouched
  });

  it('when maskAllText is false, masks only Bugsee-marked text (not everything)', () => {
    const m = resolveReplayMaskingOptions({ maskAllText: false });
    expect(m.maskAllText).toBe(false);
    expect(m.maskTextSelector).toContain('.bugsee-mask');
    expect(m.maskTextSelector).toContain('[data-bugsee-mask]');
  });

  it('when blockAllMedia is false, media is NOT force-blocked (only Bugsee-marked)', () => {
    const m = resolveReplayMaskingOptions({ blockAllMedia: false });
    expect(m.blockSelector).not.toContain(MEDIA_SELECTOR);
    expect(m.blockSelector).toContain('.bugsee-block');
    expect(m.blockSelector).toContain('[data-bugsee-block]');
  });

  it('blocks ALL canvas when blockAllCanvas is set (strict opt-in-per-canvas via .bugsee-show)', () => {
    const m = resolveReplayMaskingOptions({ blockAllCanvas: true });
    expect(m.blockSelector).toContain(CANVAS_SELECTOR); // 'canvas' added to the block set
    expect(m.unblockSelector).toContain('.bugsee-show'); // opted-in canvases un-block via the existing selector
  });

  it('does NOT block canvas by default (blockAllCanvas off → the opted-in add-on records canvases)', () => {
    expect(resolveReplayMaskingOptions().blockSelector).not.toContain('canvas');
    expect(resolveReplayMaskingOptions({ blockAllCanvas: false }).blockSelector).not.toContain(
      'canvas',
    );
  });

  it('excludes iframes (blocked) — part of the media set', () => {
    expect(MEDIA_SELECTOR).toContain('iframe');
    expect(resolveReplayMaskingOptions().blockSelector).toContain('iframe');
  });

  it('always includes the Bugsee-namespaced block + ignore selectors', () => {
    const m = resolveReplayMaskingOptions();
    expect(m.blockSelector).toContain('.bugsee-block');
    expect(m.blockSelector).toContain('[data-bugsee-block]');
    expect(m.ignoreSelector).toBe('.bugsee-ignore,[data-bugsee-ignore]');
  });

  it('appends the caller-provided additive selectors', () => {
    const m = resolveReplayMaskingOptions({
      maskAllText: false,
      blockSelector: '.secret',
      ignoreSelector: '.no-track',
      maskTextSelector: '.pii',
    });
    expect(m.maskTextSelector).toContain('.pii');
    expect(m.blockSelector).toContain('.secret');
    expect(m.ignoreSelector).toContain('.no-track');
  });

  it('ignores empty-string additive selectors (no dangling commas)', () => {
    const m = resolveReplayMaskingOptions({
      maskAllText: false,
      blockSelector: '',
      maskTextSelector: '',
    });
    expect(m.blockSelector.startsWith(',')).toBe(false);
    expect(m.blockSelector.endsWith(',')).toBe(false);
    expect(m.blockSelector).not.toContain(',,');
    expect(m.maskTextSelector).not.toContain(',,');
  });
});

describe('resolveReplayMaskingOptions — attribute masking (maskAttributeFn)', () => {
  const el = () =>
    (globalThis as { document?: Document }).document?.createElement('div') ?? ({} as HTMLElement);

  it('provides a maskAttributeFn by default (fail-closed) that redacts user-content attributes', () => {
    const { maskAttributeFn } = resolveReplayMaskingOptions();
    expect(typeof maskAttributeFn).toBe('function');
    expect(maskAttributeFn?.('placeholder', 'you@host.com', el())).toBe('************');
    expect(maskAttributeFn?.('title', 'Secret', el())).toBe('******');
    expect(maskAttributeFn?.('aria-label', 'Email', el())).toBe('*****');
  });

  it('leaves structural attributes (class/id/type) untouched', () => {
    const { maskAttributeFn } = resolveReplayMaskingOptions();
    expect(maskAttributeFn?.('class', 'btn primary', el())).toBe('btn primary');
    expect(maskAttributeFn?.('id', 'submit', el())).toBe('submit');
    expect(maskAttributeFn?.('type', 'text', el())).toBe('text');
  });

  it('is case-insensitive on the attribute name', () => {
    const { maskAttributeFn } = resolveReplayMaskingOptions();
    expect(maskAttributeFn?.('PLACEHOLDER', 'abcd', el())).toBe('****');
  });

  it('does NOT set a maskAttributeFn when maskAllText is off (consistent with text)', () => {
    expect(resolveReplayMaskingOptions({ maskAllText: false }).maskAttributeFn).toBeUndefined();
  });
});
