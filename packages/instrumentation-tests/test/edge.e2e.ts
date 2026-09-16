// Edge-runtime end-to-end harness (X2 + X3).
//
//   X2 — bundle-size guard: bundle each edge SDK package the way wrangler / Vercel would (single minified ESM,
//        node:* external) and assert the gzipped size stays well under a regression budget (and far under the
//        Workers 3 MB free / 10 MB paid compressed limits), and that the bundle has NO static node:* import (a
//        leak that would break the edge bundle).
//   X3 — real-edge VM smoke: evaluate the bundled edge SDK in @edge-runtime/vm — an actual WinterCG isolate (V8,
//        fetch/Request/Response/crypto.subtle, NO node:*) — fire an incident from withBugseeFetch (Vercel Edge),
//        withBugsee (Cloudflare), and an instrumented Durable Object, and assert the mock collector received the
//        uploaded bundle. This is the proof the in-process unit tests (node + injected fakes) cannot reach: the
//        assembled SDK actually runs node-free in a real edge isolate and delivers an incident-driven bundle.
import { fileURLToPath } from 'node:url';
import { EdgeVM } from '@edge-runtime/vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoContractViolations } from './bundle';
import { type MockCollector, startMockCollector } from './collector';
import { bundleEdgeEntry, bundleEdgePackage } from './edge-bundle';

const KB = 1024;
// Current real size is ~22 KB gzip; 150 KB is generous headroom (catches a ~7x regression, e.g. accidentally
// bundling a heavy dependency) while staying orders of magnitude under the Workers 3 MB free limit.
const GZIP_BUDGET = 150 * KB;
const WORKERS_FREE_LIMIT = 3 * KB * KB;

describe('X2 — edge bundle-size guard', () => {
  // The node:* builtins each package is ALLOWED to import statically.
  //
  // @bugsee/vercel-edge: none. It must run on any WinterCG isolate.
  //
  // @bugsee/cloudflare: exactly `node:async_hooks`, and nothing else. globalThis.AsyncLocalStorage does not
  // exist on workerd under ANY compatibility flag, so this is the only route to per-request context there —
  // which is why `nodejs_compat` is a documented REQUIREMENT of the package (Wave 0.1 S0,
  // docs/design/cloudflare-tenant-isolation.md §7). The allowlist is deliberately EXACT rather than relaxed
  // to "any node import": a second builtin creeping in would still fail here.
  const ALLOWED_NODE_IMPORTS: Record<string, string[]> = {
    '@bugsee/vercel-edge': [],
    '@bugsee/cloudflare': ['node:async_hooks'],
  };

  for (const pkg of ['@bugsee/vercel-edge', '@bugsee/cloudflare']) {
    it(`${pkg} imports only its allowed node builtins and stays well under the size budget`, async () => {
      const bundle = await bundleEdgePackage(pkg);
      expect(bundle.nodeImports).toEqual(ALLOWED_NODE_IMPORTS[pkg]);
      // …and of ANY kind, dynamic included. @bugsee/util's sha256 once carried a guarded dynamic
      // `import('node:crypto')` that this allowed through — and that broke every esbuild edge/browser build.
      expect(bundle.externalImports.filter((path) => path.startsWith('node:'))).toEqual(
        ALLOWED_NODE_IMPORTS[pkg],
      );
      console.info(
        `[bundle] ${pkg}: ${(bundle.bytes / KB).toFixed(1)} KB raw / ${(bundle.gzipBytes / KB).toFixed(1)} KB gzip`,
      );
      expect(bundle.gzipBytes).toBeLessThan(GZIP_BUDGET);
      expect(bundle.gzipBytes).toBeLessThan(WORKERS_FREE_LIMIT);
    });
  }
});

describe('X3 — real-edge VM smoke (@edge-runtime/vm, a WinterCG isolate)', () => {
  let collector: MockCollector;
  let bundleCode: string;

  beforeAll(async () => {
    collector = await startMockCollector();
    const scenario = fileURLToPath(new URL('../app/edge-scenario.ts', import.meta.url));
    bundleCode = (await bundleEdgeEntry(scenario, 'iife')).code;
  });
  afterAll(async () => {
    await collector.close();
  });

  // Evaluate the bundle in a FRESH edge isolate, then invoke one smoke runner with the collector URL.
  async function runSmoke(runner: string): Promise<void> {
    const vm = new EdgeVM();
    vm.evaluate(bundleCode); // defines globalThis.__run* (proves the bundle LOADS node-free in a real isolate)
    await vm.evaluate(`globalThis.${runner}(${JSON.stringify(collector.url)})`);
  }

  const incidentIssue = (message: string): Record<string, unknown> | undefined =>
    collector.issues.find((issue) => JSON.stringify(issue).includes(message));
  const sessionWithPlatform = (type: string): Record<string, unknown> | undefined =>
    collector.sessions.find(
      (s) =>
        (s.environment as { platform?: { type?: string } } | undefined)?.platform?.type === type,
    );

  it('vercel-edge withBugseeFetch uploads an incident from a real edge isolate (platform edge-light)', async () => {
    const before = collector.uploads.length;
    await runSmoke('__runVercelEdge');
    expect(incidentIssue('vercel-edge vm incident')).toBeDefined(); // the thrown error reached the collector
    expect(sessionWithPlatform('edge-light')).toBeDefined(); // launched with the Vercel Edge identity
    expect(collector.uploads.length).toBeGreaterThan(before); // a real bundle (zip) was PUT
  });

  it('cloudflare withBugsee uploads an incident from a real edge isolate (platform workers)', async () => {
    const before = collector.uploads.length;
    await runSmoke('__runCloudflare');
    expect(incidentIssue('cloudflare vm incident')).toBeDefined();
    expect(sessionWithPlatform('workers')).toBeDefined(); // launched with the Cloudflare Workers identity
    expect(collector.uploads.length).toBeGreaterThan(before);
  });

  it('cloudflare Durable Object uploads an incident (awaited in-request — waitUntil is inert on DOs)', async () => {
    const before = collector.uploads.length;
    await runSmoke('__runDurableObject');
    expect(incidentIssue('durable-object vm incident')).toBeDefined();
    expect(collector.uploads.length).toBeGreaterThan(before);
  });

  // Runs last, so it covers every upload the three smokes above produced. The collector schema-validates
  // each session/issue/manifest/request.json and RECORDS failures; that recording is inert unless a suite
  // reads it, and until now only the node/bun/deno suite did. A wire break on the EDGE assembler — a
  // different assembler from the node one — would have been recorded and silently discarded
  // (docs/review/session-integration-review.md SEV2 #1).
  it('none of the edge upload paths violate the upload contract', () => {
    assertNoContractViolations(collector);
  });
});
