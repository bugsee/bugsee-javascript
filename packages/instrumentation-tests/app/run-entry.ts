// Shared entry bootstrap: read the collector URL + scenario the runner passes via env, run the scenario
// with the runtime's own launch(), then exit. The crash scenario exits via the SDK (process.exit(1));
// every other completion exits 0, and any scenario error exits non-zero so the runner sees the failure.
import process from 'node:process';
import { type LaunchFn, runScenario } from './scenario';

export function runEntry(launch: LaunchFn): void {
  const collectorUrl = process.env.BUGSEE_E2E_COLLECTOR;
  const scenario = process.env.BUGSEE_E2E_SCENARIO ?? 'main';
  if (collectorUrl === undefined || collectorUrl === '') {
    console.error('[e2e] BUGSEE_E2E_COLLECTOR is not set'); // standalone entry diagnostic
    process.exit(2);
    return;
  }
  runScenario(launch, { collectorUrl, scenario })
    .then(() => {
      // `exit-clean` asserts that a default launch() leaves the process able to exit BY ITSELF. Calling
      // process.exit() here would end it regardless, making that assertion incapable of failing — so this
      // one scenario returns and lets the event loop drain (or not) on its own merits.
      if (scenario !== 'exit-clean') {
        process.exit(0);
      }
    })
    .catch((err: unknown) => {
      console.error('[e2e] scenario failed', err); // standalone entry diagnostic
      process.exit(3);
    });
}
