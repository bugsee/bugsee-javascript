// @bugsee/nextjs — the `register()` dispatcher for `instrumentation.ts`.
//
// Next calls `register()` once per runtime. We branch on `NEXT_RUNTIME` and `await import` only the
// matching runtime's composition, so no runtime's code is pulled into another's bundle graph (design §3,
// hard-constraint 1). The dynamic imports use the package's OWN SUBPATH SPECIFIERS
// (`@bugsee/nextjs/server` / `@bugsee/nextjs/edge`), NOT relative paths (`./server`): a bare specifier
// stays EXTERNAL to the bundler in BOTH formats, so it emits a real lazy `import()` — whereas a relative
// dynamic import is inlined (with its top-level `require('@bugsee/bugsee/node')` hoisted) into the CJS build,
// leaking node into the portable `.` entry (#172). The TYPE imports below are erased, so `./server` /
// `./edge` there are fine. Options resolve via the package `exports` map (dev src / published dist alike).
import type { NextjsEdgeOptions } from './edge';
import type { NextjsServerOptions } from './server';

/** Options accepted by `register()` — the node or edge composition options (whichever runtime runs). */
export type NextjsRegisterOptions = NextjsServerOptions | NextjsEdgeOptions;

/** Read `NEXT_RUNTIME` portably (on edge, `process` is a Next-provided shim; on browser it is absent). */
function nextRuntime(): string | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.NEXT_RUNTIME;
}

/**
 * Start Bugsee from `instrumentation.ts`'s `register()`. Dispatches by `NEXT_RUNTIME` and `await import`s
 * only the matching runtime's composition: `nodejs` → the node server (`./server`), `edge` → the Vercel
 * Edge composition (`./edge`). The dynamic imports keep each runtime's code out of the others' graphs.
 *
 * ```ts
 * // instrumentation.ts
 * import { register as bugsee } from '@bugsee/nextjs';
 * export function register() { return bugsee(process.env.BUGSEE_TOKEN!, { ... }); }
 * export { onRequestError } from '@bugsee/nextjs';
 * ```
 */
export async function register(
  appToken: string,
  options: NextjsRegisterOptions = {},
): Promise<void> {
  const runtime = nextRuntime();
  if (runtime === 'nodejs') {
    const { registerServer } = await import('@bugsee/nextjs/server');
    registerServer(appToken, options as NextjsServerOptions);
  } else if (runtime === 'edge') {
    const { registerEdge } = await import('@bugsee/nextjs/edge');
    registerEdge(appToken, options as NextjsEdgeOptions);
  }
}
