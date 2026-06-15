// Cross-runtime end-to-end instrumentation harness.
//
// For each available runtime (node via tsx, bun, deno) this boots the REAL SDK in a REAL separate
// process — no fakes, real timers, the real V8 CPU profiler, the real worker-thread hang watchdog, a
// real outgoing fetch — pointed at a local mock collector, and asserts the actual uploaded bundle:
//   • one session carrying the runtime's platform identity,
//   • an error report bundle (logException) with logs.json, network.json (the captured /echo), and a
//     real profile.json (V8 CPU profile),
//   • an AppHang report bundle fired by the real event-loop watchdog,
//   • a crash bundle (uncaughtException → flush → exit 1) in the crash scenario.
//
// This is the layer the in-process vitest unit tests (which run under node with injected fakes) cannot
// reach: it proves the assembled SDK actually runs and produces the right wire output on each runtime.
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockCollector, startMockCollector } from './collector';
import { type RuntimeTarget, runScenarioProcess, runtimeTargets } from './runtimes';

interface ReportEnvelope {
  type: string;
  summary: string;
  source: { mechanism: string };
  environment: { platform: { type: string; version: string } };
}
interface ParsedBundle {
  issueId: string;
  files: Record<string, Uint8Array>;
  request: ReportEnvelope;
}
interface LogEntry {
  message: string;
  level: string;
}
interface NetworkEntry {
  url?: string;
}

const parseJson = <T>(bytes: Uint8Array | undefined): T =>
  JSON.parse(strFromU8(bytes as Uint8Array)) as T;

const parseBundles = (collector: MockCollector): ParsedBundle[] =>
  collector.uploads.map((u) => {
    const files = unzipSync(u.body) as Record<string, Uint8Array>;
    return { issueId: u.issueId, files, request: parseJson<ReportEnvelope>(files['request.json']) };
  });

const targets = runtimeTargets();
for (const t of targets) {
  if (t.bin === undefined) {
    // process.stderr (not console.warn, which vitest intercepts) so a skipped runtime is actually visible.
    process.stderr.write(
      `[e2e] runtime "${t.name}" unavailable — skipping its instrumentation suite\n`,
    );
  }
}

// node is the guaranteed target (tsx is a devDep); bun/deno run only where installed.
describe.each(
  targets.filter((t): t is RuntimeTarget & { bin: string } => t.bin !== undefined),
)('instrumentation e2e — $name', (target) => {
  describe('main scenario: logs · network · error report · CPU profile · ANR', () => {
    let collector: MockCollector;
    let exitCode: number | null;
    let stderr: string;
    let bundles: ParsedBundle[];

    beforeAll(async () => {
      collector = await startMockCollector();
      const result = await runScenarioProcess(target, collector.url, 'main');
      exitCode = result.exitCode;
      stderr = result.stderr;
      bundles = parseBundles(collector);
    }, 60_000);

    afterAll(async () => {
      await collector.close();
    });

    it('the app process exits cleanly', () => {
      expect(exitCode, stderr).toBe(0);
    });

    it('opens exactly one session carrying the runtime platform identity', () => {
      expect(collector.sessions).toHaveLength(1);
      const env = collector.sessions[0]?.environment as {
        platform: { type: string; version: string };
      };
      expect(env.platform.type).toBe(target.name);
      expect(typeof env.platform.version).toBe('string');
      expect(env.platform.version.length).toBeGreaterThan(0);
      if (target.name === 'deno') {
        // Proves the e2e reads the REAL Deno version (Deno.version.deno → a small major) and NOT the
        // node-compat process.versions.node (major ≥ 18) — the milestone's headline gotcha, verified
        // end-to-end on the real Deno runtime (the unit tests run under node and cannot reach this).
        const major = Number(env.platform.version.split('.')[0]);
        expect(major).toBeGreaterThanOrEqual(1);
        expect(major).toBeLessThan(18);
      }
    });

    it('captured the real outgoing /echo request', () => {
      // >= 1 (not === 1): a runtime's fetch could in principle make more than one connect attempt; the
      // claim is "the outgoing request was captured", and a separate assertion checks it lands in network.json.
      expect(collector.echoHits).toBeGreaterThanOrEqual(1);
    });

    it('delivered an error report bundle with logs, the captured network request, and a CPU profile', () => {
      const err = bundles.find((b) => b.request.source.mechanism === 'programmatic');
      expect(err, 'no programmatic error bundle was delivered').toBeDefined();
      const bundle = err as ParsedBundle;

      expect(bundle.request.type).toBe('error');
      expect(bundle.request.summary).toBe('e2e instrumented failure');
      expect(bundle.request.environment.platform.type).toBe(target.name);

      // Assert each capture file is present before parsing, so a missing file fails with a clear message
      // rather than an opaque strFromU8 type error.
      expect(bundle.files['logs.json'], 'no logs.json in the bundle').toBeDefined();
      expect(bundle.files['network.json'], 'no network.json in the bundle').toBeDefined();

      const logs = parseJson<LogEntry[]>(bundle.files['logs.json']);
      expect(logs.some((l) => l.message.includes('hello from the instrumented app'))).toBe(true);
      expect(
        logs.some((l) => l.level === 'error' && l.message.includes('something noteworthy')),
      ).toBe(true);

      const net = parseJson<NetworkEntry[]>(bundle.files['network.json']);
      expect(net.some((n) => typeof n.url === 'string' && n.url.includes('/echo'))).toBe(true);

      // A real V8 CPU profile is attached (profiling: true).
      expect(bundle.files['profile.json'], 'no profile.json attached').toBeDefined();
      const profile = parseJson<{ nodes: unknown[]; startTime: number }>(
        bundle.files['profile.json'],
      );
      expect(Array.isArray(profile.nodes)).toBe(true);
      expect(profile.nodes.length).toBeGreaterThan(0);
      expect(typeof profile.startTime).toBe('number');
    });

    it('delivered an AppHang report fired by the real event-loop watchdog', () => {
      const hang = bundles.find((b) => b.request.source.mechanism === 'hang');
      expect(hang, 'no AppHang bundle was delivered').toBeDefined();
      const bundle = hang as ParsedBundle;
      expect(bundle.request.summary).toBe('Main thread hang detected');
      expect(bundle.request.environment.platform.type).toBe(target.name);
    });
  });

  describe('crash scenario: uncaughtException → crash bundle → exit 1', () => {
    let collector: MockCollector;
    let exitCode: number | null;
    let stderr: string;
    let crash: ReportEnvelope | undefined;

    beforeAll(async () => {
      collector = await startMockCollector();
      const result = await runScenarioProcess(target, collector.url, 'crash');
      exitCode = result.exitCode;
      stderr = result.stderr;
      const first = collector.uploads[0];
      crash = first
        ? parseJson<ReportEnvelope>(
            (unzipSync(first.body) as Record<string, Uint8Array>)['request.json'],
          )
        : undefined;
    }, 30_000);

    afterAll(async () => {
      await collector.close();
    });

    it('the app exits non-zero (the SDK flushes then process.exit(1))', () => {
      expect(exitCode, stderr).toBe(1);
    });

    it('delivered a crash bundle carrying the runtime identity', () => {
      expect(crash, 'no crash bundle was delivered').toBeDefined();
      const report = crash as ReportEnvelope;
      expect(report.type).toBe('crash');
      expect(report.source.mechanism).toBe('uncaught');
      expect(report.summary).toBe('e2e uncaught crash');
      expect(report.environment.platform.type).toBe(target.name);
    });
  });
});
