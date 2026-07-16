import { describe, expect, it } from 'vitest';
import { MEDIA_SELECTOR, resolveReplayMaskingOptions } from './masking';

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

  it('ALWAYS masks password inputs, even when maskAllInputs is turned off (hard floor)', () => {
    const m = resolveReplayMaskingOptions({ maskAllInputs: false });
    expect(m.maskAllInputs).toBe(false);
    expect(m.maskInputOptions).toEqual({ password: true }); // never unmaskable
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
