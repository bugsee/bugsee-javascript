// The documented `instrumentation.ts` wiring, verbatim from @bugsee/nextjs's own docblock.
//
// Next compiles this file for BOTH the `server` and `edge-server` compilations, so it is the exact place
// the runtime split has to hold: whatever the edge compilation can reach, it must BUNDLE, because an edge
// isolate has no node_modules resolution.
import { register as bugsee } from '@bugsee/nextjs';

export function register(): Promise<void> {
  return bugsee('e2e-app-token', { endpoint: 'http://127.0.0.1:9' });
}

export { onRequestError } from '@bugsee/nextjs';
