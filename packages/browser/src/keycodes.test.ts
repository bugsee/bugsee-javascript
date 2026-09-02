import { describe, expect, it } from 'vitest';
import { androidKeyCode, androidMetaState, KEYCODE_REDACTED } from './keycodes';

describe('androidKeyCode', () => {
  // Verified against the real `android.view.KeyEvent` in android.jar (`javap -constants`), because this
  // is a wire contract shared with the mobile SDKs and a plausible wrong number would mislabel keys in
  // the viewer with nothing downstream to catch it.
  it.each([
    ['Enter', 66],
    ['Backspace', 67],
    ['Delete', 112],
    ['Tab', 61],
    ['Escape', 111],
    ['ArrowUp', 19],
    ['ArrowDown', 20],
    ['ArrowLeft', 21],
    ['ArrowRight', 22],
    ['Home', 122],
    ['End', 123],
    ['PageUp', 92],
    ['PageDown', 93],
    ['Shift', 59],
    ['Control', 113],
    ['Alt', 57],
    ['Meta', 117],
    ['CapsLock', 115],
    ['Insert', 124],
    ['ContextMenu', 82],
    ['NumLock', 143],
    ['ScrollLock', 116],
    ['Pause', 121],
    ['PrintScreen', 120],
    ['GoBack', 4],
    ['F1', 131],
    ['F12', 142],
  ])('maps %s to KeyEvent code %i', (key, code) => {
    expect(androidKeyCode(key)).toBe(code);
  });

  // THE PRIVACY INVARIANT, swept rather than asserted case by case: no single-character key may ever
  // resolve to a real keycode, because a keycode names the character. It is enforced here rather than by
  // a guard in the function, since a guard that the table can never trigger is untestable protection —
  // a mutation deleting it changed no test. Adding `'a': 29` to the table fails this.
  it('redacts EVERY printable character, so no typed glyph can be named by its code', () => {
    const printable = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) =>
      String.fromCharCode(0x20 + i),
    );
    const leaked = printable.filter((c) => androidKeyCode(c) !== KEYCODE_REDACTED);
    expect(leaked).toEqual([]);
  });

  it('redacts multi-byte single graphemes too — emoji and CJK are characters, not named keys', () => {
    for (const key of ['😀', 'を', 'é', 'ß']) {
      expect(androidKeyCode(key)).toBe(KEYCODE_REDACTED);
    }
  });

  it('redacts an unrecognised NAMED key rather than inventing a code for it', () => {
    expect(androidKeyCode('BrightnessUp')).toBe(KEYCODE_REDACTED);
    expect(androidKeyCode('')).toBe(KEYCODE_REDACTED);
  });
});

describe('androidMetaState', () => {
  it('is 0 when nothing is held', () => {
    expect(androidMetaState({})).toBe(0);
  });

  // META_SHIFT_ON 1, META_ALT_ON 2, META_CTRL_ON 4096, META_META_ON 65536 — from android.jar.
  it.each([
    [{ shiftKey: true }, 1],
    [{ altKey: true }, 2],
    [{ ctrlKey: true }, 4096],
    [{ metaKey: true }, 65536],
  ])('maps a single modifier to its own flag', (event, expected) => {
    expect(androidMetaState(event)).toBe(expected);
  });

  it('ORs the flags together, so each modifier occupies its own bit', () => {
    expect(androidMetaState({ ctrlKey: true, shiftKey: true, altKey: true, metaKey: true })).toBe(
      4096 + 1 + 2 + 65536,
    );
  });

  it('treats a falsy or absent flag as not held', () => {
    expect(androidMetaState({ ctrlKey: false, shiftKey: undefined })).toBe(0);
  });
});
