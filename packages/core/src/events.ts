import type { LogLevel } from '@bugsee/protocol';
import type { LogLevelName } from '@bugsee/types';

// Cross-runtime event payload types (design §10/§16). These are the shapes that capture SOURCES
// (interceptors / log sources) emit and CONSUMERS observe. There is no central hub: sources are
// listenable emitters subscribed to directly (see InterceptorBase / emitter.ts).

/** A captured log line (design §10) — the payload a log source (e.g. the console interceptor) emits. */
export interface LogEvent {
  timestamp: number;
  level: LogLevelName | LogLevel;
  source: string;
  tag?: string;
  message: string;
}

/** A breadcrumb payload (design §10). Lives here (a leaf) so filter types can reference it cycle-free. */
export interface Breadcrumb {
  type?: string;
  category?: string;
  message?: string;
  level?: LogLevelName;
  data?: Record<string, unknown>;
  timestamp: number;
}

/** addBreadcrumb input: timestamp is optional (the Client stamps it from the clock). */
export type BreadcrumbInput = Omit<Breadcrumb, 'timestamp'> & { timestamp?: number };

/**
 * Pointer/tool identity on the INPUT stream. The numbers are a WIRE contract shared with the mobile
 * SDKs: Android's `InputUtils` (`interception/input/InputUtils.java`) and iOS's `BGSInputEventTool`
 * (`Interception/Input/BGSInputEvent.h`) both produce them, and the viewer's `RecordingTouchTool`
 * switches on them (it renders 1/2/3 and ignores every other tool, which is what lets this one stream
 * carry keyboard entries without disturbing the touch/mouse/pen rendering path).
 *
 * `Key` (7) is Android's `TOOL_KEY` / iOS's `BGSInputEventToolKey` — present in both mobile SDKs, not
 * yet in the viewer's enum. `Gamepad` (8) / `Rotary` (9) / `Trackball` (10) complete the shared
 * numbering (Android's `TOOL_GAMEPAD`/`TOOL_ROTARY`/`TOOL_TRACKBALL`, iOS's
 * `BGSInputEventToolGamepad`/`BGSInputEventToolRotary`/`BGSInputEventToolTrackball`) so a future
 * gamepad/rotary/trackball capture source cannot collide with an already-assigned wire number by
 * inventing its own.
 */
export const InputTool = Object.freeze({
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
} as const);
export type InputTool = (typeof InputTool)[keyof typeof InputTool];

/**
 * One entry on the `input` capture stream (`input.json`) — a single press/release the SDK OBSERVED the
 * person perform. This is the refinement the design left open: the base used to be a placeholder shape
 * and platform tiers wrote their own; it is now the concrete wire contract, and the runtime sources
 * (`@bugsee/browser`'s DOM input source) only fill it in.
 *
 * The field set is the viewer's `RecordingTouchEvent` (`x`/`y`/`force`/`majorRadius`/`minorRadius`/
 * `tool`/`view`/`view_id`/`view_tag`, grouped into gestures by `id`, staged by `type`), so a web
 * interaction and a mobile touch render through ONE path.
 *
 * SDK-AHEAD-OF-CONTRACT — `button`, `key`, the four modifier flags and `target` are NOT in the viewer's
 * `RecordingTouchEvent` today. Desktop input has buttons and keyboards that the mobile-shaped contract
 * has no room for, and JSON consumers ignore unknown keys, so the SDK emits them as an additive
 * superset rather than waiting on backend/viewer adoption. Nothing may be moved OUT of the contract
 * fields into these; they are additions only.
 */
export interface InputEvent {
  /** Wall-clock ms. */
  timestamp: number;
  /**
   * The interaction STAGE for device input — Android's `InputEventStage`
   * (`interception/input/InputEventStage.java`): `'unknown'` | `'begin'` | `'move'` | `'end'` |
   * `'scroll'` | `'keydown'` | `'keyup'`. That is the COMPLETE set: the enum is produced by SDKs with no
   * DOM, so a DOM-only value structurally cannot join it. Typed as `string` because the viewer's contract
   * types it as `string` — not because the vocabulary is open.
   *
   * `'change'` / `'submit'` / `'focus'` used to ride here under `tool: Other`; they are STATE-CHANGE
   * signals, not device input, and every consumer discarded them (both native WebView receivers drop
   * them; the viewer's `processInput` renders tools 1/2/3 only). They are now BREADCRUMBS
   * (`ui.change`/`ui.submit`/`ui.focus`, `@bugsee/browser`'s `ui-breadcrumb-source.ts`), matching
   * Android's own split between its input dispatcher and its gesture dispatcher.
   */
  type: string;
  /** Groups the stages of ONE interaction (the viewer groups gestures by it). */
  id?: string;
  /** Viewport-relative CSS pixels. */
  x?: number;
  y?: number;
  /** Normalised pressure 0..1 (0 when the device does not report it). */
  force?: number;
  /** Contact-geometry radii (touch/pen); 0 for a mouse. */
  majorRadius?: number;
  minorRadius?: number;
  tool?: InputTool;
  /** Target CLASS — the viewer maps `view`→`target.class` (its own naming is view-tree flavoured). */
  view?: string;
  /** Target element id — the viewer maps `view_id`→`target.id`. */
  view_id?: string;
  /** Target tag name — the viewer maps `view_tag`→`target.tag`. */
  view_tag?: string;

  // ---- SDK-ahead-of-contract (see the note above) ----
  /** Which device button was pressed (DOM `MouseEvent.button`: 0 primary, 1 middle, 2 secondary…). */
  button?: number;
  /** The key's IDENTITY, and only ever a NAMED key — printable characters are never recorded. */
  key?: string;
  ctrl?: true;
  meta?: true;
  alt?: true;
  shift?: true;
  /** A structural, PII-safe description of the target, richer than `view*` (the browser tier's
   *  `TargetDescriptor`: component name, control type, label, masked flag). */
  target?: Record<string, unknown>;
}
