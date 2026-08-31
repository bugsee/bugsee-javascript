// THE single definition of "a form field whose CONTENT is secret".
//
// It used to exist twice — `@bugsee/replay`'s masking floor and `@bugsee/webview`'s obscuring source —
// and the second copy had measurably DRIFTED behind the first (no ` i` flag on the card matcher, so an
// `autocomplete="CC-NUMBER"` field was legible in the native frames; `one-time-code`, `type=tel`,
// `autocomplete*="password"` and rrweb's stamp absent outright). A third copy was about to be born for
// the input stream, which is what forced the hoist: this module is the ONE place the definition lives,
// and every masking/redaction consumer derives its own selector form from it.
//
// It lives in `@bugsee/core` because core is the only package all of `replay` / `browser` / `webview` /
// `capture` already depend on. A static `import` from `@bugsee/replay` was not an option: `@bugsee/browser`
// deliberately lazy-`import()`s replay so rrweb stays out of the errors-only bundle, and an eager import
// of a replay module for six selector strings would have pulled that chunk back in.
//
// These are STRINGS, not DOM calls, so the module stays runtime-portable (core imports no DOM lib).

/**
 * The matchers, ATTRIBUTE-ONLY (no element name) so each consumer can shape them:
 * `@bugsee/replay` uses them bare (its masking walks any node), `@bugsee/webview`'s obscuring source
 * prefixes `input`, and the input source matches them against an event target.
 *
 * `type` values are ASCII case-insensitive per HTML, so the flag there is belt-and-braces; `autocomplete`
 * values are NOT, which is why every autocomplete matcher carries ` i`. `~=` is the token-list operator —
 * `autocomplete` is a LIST, so `webauthn one-time-code` (spec-valid, and the documented pairing for
 * WebAuthn-assisted OTP autofill) must match; `=` did not. `[data-rr-is-password]` is rrweb's own memory
 * of a field whose `type` was flipped away from `password` by a show-password toggle.
 */
export const SENSITIVE_INPUT_MATCHERS: readonly string[] = Object.freeze([
  '[type="password" i]',
  '[type="tel" i]',
  '[autocomplete*="password" i]',
  '[autocomplete*="cc-" i]',
  '[autocomplete~="one-time-code" i]',
  '[data-rr-is-password]',
]);

/** The matchers as one positive selector (the form `Element.matches` / `querySelectorAll` want). */
export const SENSITIVE_INPUT_SELECTOR: string = SENSITIVE_INPUT_MATCHERS.join(',');

/**
 * The `type` values that make a field secret, DERIVED from the matcher list above rather than restated.
 * They back a structural check that needs no `matches` — see `isSensitiveInput`.
 */
const SENSITIVE_TYPES: ReadonlySet<string> = new Set(
  SENSITIVE_INPUT_MATCHERS.flatMap((m) => {
    const parsed = /^\[type="([^"]+)" i\]$/.exec(m);
    return parsed === null ? [] : [(parsed[1] as string).toLowerCase()];
  }),
);

/** The surface we duck-type — core carries no DOM lib, so the DOM is never named here. */
interface MatchableNode {
  matches?: (selector: string) => boolean;
  type?: unknown;
}

/**
 * Does this node hold secret content?
 *
 * FAIL-CLOSED: if `matches` throws (an exotic/instrumented DOM, a host object), the honest answer is
 * "assume it does". The alternative — reporting "not sensitive" when we could not look — would let a
 * password field's keystrokes into the report on exactly the hosts we understand least.
 *
 * A node with no `matches` and no sensitive `type` is a different case: nothing identifies it as a field
 * holding secrets (a text node, `null`, a plain object), so there is nothing to withhold.
 */
export function isSensitiveInput(node: unknown): boolean {
  const el = node as MatchableNode | null | undefined;
  if (el == null) return false;
  // Structural first: it needs nothing but the property, so a `type="password"` field stays protected on
  // a DOM whose `matches` is missing, proxied or stubbed out. Selector matching alone was one absent
  // method away from reporting a password box as an ordinary input.
  if (typeof el.type === 'string' && SENSITIVE_TYPES.has(el.type.toLowerCase())) return true;
  if (typeof el.matches !== 'function') return false;
  try {
    return el.matches(SENSITIVE_INPUT_SELECTOR);
  } catch {
    return true;
  }
}
