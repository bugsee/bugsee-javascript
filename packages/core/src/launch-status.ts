// The SDK lifecycle state (mobile parity: iOS `BugseeStatus`, Android `Bugsee.Status`). Numeric values
// match the mobile enums so a value read on the wire or from a bridge means the same thing everywhere.
// `Launching` is observable only while an ASYNC launch (the browser's lazy-loaded composition) is in
// flight; `Stopping` while `stop()` is draining pending uploads.
export const BugseeStatus = {
  Stopped: 0,
  Launching: 1,
  Launched: 2,
  Stopping: 3,
} as const;

export type BugseeStatus = (typeof BugseeStatus)[keyof typeof BugseeStatus];
