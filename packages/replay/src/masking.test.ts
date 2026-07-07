import { describe, expect, it } from 'vitest';
import { MEDIA_SELECTOR, resolveReplayMaskingOptions } from './masking';

describe('resolveReplayMaskingOptions — fail-closed defaults', () => {
  it('defaults to masking ALL text, ALL inputs, and blocking ALL media', () => {
    const m = resolveReplayMaskingOptions();
    expect(m.maskAllInputs).toBe(true);
    expect(m.maskTextSelector).toBe('*'); // maskAllText → every text node masked
    expect(m.blockSelector).toContain(MEDIA_SELECTOR); // blockAllMedia
  });

  it('ALWAYS masks password inputs, even when maskAllInputs is turned off (hard floor)', () => {
    const m = resolveReplayMaskingOptions({ maskAllInputs: false });
    expect(m.maskAllInputs).toBe(false);
    expect(m.maskInputOptions).toEqual({ password: true }); // never unmaskable
  });

  it('when maskAllText is false, masks only Bugsee-marked text (not everything)', () => {
    const m = resolveReplayMaskingOptions({ maskAllText: false });
    expect(m.maskTextSelector).not.toBe('*');
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
