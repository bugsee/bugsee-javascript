// bugsee — the DENO entry. Deno is NOT supported (dropped 2026-11-06), and this file exists ONLY to fail loudly.
//
// Deno sets BOTH the `deno` and `node` export conditions. With the `deno` condition removed, a Deno app on
// the single-install path would silently resolve `index.node.ts`: runtime reported as `node`, `Deno.serve`
// uninstrumented, a blind event-loop-lag trace, and `captureLocalVariables` free to freeze the process at
// launch (all measured on the old `@bugsee/deno`). Keeping the condition and throwing here turns that silent
// misbehaviour into an immediate, explained error. It must stay listed BEFORE `node` in package.json
// `exports` (see `test/umbrella-conditions.e2e.ts`).
export {};

throw new Error(
  '@bugsee/bugsee: Deno is no longer supported. Use Node.js, Bun or a browser. ' +
    'Pin an earlier @bugsee/bugsee version if you must stay on Deno.',
);
