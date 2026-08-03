// Process-lifecycle e2e (Wave 2.4 / 2.5, decision D2). Both claims here are about what a REAL process does,
// which is the only place they are observable: whether it exits at all, and with which code. Unit tests
// cover the SDK's logic; a supervisor only ever sees these two facts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockCollector, startMockCollector } from './collector';
import { type RuntimeTarget, runScenarioProcess, runtimeTargets } from './runtimes';

const targets = runtimeTargets().filter(
  (t): t is RuntimeTarget & { bin: string } => t.bin !== undefined,
);

describe.each(targets)('process lifecycle — $name', (target) => {
  let collector: MockCollector;

  beforeAll(async () => {
    collector = await startMockCollector();
  });
  afterAll(async () => {
    await collector.close();
  });

  it('a default launch() does not stop the program from exiting', async () => {
    // The hang watchdog is on by default. Its worker is unref'd at spawn, but attaching the `message`
    // listener re-refs the MessagePort — so every CLI, migration, CI job and cron task that called launch()
    // hung forever. Measured before the fix: still alive at 5 s with an active "MessagePort" handle.
    const result = await runScenarioProcess(target, collector.url, 'exit-clean', {}, 15_000);
    expect(result.timedOut, `process never exited:\n${result.stderr}`).toBe(false);
    expect(result.exitCode, result.stderr).toBe(0);
  }, 30_000);

  it('an unhandled rejection still crashes the process with exit 1', async () => {
    // Registering ANY unhandledRejection listener disables Node's default disposition. A passive reporting
    // listener therefore flipped a crashing service to exit 0, and supervisors/CI read success. The exit
    // code IS the contract here.
    const result = await runScenarioProcess(target, collector.url, 'reject', {}, 20_000);
    expect(result.timedOut, `process never exited:\n${result.stderr}`).toBe(false);
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stderr).toContain('e2e unhandled rejection');
  }, 30_000);
});
