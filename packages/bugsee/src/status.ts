// The lifecycle surface shared by every umbrella entry: the status enum and the process-level getStatus().
// `getStatus()` reads the process state, so it answers Launching / Stopping too — moments when no client
// object is reachable yet (or any more). Re-exported from core so the umbrella adds no logic of its own.
export { BugseeStatus, getProcessStatus as getStatus } from '@bugsee/core';
