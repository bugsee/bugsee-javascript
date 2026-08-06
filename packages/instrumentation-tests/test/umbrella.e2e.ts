// WAVE 3b.1 — the SDK installed the way customers install it.
//
// Every other e2e entry imports its runtime's platform package directly (`@bugsee/node`, `@bugsee/bun`,
// `@bugsee/deno`). No customer does that. The documented single-install path is `@bugsee/bugsee`, and which
// implementation they get is decided by the umbrella's `exports` conditions ON THEIR RUNTIME. Nothing in
// the suite exercised that decision — which is precisely why a runtime resolving to the wrong
// implementation stayed invisible to all 109 e2e tests.
//
// The entry file is identical for all three runtimes. The only variable is which runtime loads it, and
// therefore which condition the umbrella resolves through. That is the entire subject of this file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ParsedBundle, parseBundles } from './bundle';
import { type MockCollector, startMockCollector } from './collector';
import {
  type RuntimeTarget,
  runScenarioProcess,
  runtimeOwnVersion,
  runtimeTargets,
} from './runtimes';

interface ReportEnvelope {
  type: string;
  summary: string;
  /** The per-request context id — present only when an interceptor opened a context for the request. */
  context_id?: string;
  environment: {
    platform: { type: string; version: string };
    sdk: { type: string; version: string };
  };
}
type Bundle = ParsedBundle & { request: ReportEnvelope };

const targets = runtimeTargets();
const available = targets.filter((t) => t.bin !== undefined);

// A runtime whose binary is absent is skipped LOUDLY — a silently-empty matrix is how "the e2e suite is
// green" comes to mean "the e2e suite ran nothing".
for (const t of targets) {
  if (t.bin === undefined) {
    console.warn(`[e2e] runtime ${t.name} unavailable — umbrella install NOT verified for it`);
  }
}

describe('the umbrella install path (Wave 3b.1)', () => {
  let collector: MockCollector;

  beforeAll(async () => {
    collector = await startMockCollector();
  });
  afterAll(async () => {
    await collector.close();
  });

  const runUmbrella = async (target: RuntimeTarget): Promise<Bundle[]> => {
    collector.uploads.length = 0; // one shared collector; each run asserts only on its own uploads
    const result = await runScenarioProcess(
      target,
      collector.url,
      'main',
      {},
      undefined,
      'umbrella',
    );
    // Naming the exit code and stderr here is the difference between "the umbrella is broken on bun" and
    // an unexplained empty-bundle assertion failure three lines down.
    expect(
      result.exitCode,
      `${target.name} umbrella entry exited ${result.exitCode}\n${result.stderr}`,
    ).toBe(0);
    return parseBundles(collector) as Bundle[];
  };

  for (const target of available) {
    describe(target.name, () => {
      it('launches and uploads a real bundle through `@bugsee/bugsee`', async () => {
        const bundles = await runUmbrella(target);
        expect(bundles.length).toBeGreaterThan(0);
      });

      it('resolves the implementation for THIS runtime, not another one', async () => {
        // The assertion the whole file exists for. `platform.type` is stamped by the platform package's own
        // identity probe, so it names which implementation the umbrella actually resolved — a customer on
        // Bun whose reports say `node` is being told the wrong runtime, with the wrong version alongside it.
        const bundles = await runUmbrella(target);
        expect(bundles[0]?.request.environment.platform.type).toBe(target.name);
      });

      it('reports the runtime’s OWN version', async () => {
        // Asserted against the value the BINARY reports, not merely "different from node's". Bun and Deno
        // each expose a `process.versions.node` for compatibility, so a not-equal check passes by accident
        // whenever that compat version happens to differ from the harness's own node — which is exactly how
        // my first version of this test passed on Bun while the defect was present.
        const bundles = await runUmbrella(target);
        expect(bundles[0]?.request.environment.platform.version).toBe(runtimeOwnVersion(target));
      });

      it('carries the same capture the platform-direct entry produces — the canary', async () => {
        // Without this, every assertion above is satisfied by an umbrella that resolves correctly and then
        // captures nothing.
        const bundles = await runUmbrella(target);
        const names = Object.keys(bundles[0]?.files ?? {});
        expect(names).toContain('request.json');
        expect(names).toContain('logs.json');
      });
    });
  }
});

// WAVE 3b.1/3b.5 — the native server path, through the umbrella.
//
// The identity assertions above prove the umbrella resolves the right PACKAGE. This proves the thing that
// actually costs a customer data when it does not: `Bun.serve({fetch})` and `Deno.serve()` bypass node:http
// entirely, which is why @bugsee/bun and @bugsee/deno ship interceptors for them — and why an umbrella that
// resolved to @bugsee/node left idiomatic Bun and Deno servers completely uninstrumented.
//
// Nothing in the suite exercised those interceptors on any entry, so this is the first coverage they have.
describe('the umbrella instruments the NATIVE server (Wave 3b.1)', () => {
  let collector: MockCollector;

  beforeAll(async () => {
    collector = await startMockCollector();
  });
  afterAll(async () => {
    await collector.close();
  });

  for (const target of available.filter((t) => t.name !== 'node')) {
    it(`${target.name}: a request to ${target.name === 'bun' ? 'Bun.serve' : 'Deno.serve'} is captured`, async () => {
      collector.uploads.length = 0;
      const result = await runScenarioProcess(
        target,
        collector.url,
        'native-server',
        {},
        undefined,
        'umbrella',
      );
      expect(result.exitCode, `${target.name}\n${result.stderr}`).toBe(0);
      const bundles = parseBundles(collector) as Bundle[];
      const err = bundles.find((b) => b.request.summary === 'e2e native server handler failure');
      expect(err, 'no handler error bundle was delivered').toBeDefined();
      const bundle = err as Bundle;

      // NOT "the handler's log is in the bundle" — my first version asserted that, and it passed with the
      // interceptor absent, because `client.log` is captured whether or not the request was instrumented.
      // The interceptor's actual signature is the per-request CONTEXT: a `context_id` on the report, and
      // the SAME id on the log emitted inside the handler. Nothing else produces that.
      const contextId = bundle.request.context_id;
      expect(
        typeof contextId,
        `report has no context_id — ${target.name}'s native serve was not instrumented`,
      ).toBe('string');
      expect((contextId ?? '').length).toBeGreaterThan(0);

      const logsFile = bundle.files['logs.json'];
      expect(logsFile, 'no logs.json in the bundle').toBeDefined();
      const logs = JSON.parse(new TextDecoder().decode(logsFile)) as Array<{
        message?: string;
        context_id?: string;
      }>;
      const own = logs.find((l) => l.context_id === contextId);
      expect(own?.message).toContain('native handling GET /native/42');
    });
  }
});
