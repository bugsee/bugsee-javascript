// The SDK lifecycle state (mobile parity: iOS `BugseeStatus`, Android `BugseeStatus`, the Java enum in
// `com.bugsee.library.contracts.lifecycle`, whose constants are declared in this order). The numeric values
// follow that order, so a value read from a bridge means the same thing everywhere.
// `Launching` is observable only while an ASYNC launch (the browser's lazy-loaded composition) is in
// flight; `Stopping` while `stop()` is draining pending uploads.
export const BugseeStatus = {
  Stopped: 0,
  Launching: 1,
  Launched: 2,
  Stopping: 3,
} as const;

export type BugseeStatus = (typeof BugseeStatus)[keyof typeof BugseeStatus];
