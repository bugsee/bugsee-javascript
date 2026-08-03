// @bugsee/replay — the fail-closed masking config (design D3 / sdk-design.md §27#10). Maps Bugsee's
// privacy-first ReplayOptions onto rrweb's `record()` masking/blocking surface. Privacy is THE risk surface,
// so this is a pure, exhaustively-tested function.
//
// Defaults (all opt-OUT, never opt-in): mask ALL text, mask ALL inputs, block ALL media. Sensitive inputs
// (password / tel / credit-card / one-time-code) are ALWAYS masked — a hard floor that no option and no DOM
// marking can lift. Iframes are blocked (a placeholder, contents never recorded). Bugsee-namespaced DOM
// conventions (`.bugsee-mask`/`[data-bugsee-mask]`, `.bugsee-block`, `.bugsee-ignore`) are additive to
// rrweb's `rr-*` defaults.
//
// Wave 1.3/1.4 rewrote three things that made "fail-closed" untrue in practice
// (docs/review/replay.md SEV1 #1/#2/#3, SEV2 #4/#10/#11):
//
//  1. THE SENSITIVE FLOOR IS ENFORCED IN THE SELECTOR, not in `maskInputOptions`. rrweb resolves an input's
//     value as `unmaskInputSelector.matches(el) ? raw : maskInputValue(…)` — the un-mask check comes FIRST
//     and short-circuits the entire masking call, so `maskInputOptions:{password:true}` is simply never
//     consulted for an un-masked element. Reusing the TEXT un-mask selector for inputs therefore voided the
//     documented "passwords are always masked" guarantee outright. The un-mask selector now carries a
//     `:not(…)` guard per sensitive input, so a sensitive input can never match it, and the caller's text
//     selector no longer feeds the input path at all.
//  2. ATTRIBUTES ARE AN ALLOWLIST. A denylist over an open namespace is fail-OPEN by construction: every
//     `data-*` attribute, `<meta content>` and any custom attribute shipped in the clear at DEFAULTS. Only
//     rendering-critical attributes now pass through; everything else is masked.
//  3. A MALFORMED CALLER SELECTOR CANNOT DISABLE PRIVACY. Selectors are comma-joined into ONE string, so a
//     single bad fragment made `matches()` throw for EVERY element — and rrweb's bare `catch {}` answers
//     "not blocked", silently disabling blocking page-wide. Each caller fragment is now validated; an
//     invalid one is dropped, reported, and — where dropping would itself weaken privacy — escalated to the
//     strictest setting.
//
// NOTE: upstream rrweb 2.1 has no `maskAllText` boolean (we emulate it with `maskTextSelector: '*'`) and no
// `unmask`/`unblock` selectors — the Bugsee rrweb fork (docs/design/replay.md §4, Tier 1) adds attribute
// masking + sensitive-input hardening + opt-out selectors; this config stays fail-closed on upstream in the
// meantime.
import type { recordOptions } from '@bugsee/rrweb';

/** Media/embedded elements blocked (rendered as same-size placeholders, contents not recorded) when
 *  `blockAllMedia`. Includes `iframe` — iframes are never recorded (§27#10). */
export const MEDIA_SELECTOR = 'img,svg,image,video,audio,object,picture,embed,map,source,iframe';

/** All `<canvas>` elements — blocked (placeholder, contents not recorded) when `blockAllCanvas`, so canvas
 *  recording then captures ONLY canvases explicitly opted in via `.bugsee-show`/`[data-bugsee-show]`. */
export const CANVAS_SELECTOR = 'canvas';

/** Bugsee-namespaced opt-in selectors, additive to rrweb's `rr-*` class defaults. */
const BUGSEE_MASK = '.bugsee-mask,[data-bugsee-mask]';
const BUGSEE_BLOCK = '.bugsee-block,[data-bugsee-block]';
const BUGSEE_IGNORE = '.bugsee-ignore,[data-bugsee-ignore]';

/** Bugsee-namespaced opt-OUT selectors (D3): un-mask text, un-block media. */
const BUGSEE_UNMASK = '.bugsee-unmask,[data-bugsee-unmask]';
const BUGSEE_SHOW = '.bugsee-show,[data-bugsee-show]';

