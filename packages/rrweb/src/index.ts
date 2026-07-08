// @bugsee/rrweb — the single, SWAPPABLE rrweb import point for @bugsee/replay (+ @bugsee/replay-canvas).
//
// The RECORD path is consumed from the Bugsee-hardened rrweb fork via `@bugsee/rrweb-record` (a git
// dependency on github.com/bugsee/rrweb#bugsee-dist — a prebuilt, record-only bundle with the replay
// player tree-shaken out; ~56 KB gzip). Swapping the source (fork ref / npm) touches ONLY this file —
// @bugsee/replay stays untouched (design D1/D2).
//
// The event/option TYPES still come from the published rrweb/@rrweb/types type surface (they match the
// fork's API); `recordOptions` is augmented locally with the fork-only `maskAttributeFn`. Type-only
// imports are erased — no bundle cost.
import type { recordOptions as BaseRecordOptions } from 'rrweb';

// The record function (value) — the Bugsee-hardened fork build.
export { record } from '@bugsee/rrweb-record';

// The core event + handle types.
export type { EventType, eventWithTime, listenerHandler } from '@rrweb/types';

// Fail-closed attribute-value masker (fork-only): redacts attribute values (placeholder/title/aria-label/
// value) that would otherwise leak into a recording.
export type MaskAttributeFn = (key: string, value: string, element: HTMLElement) => string;

// The record options type — carries the masking/blocking surface (`maskAllInputs`/`blockClass`/
// `maskInputOptions`/`checkoutEveryNms`/`emit`/…) that @bugsee/replay's masking config (RP1) maps onto,
// augmented with the Bugsee fork's privacy options:
//   • `maskAttributeFn` — redact attribute values;
//   • `maskAllText` + `unmaskTextClass`/`unmaskTextSelector` — mask-everything with per-element opt-out;
//   • `unblockSelector` — un-block specific media; `unmaskInputSelector` — un-mask specific inputs.
export type recordOptions<T = unknown> = BaseRecordOptions<T> & {
  maskAttributeFn?: MaskAttributeFn;
  maskAllText?: boolean;
  unmaskTextClass?: string | RegExp | null;
  unmaskTextSelector?: string | null;
  unblockSelector?: string | null;
  unmaskInputSelector?: string | null;
};
