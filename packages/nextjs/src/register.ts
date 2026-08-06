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
  // The branch is written INLINE against the literal `process.env.NEXT_RUNTIME` on purpose (Wave 3b.5).
  //
  // Next replaces that exact expression with a string constant in EACH compilation, and webpack folds the
  // comparison AT PARSE TIME — which is the only point at which the dead branch's `import()` can be kept
  // out of the module graph. Reading the value through a helper defeats it twice over: the substitution
  // never happens (`globalThis.process?.env?.NEXT_RUNTIME` is not the pattern Next rewrites), and even
  // with the substitution webpack cannot fold a condition across a function call, so the dependency is
  // added before any optimizer runs.
  //
  // The consequence was total, not cosmetic: `next build` FAILED. Reproduced on real Next 15.5, the edge
  // compilation followed
  //   nextjs/register.ts → nextjs/server.ts → bugsee/index.node.ts → node/index.ts → node/cpu-profiler.ts
  // and hit `node:inspector` — one of a dozen `node:*` builtins dragged into a graph that has no
  // `node_modules` resolution at all. Both symptoms are asserted by @bugsee/nextjs-e2e against a real build.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerServer } = await import('@bugsee/nextjs/server');
    registerServer(appToken, options as NextjsServerOptions);
  } else if (process.env.NEXT_RUNTIME === 'edge') {
    const { registerEdge } = await import('@bugsee/nextjs/edge');
    registerEdge(appToken, options as NextjsEdgeOptions);
  }
}