/**
 * Inputs that are ALWAYS masked, whatever the options or the markup say.
 *
 * Matched case-insensitively (` i`): `type` and `autocomplete` values are ASCII-case-insensitive in HTML, and
 * a `type="PASSWORD"` must not slip the floor. `autocomplete*="cc-"` covers the whole credit-card family
 * (`cc-number`, `cc-name`, `cc-csc`, …), which is broader than the eight literal tokens the rrweb fork's own
 * sensitive set carries.
 */
const SENSITIVE_INPUT_MATCHERS = [
  '[type="password" i]',
  '[type="tel" i]',
  '[autocomplete*="password" i]',
  '[autocomplete*="cc-" i]',
  '[autocomplete="one-time-code" i]',
];

/** `:not(…)` chain excluding every sensitive input, appended to each un-mask fragment. Chained rather than
 *  `:not(a, b)` because the selector-list form of `:not()` is newer than the browsers we support. */
const SENSITIVE_INPUT_GUARD = SENSITIVE_INPUT_MATCHERS.map((m) => `:not(${m})`).join('');

/**
 * The input un-mask selector: Bugsee's opt-out marks, each guarded so a sensitive input can never match.
 *
 * The caller's `unmaskTextSelector` is deliberately NOT joined in. It used to be, which meant (a)
 * `unmaskTextSelector: '*'` un-masked every password on the page, and (b) a developer could not un-mask an
 * input's LABEL text without also un-masking its VALUE — the two were the same knob.
 */
const BUGSEE_UNMASK_INPUT = BUGSEE_UNMASK.split(',')
  .map((fragment) => `${fragment}${SENSITIVE_INPUT_GUARD}`)
  .join(',');

/**
 * Attributes whose values pass through UNMASKED because replay cannot render without them.
 *
 * This is an ALLOWLIST: anything absent is masked. The previous denylist covered eleven names, so every
 * `data-user-email`, `<meta content>` and bespoke attribute was serialized verbatim under default settings.
 */
const STRUCTURAL_ATTRIBUTES = new Set([
  // identity + presentation
  'class',
  'id',
  'style',
  'dir',
  'lang',
  'translate',
  'hidden',
  'tabindex',
  'role',
  'slot',
  'part',
  // links + embedded resources (rrweb resolves these on its own path and never calls this function for
  // them — listed for intent, see the KNOWN RESIDUAL note on `maskAttribute`)
  'href',
  'src',
  'srcset',
  'sizes',
  'media',
  'rel',
  'target',
  'type',
  'crossorigin',
  'referrerpolicy',
  'integrity',
  'loading',
  'decoding',
  'as',
  'poster',
  'preload',
  'download',
  'ping',
  'usemap',
  'ismap',
  'shape',
  'coords',
  'charset',
  'http-equiv',
  'property',
  'sandbox',
  'allow',
  'allowfullscreen',
  'frameborder',
  'scrolling',
  'marginwidth',
  'marginheight',
  'async',
  'defer',
  'nomodule',
  // layout + tables
  'width',
  'height',
  'align',
  'valign',
  'colspan',
  'rowspan',
  'span',
  'scope',
  'headers',
  'start',
  'reversed',
  'cellpadding',
  'cellspacing',
  'border',
  'bgcolor',
  'color',
  'face',
  // form CONTROL STATE — names and flags, never user-entered values (`value` is NOT here)
  'name',
  'for',
  'form',
  'method',
  'action',
  'enctype',
  'novalidate',
  'accept',
  'accept-charset',
  'disabled',
  'checked',
  'selected',
  'readonly',
  'multiple',
  'required',
  'step',
  'min',
  'max',
  'maxlength',
  'minlength',
  'size',
  'cols',
  'rows',
  'wrap',
  'autofocus',
  'inputmode',
  'enterkeyhint',
  // media playback flags
  'controls',
  'autoplay',
  'loop',
  'muted',
  'playsinline',
  // SVG geometry + paint — masking any of these silently destroys every icon on the page
  'd',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
  'stroke-miterlimit',
  'opacity',
  'transform',
  'viewbox',
  'preserveaspectratio',
  'xmlns',
  'xmlns:xlink',
  'xlink:href',
  'version',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'dx',
  'dy',
  'points',
  'pathlength',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientunits',
  'gradienttransform',
  'patternunits',
  'patterncontentunits',
  'spreadmethod',
  'clip-path',
  'clip-rule',
  'mask',
  'filter',
  'marker-start',
  'marker-mid',
  'marker-end',
  'vector-effect',
  'shape-rendering',
  'text-anchor',
  'dominant-baseline',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
]);

