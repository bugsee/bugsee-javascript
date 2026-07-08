// @bugsee/replay — the fail-closed masking config (design D3 / sdk-design.md §27#10). Maps Bugsee's
// privacy-first ReplayOptions onto rrweb's `record()` masking/blocking surface. Privacy is THE risk surface,
// so this is a pure, exhaustively-tested function.
//
// Defaults (all opt-OUT, never opt-in): mask ALL text, mask ALL inputs, block ALL media. Password inputs are
// ALWAYS masked (a hard floor — never unmaskable even if `maskAllInputs` is turned off). Iframes are blocked
// (a placeholder, contents never recorded). Bugsee-namespaced DOM conventions (`.bugsee-mask`/
// `[data-bugsee-mask]`, `.bugsee-block`, `.bugsee-ignore`) are additive to rrweb's `rr-*` defaults.
//
// NOTE: upstream rrweb 2.1 has no `maskAllText` boolean (we emulate it with `maskTextSelector: '*'`) and no
// `unmask`/`unblock` selectors — the Bugsee rrweb fork (docs/design/replay.md §4, Tier 1) adds attribute
// masking + sensitive-input (`cc-*`/`tel`) hardening + opt-out selectors; this config stays fail-closed on
// upstream in the meantime.
import type { recordOptions } from '@bugsee/rrweb';

/** Media/embedded elements blocked (rendered as same-size placeholders, contents not recorded) when
 *  `blockAllMedia`. Includes `iframe` — iframes are never recorded (§27#10). */
export const MEDIA_SELECTOR = 'img,svg,image,video,audio,object,picture,embed,map,source,iframe';

/** Bugsee-namespaced opt-in selectors, additive to rrweb's `rr-*` class defaults. */
const BUGSEE_MASK = '.bugsee-mask,[data-bugsee-mask]';
const BUGSEE_BLOCK = '.bugsee-block,[data-bugsee-block]';
const BUGSEE_IGNORE = '.bugsee-ignore,[data-bugsee-ignore]';

/** Attribute names whose values carry user content (not structure) and must be redacted when masking text.
 *  Structural attributes (class/id/type/name/role/…) are intentionally excluded to preserve replay fidelity;
 *  URL/style attributes (src/href/srcset/style) are handled by rrweb before `maskAttributeFn` runs. */
const MASKED_ATTRIBUTES = new Set([
  'title',
  'alt',
  'placeholder',
  'label',
  'value',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-valuetext',
  'aria-roledescription',
  'data-tooltip',
]);

/** Fail-closed attribute masker: redacts the value of a user-content attribute, passes structure through. */
function maskAttribute(key: string, value: string): string {
  return MASKED_ATTRIBUTES.has(key.toLowerCase()) ? '*'.repeat(value.length) : value;
}

/** Bugsee-namespaced opt-OUT selectors (D3): un-mask text/inputs, un-block media. */
const BUGSEE_UNMASK = '.bugsee-unmask,[data-bugsee-unmask]';
const BUGSEE_SHOW = '.bugsee-show,[data-bugsee-show]';

/** The privacy-relevant ReplayOptions (a subset of the public replay options). */
export interface ReplayMaskingOptions {
  /** Mask every text node. Default `true` (fail-closed). When `false`, only Bugsee-marked text is masked. */
  maskAllText?: boolean;
  /** Mask every input value. Default `true`. (Password inputs are masked regardless.) */
  maskAllInputs?: boolean;
  /** Block all media/iframes (placeholders). Default `true`. */
  blockAllMedia?: boolean;
  /** Additional CSS selector whose text to mask. */
  maskTextSelector?: string;
  /** Additional CSS selector whose text/inputs to UN-mask (opt back in), additive to `.bugsee-unmask`. */
  unmaskTextSelector?: string;
  /** Additional CSS selector to UN-block (opt media back in), additive to `.bugsee-show`. */
  unblockSelector?: string;
  /** Additional CSS selector to block. */
  blockSelector?: string;
  /** Additional CSS selector whose input events to ignore. */
  ignoreSelector?: string;
}

/** The rrweb `record()` masking/blocking fields we resolve. Selectors are always populated (fail-closed). */
export type ResolvedReplayMasking = Pick<
  recordOptions<unknown>,
  'maskAllInputs' | 'maskInputOptions' | 'maskAttributeFn' | 'maskAllText'
> & {
  maskTextSelector: string;
  unmaskTextSelector: string;
  unmaskInputSelector: string;
  unblockSelector: string;
  blockSelector: string;
  ignoreSelector: string;
};

/** Join non-empty selector fragments with `,` (no dangling/empty commas). */
function joinSelectors(...parts: Array<string | undefined>): string {
  return parts.filter((p): p is string => p !== undefined && p !== '').join(',');
}

/** Resolve fail-closed rrweb masking options from Bugsee's ReplayOptions. Pure. */
export function resolveReplayMaskingOptions(
  options: ReplayMaskingOptions = {},
): ResolvedReplayMasking {
  const maskAllText = options.maskAllText ?? true;
  const maskAllInputs = options.maskAllInputs ?? true;
  const blockAllMedia = options.blockAllMedia ?? true;

  return {
    maskAllInputs,
    // Password inputs are ALWAYS masked — even with `maskAllInputs: false`, this hard floor stands.
    maskInputOptions: { password: true },
    // When masking all text, also redact user-content attribute values (placeholder/title/aria-label/…),
    // which rrweb serializes separately from text nodes. Consistent with text: skipped when maskAllText is off.
    maskAttributeFn: maskAllText ? maskAttribute : undefined,
    // `maskAllText` masks every text node with a per-element opt-out (a nearer `.bugsee-unmask` wins).
    maskAllText,
    // Additive explicit mask marks (also mask when maskAllText is off).
    maskTextSelector: joinSelectors(BUGSEE_MASK, options.maskTextSelector),
    // Per-element opt-OUT (D3): `.bugsee-unmask` un-masks text + inputs; `.bugsee-show` un-blocks media.
    unmaskTextSelector: joinSelectors(BUGSEE_UNMASK, options.unmaskTextSelector),
    unmaskInputSelector: joinSelectors(BUGSEE_UNMASK, options.unmaskTextSelector),
    unblockSelector: joinSelectors(BUGSEE_SHOW, options.unblockSelector),
    blockSelector: joinSelectors(
      BUGSEE_BLOCK,
      blockAllMedia ? MEDIA_SELECTOR : undefined,
      options.blockSelector,
    ),
    ignoreSelector: joinSelectors(BUGSEE_IGNORE, options.ignoreSelector),
  };
}
