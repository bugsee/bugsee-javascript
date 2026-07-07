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
  /** Additional CSS selector to block. */
  blockSelector?: string;
  /** Additional CSS selector whose input events to ignore. */
  ignoreSelector?: string;
}

/** The rrweb `record()` masking/blocking fields we resolve. `maskAllInputs`/`maskInputOptions` are typed
 *  against the real rrweb options; the three selectors are always populated (fail-closed), so they are
 *  required `string` here (assignable back to rrweb's optional fields when spread into `record()`). */
export type ResolvedReplayMasking = Pick<
  recordOptions<unknown>,
  'maskAllInputs' | 'maskInputOptions'
> & {
  maskTextSelector: string;
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
    // `maskAllText` → mask every text node (`*`); otherwise only opt-in Bugsee-marked text.
    maskTextSelector: maskAllText ? '*' : joinSelectors(BUGSEE_MASK, options.maskTextSelector),
    blockSelector: joinSelectors(
      BUGSEE_BLOCK,
      blockAllMedia ? MEDIA_SELECTOR : undefined,
      options.blockSelector,
    ),
    ignoreSelector: joinSelectors(BUGSEE_IGNORE, options.ignoreSelector),
  };
}
