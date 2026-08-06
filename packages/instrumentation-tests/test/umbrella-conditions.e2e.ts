// WAVE 4.1 — every `exports` condition the umbrella declares, resolved by a REAL resolver.
//
// The umbrella had three conditions (browser / node / default). Every runtime that set none of them fell
// through to `default`, i.e. the BROWSER entry — IndexedDB, DOM, a page lifecycle — none of which exists on
// workerd, Vercel Edge, or in a Web Worker. Bun and Deno were worse than that: they set `node`, so they
// resolved the Node SDK and silently lost their own composition (measured through the real runtimes in
// Wave 3b.1: Bun 1.3.14 reporting as `node` 24.3.0, and `Bun.serve` left uninstrumented entirely).
//
// The lesson from that is why this file exists: an `exports` entry is only as good as the resolution that
// selects it, and nothing had ever exercised the selection. esbuild's `conditions` is a real resolver
// implementing the same algorithm Node and the bundlers do — so each case here asks the question a
// customer's build asks, rather than re-implementing the walk and testing my own re-implementation.
//
// ORDER is the substance of the contract: every one of these runtimes sets SEVERAL conditions, and
// resolution takes the FIRST match in the map. `workerd` sets `worker` and `browser` too; `edge-light` the
// same; Bun sets `node`; Deno sets `node`. Get the order wrong and the map still "has" the condition while
// resolving to something else entirely — which is precisely the failure this suite exists to catch.
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

/**
 * Which `packages/bugsee/src/index*.ts` esbuild actually resolved under `conditions`.
 *
 * Read from the METAFILE — esbuild's own record of the graph it built — rather than by grepping the output
 * for a marker string. That was my first approach and it was wrong twice over: esbuild normalises string
 * quotes, so `platformType: 'bun'` never appears verbatim; and `createIdbChunkCaptureStore` is not
 * browser-exclusive, because @bugsee/webworker persists to IndexedDB too. The metafile answers the actual
 * question — which entry was selected — instead of a proxy for it.
 */
async function entryResolvedUnder(conditions: string[]): Promise<string> {
  const result = await build({
    stdin: {
      contents: `import * as bugsee from '@bugsee/bugsee'; globalThis.__x = bugsee;`,
      resolveDir: new URL('..', import.meta.url).pathname,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    conditions,
    // Everything platform-specific stays external: we are testing WHICH entry resolves, not whether its
    // transitive dependencies bundle for that target (which the per-package edge suites already cover).
    // The bare builtins are listed because `platform: 'neutral'` resolves nothing by default and a
    // dependency of a dependency (fflate) imports bare `module`.
    external: [
      'node:*',
      'cloudflare:*',
      'module',
      'fs',
      'path',
      'os',
      'crypto',
      'http',
      'https',
      'util',
      'stream',
      'zlib',
      'events',
      'worker_threads',
      'inspector',
      'async_hooks',
      'perf_hooks',
      'net',
      'tls',
      'url',
      'buffer',
      'child_process',
    ],
    logLevel: 'silent',
  });
  // esbuild's metafile keys are paths relative to the CWD (e.g. `../bugsee/src/index.node.ts`), so the
  // pattern anchors on the package directory rather than on a `packages/` prefix that is not there.
  const entries = Object.keys(result.metafile.inputs).filter((f) =>
    /(^|\/)bugsee\/src\/index[^/]*\.ts$/.test(f),
  );
  // Exactly one umbrella entry must be in the graph. More than one means a condition is pulling in a
  // sibling entry, which would defeat the whole point of splitting them.
  expect(entries, `expected ONE umbrella entry under [${conditions.join(', ')}]`).toHaveLength(1);
  return (entries[0] as string).replace(/^.*bugsee\/src\//, '');
}

describe('the umbrella resolves the right entry per runtime (Wave 4.1)', () => {
  // Every runtime here sets SEVERAL conditions; the expected entry is the one whose condition is listed
  // FIRST in the exports map. That ordering IS the contract.
  const CASES: Array<{ runtime: string; conditions: string[]; entry: string }> = [
    {
      runtime: 'workerd (Cloudflare)',
      conditions: ['workerd', 'worker', 'browser'],
      entry: 'index.workerd.ts',
    },
    {
      runtime: 'Vercel Edge',
      conditions: ['edge-light', 'worker', 'browser'],
      entry: 'index.edge-light.ts',
    },
    { runtime: 'a Web Worker build', conditions: ['worker', 'browser'], entry: 'index.worker.ts' },
    { runtime: 'Bun', conditions: ['bun', 'node'], entry: 'index.bun.ts' },
    { runtime: 'Deno', conditions: ['deno', 'node'], entry: 'index.deno.ts' },
    // The two canaries: without them, "the specific runtimes win" is satisfied by a map that never
    // resolves the general ones at all.
    { runtime: 'plain node', conditions: ['node'], entry: 'index.node.ts' },
    { runtime: 'plain browser', conditions: ['browser'], entry: 'index.ts' },
  ];

  for (const { runtime, conditions, entry } of CASES) {
    it(`${runtime} → ${entry}`, async () => {
      expect(await entryResolvedUnder(conditions)).toBe(entry);
    });
  }

  it('every declared condition resolves to a DISTINCT entry', () => {
    // A duplicate would mean a condition silently aliases another runtime's composition — the exact shape
    // of the original defect, where bun and deno both resolved the node entry.
    const entries = CASES.map((c) => c.entry);
    expect(new Set(entries).size).toBe(entries.length);
  });
});
