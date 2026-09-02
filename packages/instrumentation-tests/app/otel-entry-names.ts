// The span names the OTel entry creates and the OTel e2e asserts on.
//
// Their own module because `otel-entry.ts` runs on import (it boots the SDK and exits the process), so
// the test runner cannot import from it just to read two strings.

/** The root span the entry starts. */
export const OTEL_ROOT_SPAN = 'e2e checkout';
/** Its child. */
export const OTEL_CHILD_SPAN = 'e2e db.query';
