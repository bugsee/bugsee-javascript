// @bugsee/nextjs — the `register()` dispatcher for `instrumentation.ts`.
//
// Next calls `register()` once per runtime. We branch on `NEXT_RUNTIME` and `await import` only the
// matching runtime's composition, so no runtime's code is pulled into another's bundle graph (design §3,
// hard-constraint 1). The `./server` import is DYNAMIC (not static), so this portable module — and the
// package `.` entry that re-exports it — stays free of any node-only static import.
import type { NextjsServerOptions } from './server';

/** Read `NEXT_RUNTIME` portably (on edge, `process` is a Next-provided shim; on browser it is absent). */
function nextRuntime(): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.NEXT_RUNTIME;
}

/**
 * Start Bugsee from `instrumentation.ts`'s `register()`. Dispatches by `NEXT_RUNTIME`:
 * `nodejs` → the server (Node) composition (`./server`). The `edge` composition is wired in N2.
 *
 * ```ts
 * // instrumentation.ts
 * import { register as bugsee } from '@bugsee/nextjs';
 * export function register() { return bugsee(process.env.BUGSEE_TOKEN!, { ... }); }
 * export { onRequestError } from '@bugsee/nextjs';
 * ```
 */
export async function register(appToken: string, options: NextjsServerOptions = {}): Promise<void> {
  if (nextRuntime() === 'nodejs') {
    const { registerServer } = await import('./server');
    registerServer(appToken, options);
  }
  // The 'edge' runtime composition (registerEdge) is wired in N2.
}