/** Attribute-name prefixes that pass through: Bugsee's own masking marks (they DRIVE masking, so masking
 *  them would disable it) and rrweb's internal bookkeeping. */
const STRUCTURAL_PREFIXES = ['data-bugsee-', 'data-rr', 'rr_', '_'];

/**
 * Fail-closed attribute masker: passes rendering-critical attributes through and masks every other value,
 * preserving its length so layout is unaffected.
 *
 * KNOWN RESIDUAL — URL attributes never reach here. Measured against the fork: recording a page with
 * `<a href="/reset?token=…">` and `<img src="/p.png?sig=…">` under an instrumented `maskAttributeFn` shows
 * ONLY `data-x` arriving; rrweb resolves and absolutizes `href`/`src`/`srcset`/`style` on its own path and
 * never consults this function for them. So PII embedded in a URL (a signed link, a path segment carrying an
 * email) is recorded verbatim and CANNOT be scrubbed from this seam — closing it needs a change in the rrweb
 * fork. The previous comment here said these were "handled by rrweb", which read as "made safe"; they are
 * handled in the sense of being rewritten, not redacted.
 */
function maskAttribute(key: string, value: string): string {
  if (typeof value !== 'string') {
    return value; // rrweb hands booleans/numbers for some properties — never call String methods on them
  }
  const name = key.toLowerCase();
  if (STRUCTURAL_ATTRIBUTES.has(name) || STRUCTURAL_PREFIXES.some((p) => name.startsWith(p))) {
    return value;
  }
  return '*'.repeat(value.length);
}

/** The privacy-relevant ReplayOptions (a subset of the public replay options). */
export interface ReplayMaskingOptions {
  /** Mask every text node. Default `true` (fail-closed). When `false`, only Bugsee-marked text is masked. */
  maskAllText?: boolean;
  /** Mask every input value. Default `true`. (Sensitive inputs are masked regardless.) */
  maskAllInputs?: boolean;
  /** Block all media/iframes (placeholders). Default `true`. */
  blockAllMedia?: boolean;
  /** Block all `<canvas>` — record ONLY canvases opted in via `.bugsee-show`. Default `false` (the canvas
   *  add-on being opt-in is the primary gate; this is the extra-strict opt-in-per-canvas mode). */
  blockAllCanvas?: boolean;
  /** Additional CSS selector whose text to mask. */
  maskTextSelector?: string;
  /** Additional CSS selector whose TEXT to UN-mask (opt back in), additive to `.bugsee-unmask`. Does not
   *  un-mask input VALUES — those follow the sensitive floor and Bugsee's own opt-out marks only. */
  unmaskTextSelector?: string;
  /** Additional CSS selector to UN-block (opt media back in), additive to `.bugsee-show`. */
  unblockSelector?: string;
  /** Additional CSS selector to block. */
  blockSelector?: string;
  /** Additional CSS selector whose input events to ignore. */
  ignoreSelector?: string;
}

