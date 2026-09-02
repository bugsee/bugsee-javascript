import { describe, expect, expectTypeOf, it } from 'vitest';
import { type InputEvent, InputTool } from './events';

describe('InputTool', () => {
  // These numbers are a WIRE contract, not an internal enum: the viewer switches on them
  // (`RecordingTouchTool`) and Android's `InputUtils` produces them. Renumbering silently
  // re-labels every recorded interaction, so the values are pinned literally.
  it('matches the viewer/Android/iOS tool numbering exactly', () => {
    expect(InputTool).toStrictEqual({
      Unknown: 0,
      Touch: 1,
      Mouse: 2,
      Pen: 3,
      Remote: 4,
      Other: 5,
      Eraser: 6,
      Key: 7,
      Gamepad: 8,
      Rotary: 9,
      Trackball: 10,
    });
  });

  it('is frozen so a consumer cannot renumber the wire contract at runtime', () => {
    expect(Object.isFrozen(InputTool)).toBe(true);
  });

  it('only 1/2/3 are the tools the viewer renders — the rest must not collide with them', () => {
    const rendered = [InputTool.Touch, InputTool.Mouse, InputTool.Pen];
    for (const other of [
      InputTool.Unknown,
      InputTool.Remote,
      InputTool.Other,
      InputTool.Eraser,
      InputTool.Key,
      InputTool.Gamepad,
      InputTool.Rotary,
      InputTool.Trackball,
    ]) {
      expect(rendered).not.toContain(other);
    }
  });
});

describe('InputEvent (the input-stream wire shape)', () => {
  it('accepts the full RecordingTouchEvent contract shape', () => {
    const pointer: InputEvent = {
      id: 'p1',
      type: 'begin',
      timestamp: 5,
      x: 10,
      y: 20,
      force: 0.5,
      majorRadius: 3,
      minorRadius: 3,
      tool: InputTool.Touch,
      view: 'btn primary',
      view_id: 'submit',
      view_tag: 'button',
    };
    expect(pointer.tool).toBe(1);
  });

  it('types the SDK-ahead-of-contract fields (button/key/modifiers/target)', () => {
    const key: InputEvent = {
      type: 'begin',
      timestamp: 1,
      tool: InputTool.Key,
      key: 'Enter',
      keyCode: 66,
      metaState: 4096 | 1,
      button: 2,
      target: { tag: 'button' },
    };
    expect(key.key).toBe('Enter');
    expectTypeOf<InputEvent['button']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<InputEvent['key']>().toEqualTypeOf<string | undefined>();
  });

  it('requires timestamp and type — everything else is optional', () => {
    const minimal: InputEvent = { type: 'end', timestamp: 0 };
    expect(minimal).toStrictEqual({ type: 'end', timestamp: 0 });
    expectTypeOf<InputEvent['tool']>().toEqualTypeOf<
      0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | undefined
    >();
  });
});
