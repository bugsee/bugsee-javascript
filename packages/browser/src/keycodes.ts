// DOM `KeyboardEvent.key` → Android `KeyEvent` keycode, and DOM modifier flags → Android `metaState`.
//
// The `input` stream is mobile-canonical: Android's `InputEvent` (`interception/input/InputEvent.java`)
// carries `keyCode: int` and `metaState: int`, iOS's `BGSInputEvent` the same, and the viewer reads those.
// The web tier used to emit a `key` STRING and four bespoke booleans instead, so a web recording and a
// mobile one described the same key press in two unrelated vocabularies and nothing downstream could read
// both (docs/review/OPEN-FINDINGS.md R3-12).
//
// Every number below was read out of the real `android.view.KeyEvent` in `android.jar` with `javap`, not
// recalled: this file is a wire contract with another SDK, and a plausible-looking wrong constant would
// mislabel keys in the viewer with nothing to catch it.
//
// `key` (the string) is still emitted alongside. It is an SDK-ahead-of-contract field, and it is strictly
// more informative on the web, where layouts and named keys do not map cleanly onto a phone keypad.

/** `InputUtils.KEYCODE_REDACTED` — a character-producing, or simply unrecognised, key. */
export const KEYCODE_REDACTED = -1;

/** Android `KeyEvent.META_*` flags, as the DOM exposes the same modifiers. */
const META_SHIFT_ON = 1;
const META_ALT_ON = 2;
const META_CTRL_ON = 4096;
const META_META_ON = 65536;

/**
 * The named keys the SDK can actually capture, mapped to their Android keycodes.
 *
 * Deliberately NOT exhaustive over `KeyEvent`: a key that does not appear here reports
 * {@link KEYCODE_REDACTED} rather than a guess, because a wrong code is worse than an absent one — the
 * viewer would name a different key with full confidence.
 *
 * NO SINGLE-CHARACTER KEY MAY BE ADDED HERE. That is what redacts character-producing keys, matching
 * Android's `KEYCODE_REDACTED` rule, and `keycodes.test.ts` sweeps the printable range to enforce it — an
 * explicit `[...key].length === 1` guard used to sit in `androidKeyCode`, but it could never fire while
 * the table held no such entry, so it was untestable protection. The test is the protection.
 */
const KEY_CODES: Readonly<Record<string, number>> = Object.freeze({
  Enter: 66,
  Backspace: 67,
  Delete: 112,
  Tab: 61,
  Escape: 111,
  ArrowUp: 19,
  ArrowDown: 20,
  ArrowLeft: 21,
  ArrowRight: 22,
  Home: 122,
  End: 123,
  PageUp: 92,
  PageDown: 93,
  Shift: 59,
  Control: 113,
  Alt: 57,
  Meta: 117,
  CapsLock: 115,
  Insert: 124,
  ContextMenu: 82,
  NumLock: 143,
  ScrollLock: 116,
  Pause: 121,
  PrintScreen: 120,
  GoBack: 4, // KEYCODE_BACK, for a WebView running inside an Android app
  F1: 131,
  F2: 132,
  F3: 133,
  F4: 134,
  F5: 135,
  F6: 136,
  F7: 137,
  F8: 138,
  F9: 139,
  F10: 140,
  F11: 141,
  F12: 142,
});

/**
 * The Android keycode for a DOM key name, or {@link KEYCODE_REDACTED} for anything not in the table.
 *
 * A character-producing key is therefore ALWAYS redacted — including when it was reached as a shortcut
 * (Ctrl+C), exactly as Android redacts it. The accompanying `key` string still carries the shortcut's
 * identity for consumers that want it; the mobile-shaped field stays mobile-shaped.
 */
export function androidKeyCode(key: string): number {
  return KEY_CODES[key] ?? KEYCODE_REDACTED;
}

/** The modifiers a DOM keyboard event reports, as an Android `metaState` bitmask (0 when none). */
export function androidMetaState(event: {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): number {
  return (
    (event.ctrlKey === true ? META_CTRL_ON : 0) |
    (event.metaKey === true ? META_META_ON : 0) |
    (event.altKey === true ? META_ALT_ON : 0) |
    (event.shiftKey === true ? META_SHIFT_ON : 0)
  );
}