/** Side channel for reporting a configuration problem that would otherwise be silent. */
export interface ReplayMaskingContext {
  onError?: (error: unknown) => void;
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

/** Read an OWN property. `options.x ?? default` walks the prototype chain, so a page-wide
 *  `Object.prototype.maskAllText = false` gadget silently downgraded every default to fail-open. */
function readOwn(source: object, key: string): unknown {
  return Object.hasOwn(source, key) ? (source as Record<string, unknown>)[key] : undefined;
}

/** A boolean option, or the fail-closed default. A non-boolean is NOT coerced: `maskAllText: 0` used to
 *  reach rrweb as `0`, which it reads as "off". */
function readBoolean(source: object, key: string, fallback: boolean): boolean {
  const value = readOwn(source, key);
  return typeof value === 'boolean' ? value : fallback;
}

/** Whether the DOM can parse `selector`. Without a DOM nothing can be validated — and rrweb cannot run
 *  either — so the selector is passed through untouched. */
function isValidSelector(selector: string): boolean {
  const doc = (globalThis as { document?: Document }).document;
  /* v8 ignore next 3 -- DOM-less runtimes never reach rrweb; covered by a stubbed-global test */
  if (doc === undefined) {
    return true;
  }
  try {
    doc.createDocumentFragment().querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

/** A caller selector, validated. An unparseable one is dropped and reported rather than concatenated into
 *  the joined string, where it would make `matches()` throw for every element on the page. */
function readSelector(
  source: object,
  key: string,
  onError: ((error: unknown) => void) | undefined,
): { value?: string; invalid: boolean } {
  const raw = readOwn(source, key);
  if (typeof raw !== 'string' || raw === '') {
    return { invalid: false };
  }
  if (isValidSelector(raw)) {
    return { value: raw, invalid: false };
  }
  onError?.(
    new Error(
      `Bugsee replay: ignoring invalid \`${key}\` CSS selector ${JSON.stringify(raw)} — ` +
        'left in place it would disable masking or blocking for the whole page.',
    ),
  );
  return { invalid: true };
}

/** Resolve fail-closed rrweb masking options from Bugsee's ReplayOptions. Pure. */
export function resolveReplayMaskingOptions(
  options: ReplayMaskingOptions = {},
  context: ReplayMaskingContext = {},
): ResolvedReplayMasking {
  const source: object = options !== null && typeof options === 'object' ? options : {};
  const onError = context?.onError;

  const maskText = readSelector(source, 'maskTextSelector', onError);
  const unmaskText = readSelector(source, 'unmaskTextSelector', onError);
  const unblock = readSelector(source, 'unblockSelector', onError);
  const block = readSelector(source, 'blockSelector', onError);
  const ignore = readSelector(source, 'ignoreSelector', onError);

  // Dropping an invalid fragment is fail-closed for the opt-OUT selectors (less is un-masked/un-blocked),
  // but fail-OPEN for the opt-IN ones — the caller's masking intent would simply vanish. So an unparseable
  // mask/block/ignore selector escalates to the strictest setting instead.
  const maskAllText = readBoolean(source, 'maskAllText', true) || maskText.invalid;
  const maskAllInputs = readBoolean(source, 'maskAllInputs', true) || ignore.invalid;
  const blockAllMedia = readBoolean(source, 'blockAllMedia', true) || block.invalid;
  const blockAllCanvas = readBoolean(source, 'blockAllCanvas', false);

  return {
    maskAllInputs,
    // The floor rrweb applies when it DOES consult masking — the live input observer gates on this map
    // alone and never re-derives the sensitive rules, so every sensitive type has to be named here.
    maskInputOptions: { password: true, tel: true },
    // When masking all text, also redact attribute values, which rrweb serializes separately from text
    // nodes. Consistent with text: skipped when maskAllText is off.
    maskAttributeFn: maskAllText ? maskAttribute : undefined,
    // `maskAllText` masks every text node with a per-element opt-out (a nearer `.bugsee-unmask` wins).
    maskAllText,
    // Additive explicit mask marks (also mask when maskAllText is off).
    maskTextSelector: joinSelectors(BUGSEE_MASK, maskText.value),
    // Per-element opt-OUT (D3): `.bugsee-unmask` un-masks text; `.bugsee-show` un-blocks media.
    unmaskTextSelector: joinSelectors(BUGSEE_UNMASK, unmaskText.value),
    // Inputs take Bugsee's marks ONLY, and only where the sensitive guard admits them.
    unmaskInputSelector: BUGSEE_UNMASK_INPUT,
    unblockSelector: joinSelectors(BUGSEE_SHOW, unblock.value),
    blockSelector: joinSelectors(
      BUGSEE_BLOCK,
      blockAllMedia ? MEDIA_SELECTOR : undefined,
      blockAllCanvas ? CANVAS_SELECTOR : undefined,
      block.value,
    ),
    ignoreSelector: joinSelectors(BUGSEE_IGNORE, ignore.value),
  };
}
