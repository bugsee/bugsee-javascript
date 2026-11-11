// Child process for sourcemaps-runtime.e2e.ts: loads a bundle stamped like `bugsee-cli sourcemaps inject`,
// throws from it, and prints what the SDK's crash builder produces (frames + debug-ids) plus the registration keys.
// SOURCE_MAPS: `on` / `off` pin runtime source-map support BEFORE the bundle loads; `late` enables it AFTER the
// bundle loaded (Node only maps modules loaded afterwards); unset leaves the process flags alone.
import { createRequire } from 'node:module';
import process from 'node:process';
import { buildCrashJson, setDebugIdRegistrationVerifier, setStackAppRoot } from '@bugsee/core';
// Internal to @bugsee/node (installed by its launch); imported by path so the public export surface stays unchanged.
import { createStampedBundleVerifier } from '../../node/src/debug-id-verifier';

const proc = process as unknown as {
  setSourceMapsEnabled?: (on: boolean) => void;
  sourceMapsEnabled?: boolean;
};
const mode = process.env.SOURCE_MAPS;
const setMaps = (on: boolean): void => proc.setSourceMapsEnabled?.call(process, on);
// tsx turns source maps on for its own TS transform, so the harness pins the mode explicitly.
if (mode === 'on') setMaps(true);
if (mode === 'off' || mode === 'late') setMaps(false);

// What `launch()` does for the app: scrub frame paths to the app root + install the stamp verifier.
const appRoot = process.env.APP_ROOT as string;
setStackAppRoot(appRoot);
setDebugIdRegistrationVerifier(createStampedBundleVerifier({ appRoot }));

const require = createRequire(import.meta.url);
const app = require(process.env.BUNDLE_PATH as string) as { fail: () => never };
if (mode === 'late') setMaps(true);
let thrown: unknown;
try {
  app.fail();
} catch (error) {
  thrown = error;
}
const registry = (globalThis as { _bugseeDebugIds?: Record<string, string> })._bugseeDebugIds ?? {};
const crash = buildCrashJson(thrown);
process.stdout.write(
  `${JSON.stringify({
    sourceMapsEnabled: proc.sourceMapsEnabled,
    registrationTopFrames: Object.keys(registry).map((k) => (k.split('\n')[1] ?? '').trim()),
    frames: crash.exception.frames
      .filter((f) => f.user && !f.trace.includes('sourcemaps-runtime-scenario'))
      .map((f) => ({ at: f.trace, debug_id: f.debug_id })),
  })}\n`,
);
