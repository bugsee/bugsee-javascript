// Local variables + source context, end to end through a REAL crash.
//
// This is the one thing the unit suites cannot do. They inject a fake inspector session and drive
// `Debugger.paused` by hand, so nothing there proves V8 actually pauses where we think it does, that the
// thrown object can be stamped and matched back to the Error the SDK captures, or that any of it survives
// bundle assembly, zipping and upload. A real process, the real `node:inspector`, a real uncaught throw,
// and the real uploaded artifact.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCALS_ORDER_ID, LOCALS_SECRET } from '../app/scenario';
import { type ParsedBundle, parseBundles, readJson } from './bundle';
import { type MockCollector, startMockCollector } from './collector';
import { type RuntimeTarget, runScenarioProcess, runtimeTargets } from './runtimes';

interface CrashFrameWire {
  trace: string;
  variables?: Record<string, string>;
  context?: { pre?: string[]; line?: string; post?: string[] };
}
interface CrashWire {
  exception: { reason?: string; frames: CrashFrameWire[] };
}

const targets = runtimeTargets().filter(
  (t): t is RuntimeTarget & { bin: string } => t.bin !== undefined,
);

describe.each(targets)('local variables + source context — $name', (target) => {
  let collector: MockCollector;
  let exitCode: number | null;
  let stderr: string;
  let bundles: ParsedBundle[];

  beforeAll(async () => {
    collector = await startMockCollector();
    const result = await runScenarioProcess(target, collector.url, 'locals', {}, 30_000);
    exitCode = result.exitCode;
    stderr = result.stderr;
    bundles = parseBundles(collector);
  }, 60_000);

  afterAll(async () => {
    await collector.close();
  });

  it('the scenario crashed and uploaded a crash bundle', () => {
    expect(exitCode, stderr).toBe(1);
    expect(bundles.length, `no bundle uploaded:\n${stderr}`).toBeGreaterThan(0);
    const crash = readJson<CrashWire>(bundles[0] as ParsedBundle, 'crash.json');
    expect(crash.exception.reason).toBe('e2e locals crash');
  });

  it('the SECRET local never appears anywhere in the uploaded bundle', () => {
    // The assertion that has to hold on EVERY runtime, whatever its inspector supports. A capture that
    // half-works must not be the way a live API key reaches the wire — so this is asserted over every
    // byte of every file, not just the field the feature writes to.
    for (const bundle of bundles) {
      for (const [name, bytes] of Object.entries(bundle.files)) {
        expect(
          new TextDecoder().decode(bytes),
          `${LOCALS_SECRET} leaked into ${name}`,
        ).not.toContain(LOCALS_SECRET);
      }
    }
  });

  it('degrades CLEANLY where the runtime cannot pause — no half-captured frames', () => {
    // Bun and Deno reuse this composition verbatim and their debugger support is not Node's: Bun's
    // `session.connect()` succeeds and then `Debugger.enable` throws. What must hold everywhere is that
    // the crash is still reported and the frames are either fully captured or not captured at all —
    // never partially, which would be a report that looks enriched and is not.
    const crash = readJson<CrashWire>(bundles[0] as ParsedBundle, 'crash.json');
    const withVariables = crash.exception.frames.filter((f) => f.variables !== undefined);
    if (withVariables.length > 0) {
      // Captured: every such frame carries real names, not an empty shell.
      for (const frame of withVariables) {
        expect(Object.keys(frame.variables ?? {}).length).toBeGreaterThan(0);
      }
    }
    // …and either way the report itself is intact, which is the property that actually matters.
    expect(crash.exception.frames.length).toBeGreaterThan(0);
    expect(crash.exception.reason).toBe('e2e locals crash');
  });
});

// Node is the runtime whose `node:inspector` we rely on, so the positive claims are asserted there.
const nodeTarget = targets.filter((t) => t.name === 'node');

describe.each(nodeTarget)('local variables — the captured values ($name)', (target) => {
  let collector: MockCollector;
  let crash: CrashWire;
  let stderr: string;

  beforeAll(async () => {
    collector = await startMockCollector();
    const result = await runScenarioProcess(target, collector.url, 'locals', {}, 30_000);
    stderr = result.stderr;
    crash = readJson<CrashWire>(parseBundles(collector)[0] as ParsedBundle, 'crash.json');
  }, 60_000);

  afterAll(async () => {
    await collector.close();
  });

  /** The frame the throw happened in — the only one whose locals this scenario controls. */
  const throwingFrame = (): CrashFrameWire | undefined =>
    crash.exception.frames.find((f) => f.trace.includes('e2eLocalsThrow'));

  it('captures the locals that were live at the throw', () => {
    const frame = throwingFrame();
    expect(
      frame,
      `no e2eLocalsThrow frame:\n${JSON.stringify(crash.exception.frames, null, 2)}`,
    ).toBeDefined();
    // The value V8 actually had, not a value this test supplied — proof the pause read real scope.
    expect(frame?.variables?.orderId).toBe(String(LOCALS_ORDER_ID));
  });

  it('REDACTS the local whose name says it is a secret', () => {
    expect(throwingFrame()?.variables?.apiKey).toBe('<redacted>');
  });

  it('renders an object local without calling into application code', () => {
    // V8's own description. Invoking a user `toString` inside someone else's crash could throw or have
    // side effects, so the value is whatever V8 already computed.
    expect(throwingFrame()?.variables?.customer).toBeDefined();
    expect(throwingFrame()?.variables?.customer).not.toContain('[object');
  });

  it('attaches the source line that actually threw', () => {
    // Source context on the same frame: the SDK read its own scenario file off disk at report time.
    expect(throwingFrame()?.context?.line).toContain('throw new Error');
    expect(stderr).not.toContain('[bugsee onError]');
  });
});
