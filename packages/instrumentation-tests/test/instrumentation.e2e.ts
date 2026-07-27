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
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertBundleIntegrity,
  assertNoContractViolations,
  assertNoSecrets,
  type ParsedBundle as SharedParsedBundle,
  parseBundles as sharedParseBundles,
} from './bundle';
import { type MockCollector, startMockCollector } from './collector';
import { type RuntimeTarget, runScenarioProcess, runtimeTargets } from './runtimes';

interface ReportEnvelope {
  type: string;
  summary: string;
  source: { mechanism: string };
  environment: { platform: { type: string; version: string } };
  /** The per-request context id, present when a request context was active at report time. */
  context_id?: string;
  /** The W3C trace id the report fired in — the cross-project join key (T8). */
  trace_id?: string;
}
/** The shared ParsedBundle, narrowed to this suite's report envelope. */
type ParsedBundle = SharedParsedBundle & { request: ReportEnvelope };

interface LogEntry {
  message: string;
  level: string;
  /** The context id the entry was stamped with (correlation-by-tagging). */
  context_id?: string;
}
interface NetworkEntry {
  url?: string;
}

const parseJson = <T>(bytes: Uint8Array | undefined): T =>
  JSON.parse(strFromU8(bytes as Uint8Array)) as T;

/** Shared parser (test/bundle.ts), typed to this suite's envelope. */
const parseBundles = (collector: MockCollector): ParsedBundle[] =>
  sharedParseBundles(collector) as ParsedBundle[];

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

    // Every uploaded bundle must be internally consistent: manifest ↔ zip agreement, no declared-but-
    // missing file, no directory-shaped stand-in, no undeclared payload, no empty declared file. Added
    // in Wave V0 — the review found a recovered crash bundle that declared `profile.json` while the zip
    // held only `profile.json/`, and no harness assertion could see it
    // (docs/review/core-D-bundle-upload-recovery.md).
    it('every uploaded bundle is internally consistent (manifest ↔ zip)', () => {
      expect(bundles.length).toBeGreaterThan(0);
      for (const bundle of bundles) assertBundleIntegrity(bundle);
    });

    // The app token is written to the `apptoken` file by design; it must appear NOWHERE else — not in
    // logs, not in a captured network entry, not in request.json. assertNoSecrets exempts `apptoken`
    // and scans every other entry (binary included), which is the shape of check that would have caught
    // the confirmed URL-credential leaks (docs/review/capture.md, docs/review/node-B-http-server.md).
    it('never leaks the app token outside the apptoken file', () => {
      expect(bundles.length).toBeGreaterThan(0);
      for (const bundle of bundles) assertNoSecrets(bundle, ['e2e-app-token']);
    });

    // Every session envelope, issue envelope and bundle manifest/request.json is validated by the mock
    // collector against packages/protocol/upload-contract.schema.json as it arrives. Without this
    // assertion those violations would be recorded and ignored — the review found the collector
    // "validates nothing — it is a byte sink, not a contract" (docs/review/e2e-harnesses.md SEV1 #7).
    it('emits nothing that violates the upload contract', () => {
      assertNoContractViolations(collector);
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

    it('the AppHang bundle carries a CPU profile whose samples include the blocking frame', () => {
      // THE proof of our native-free "where is the main thread stuck" mechanism: V8 keeps sampling during
      // the stall, so the spinning function (`e2eHangSpin`) appears in the profile attached to the hang
      // report. This is what justifies NOT adopting a native stack-capture addon (see node-diagnostics.md).
      const hang = bundles.find((b) => b.request.source.mechanism === 'hang');
      expect(hang, 'no AppHang bundle was delivered').toBeDefined();
      const bundle = hang as ParsedBundle;

      expect(
        bundle.files['profile.json'],
        'the AppHang bundle carries no profile.json',
      ).toBeDefined();
      const profile = parseJson<{ nodes: Array<{ callFrame: { functionName: string } }> }>(
        bundle.files['profile.json'],
      );
      const blocking = profile.nodes.some((n) => n.callFrame.functionName === 'e2eHangSpin');
      expect(blocking, 'the blocking frame e2eHangSpin is not in the AppHang profile').toBe(true);
    });
  });

  describe('server scenario: node:http incoming request → per-request context', () => {
    let collector: MockCollector;
    let exitCode: number | null;
    let stderr: string;
    let bundles: ParsedBundle[];

    beforeAll(async () => {
      collector = await startMockCollector();
      const result = await runScenarioProcess(target, collector.url, 'server');
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

    it('the handler-raised report carries the incoming request context, correlated to the handler log', () => {
      const err = bundles.find((b) => b.request.summary === 'e2e server handler failure');
      expect(err, 'no handler error bundle was delivered').toBeDefined();
      const bundle = err as ParsedBundle;

      // The default-on node:http emit patch opened a per-request context → the report carries its id.
      const contextId = bundle.request.context_id;
      expect(
        typeof contextId,
        'report has no context_id (the emit patch did not open a context)',
      ).toBe('string');
      expect((contextId ?? '').length).toBeGreaterThan(0);

      // THE proof: the log emitted INSIDE the handler carries the SAME context_id — it ran within the
      // request's run-scoped context and the report correlated to it (no cross-request bleed).
      expect(bundle.files['logs.json'], 'no logs.json in the bundle').toBeDefined();
      const logs = parseJson<LogEntry[]>(bundle.files['logs.json']);
      const own = logs.find((l) => l.context_id === contextId);
      expect(own?.message).toContain('handling GET /orders/42');
    });
  });

  describe('multi-instance: a dead sibling process incident recovered across a shared dataDir', () => {
    let collector: MockCollector;
    let dataDir: string;
    let seed: { exitCode: number | null; stderr: string };
    let recover: { exitCode: number | null; stderr: string };
    let seedPendingBundles: number; // bundles the seed actually PERSISTED under its subtree's pending/
    let uploadsAfterSeed: number; // what the collector received during the seed phase (must be 0)

    beforeAll(async () => {
      collector = await startMockCollector();
      dataDir = mkdtempSync(join(tmpdir(), 'bugsee-mi-'));
      // Phase 1: a doomed process persists an incident to the shared dataDir then dies undelivered.
      seed = await runScenarioProcess(target, collector.url, 'multi-instance', {
        BUGSEE_E2E_DATADIR: dataDir,
        BUGSEE_E2E_PHASE: 'seed',
      });
      // The seed must have left exactly one per-instance subtree with a PERSISTED bundle in its pending/
      // queue (not just an empty dir) — that durable blob is what recovery picks up.
      const subs = readdirSync(dataDir).filter((n) => /^\d+-\d+-/.test(n));
      seedPendingBundles =
        subs.length === 1 ? readdirSync(join(dataDir, subs[0] as string, 'pending')).length : 0;
      uploadsAfterSeed = collector.uploads.length; // the seed's unreachable endpoint delivered nothing
      // Phase 2: a fresh process on the SAME dataDir recovers the dead sibling's incident.
      recover = await runScenarioProcess(target, collector.url, 'multi-instance', {
        BUGSEE_E2E_DATADIR: dataDir,
        BUGSEE_E2E_PHASE: 'recover',
      });
    }, 120_000);

    afterAll(async () => {
      await collector.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('the seed process dies non-zero; the recover process exits cleanly', () => {
      expect(seed.exitCode, seed.stderr).toBe(1);
      expect(recover.exitCode, recover.stderr).toBe(0);
    });

    it('the seed PERSISTED an undelivered bundle and delivered NOTHING (proves the incident must be recovered)', () => {
      expect(
        seedPendingBundles,
        `seed left no persisted bundle (${seed.stderr})`,
      ).toBeGreaterThanOrEqual(1);
      // The recover process never logs this incident itself — so if the collector got nothing in phase 1,
      // any 'e2e multi-instance incident' it later holds can ONLY have come from cross-process recovery.
      expect(uploadsAfterSeed).toBe(0);
    });

    it('a FRESH process delivers the dead sibling’s persisted incident (cross-process recovery)', () => {
      const bundles = parseBundles(collector);
      const incident = bundles.find((b) => b.request.summary === 'e2e multi-instance incident');
      expect(
        incident,
        'the dead sibling process incident was not recovered + delivered by the fresh process',
      ).toBeDefined();
      expect(incident?.request.source.mechanism).toBe('programmatic');
    });
  });

  describe('disk-recovery: a crash that beat its bundle is rebuilt from the durable capture chunks', () => {
    let collector: MockCollector;
    let dataDir: string;
    let seed: { exitCode: number | null; stderr: string };
    let recover: { exitCode: number | null; stderr: string };
    let uploadsAfterSeed: number;

    beforeAll(async () => {
      collector = await startMockCollector();
      dataDir = mkdtempSync(join(tmpdir(), 'bugsee-dr-'));
      // Phase 1: capture a breadcrumb to disk, fire an incident (marker written sync), die before assembly.
      seed = await runScenarioProcess(target, collector.url, 'disk-recovery', {
        BUGSEE_E2E_DATADIR: dataDir,
        BUGSEE_E2E_PHASE: 'seed',
      });
      uploadsAfterSeed = collector.uploads.length; // unreachable endpoint → nothing delivered live
      // Phase 2: a fresh process on the SAME dataDir rebuilds the incident from the marker + capture chunks.
      recover = await runScenarioProcess(target, collector.url, 'disk-recovery', {
        BUGSEE_E2E_DATADIR: dataDir,
        BUGSEE_E2E_PHASE: 'recover',
      });
    }, 60_000);

    afterAll(async () => {
      await collector.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('the seed exits before assembling/delivering anything; the recover process exits cleanly', () => {
      expect(seed.exitCode, seed.stderr).toBe(0);
      expect(recover.exitCode, recover.stderr).toBe(0);
      expect(uploadsAfterSeed).toBe(0); // proves any delivered incident came ONLY from recovery
    });

    it('rebuilds the incident bundle from the marker + disk chunks, carrying the PRE-CRASH breadcrumb', () => {
      const bundles = parseBundles(collector);
      const incident = bundles.find((b) => b.request.summary === 'e2e disk-recovery incident');
      expect(
        incident,
        `the marker-only incident was not recovered (${recover.stderr})`,
      ).toBeDefined();
      // The headline proof: capture written to disk BEFORE the crash survived and is in the recovered bundle.
      const logs = parseJson<LogEntry[]>((incident as ParsedBundle).files['logs.json']);
      expect(logs.some((l) => l.message.includes('e2e disk-recovery breadcrumb 7f3a'))).toBe(true);
    });
  });

  describe('worker writer: off-thread captureWriter:"worker" produces correct bundles on the real runtime', () => {
    let collector: MockCollector;
    let dataDir: string;
    let result: { exitCode: number | null; stderr: string };
    let bundles: ParsedBundle[];

    beforeAll(async () => {
      collector = await startMockCollector();
      dataDir = mkdtempSync(join(tmpdir(), 'bugsee-ww-'));
      result = await runScenarioProcess(target, collector.url, 'worker', {
        BUGSEE_E2E_DATADIR: dataDir,
      });
      bundles = parseBundles(collector);
    }, 60_000);

    afterAll(async () => {
      await collector.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('the app process exits cleanly', () => {
      expect(result.exitCode, result.stderr).toBe(0);
    });

    it('the off-thread-written capture round-trips into the delivered bundle (breadcrumb + burst + network)', () => {
      const err = bundles.find((b) => b.request.summary === 'e2e worker-writer failure');
      expect(err, `no worker-writer error bundle delivered (${result.stderr})`).toBeDefined();
      const bundle = err as ParsedBundle;
      expect(bundle.request.source.mechanism).toBe('programmatic');
      expect(bundle.request.environment.platform.type).toBe(target.name);

      expect(
        bundle.files['logs.json'],
        `no logs.json in the bundle (${result.stderr})`,
      ).toBeDefined();
      const logs = parseJson<LogEntry[]>(bundle.files['logs.json']);
      // The breadcrumb written through the off-thread ring → worker → disk survived and was read back.
      expect(logs.some((l) => l.message.includes('worker-writer breadcrumb 9b2e'))).toBe(true);
      // The 100-line burst exercised the ring under real throughput; the worker drained it all to disk and
      // the snapshot (flush-and-ack first) read it back — a large majority must survive (no ring loss).
      const burst = logs.filter((l) => l.message.includes('worker-writer burst')).length;
      expect(
        burst,
        `only ${burst}/100 off-thread burst lines survived into the bundle`,
      ).toBeGreaterThanOrEqual(80);

      // The captured network request also round-tripped through the off-thread path.
      expect(bundle.files['network.json'], 'no network.json in the bundle').toBeDefined();
      const net = parseJson<NetworkEntry[]>(bundle.files['network.json']);
      expect(net.some((n) => typeof n.url === 'string' && n.url.includes('/echo'))).toBe(true);
    });
  });

  describe('propagation: cross-project trace round-trip (inbound continue → report → outbound)', () => {
    let collector: MockCollector;
    let result: { exitCode: number | null; stderr: string };
    let bundles: ParsedBundle[];

    beforeAll(async () => {
      collector = await startMockCollector();
      result = await runScenarioProcess(target, collector.url, 'propagation');
      bundles = parseBundles(collector);
    }, 60_000);

    afterAll(async () => {
      await collector.close();
    });

    it('the app process exits cleanly', () => {
      expect(result.exitCode, result.stderr).toBe(0);
    });

    it('the SAME trace id flows inbound → report → outbound (one distributed transaction)', () => {
      // (1) The handler's report carries the CONTINUED inbound trace id (X2 continuation + T8 report stamp).
      const report = bundles.find((b) => b.request.summary === 'e2e propagation handler failure');
      expect(report, `no propagation report delivered (${result.stderr})`).toBeDefined();
      expect((report as ParsedBundle).request.trace_id).toBe('0af7651916cd43dd8448eb211c80319c');

      // (2) The handler's OUTGOING /echo call carried the SAME trace id — the propagation decorator injected
      // it from the active per-request context (X3), with the backend's OWN span (a child of the inbound span).
      const echo = collector.echoHeaders.find((h) => typeof h.traceparent === 'string');
      expect(echo, 'no traceparent injected on the handler’s outgoing call').toBeDefined();
      const traceparent = echo?.traceparent as string;
      expect(traceparent).toContain('0af7651916cd43dd8448eb211c80319c'); // same trace, end to end
      expect(traceparent).not.toContain('b7ad6b7169203331'); // NOT the inbound span — the backend's own span
      // (3) …and the bugsee= vendor tracestate (X1) rode along with the session-correlation id.
      expect(typeof echo?.tracestate).toBe('string');
      expect(echo?.tracestate as string).toContain('bugsee=');
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
