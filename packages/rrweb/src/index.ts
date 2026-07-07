// @bugsee/rrweb — the single, SWAPPABLE rrweb import point for @bugsee/replay (+ @bugsee/replay-canvas).
//
// Today it re-exports the RECORD path from npm `@rrweb/record` (rrweb-io/rrweb, MIT). When the Bugsee rrweb
// FORK (github.com/<bugsee-org>/rrweb — upstream rrweb + our curated Sentry-fork ports, see
// docs/design/replay.md §4) is published/installable, only the imports in THIS file change — @bugsee/replay
// stays untouched (design D1/D2).
//
// Record-only: `@rrweb/record` is the record-path entry (no player) so bundlers tree-shake the replay/player
// code out. Type-only imports (`recordOptions`, event types) are erased — no bundle cost.

// The record function (value).
export { record } from '@rrweb/record';

// The core event + handle types.
export type { EventType, eventWithTime, listenerHandler } from '@rrweb/types';

// The record options type — carries the masking/blocking surface (`maskAllText`/`maskAllInputs`/`blockClass`/
// `maskInputOptions`/`checkoutEveryNms`/`emit`/…) that @bugsee/replay's masking config (RP1) maps onto.
export type { recordOptions } from 'rrweb';
