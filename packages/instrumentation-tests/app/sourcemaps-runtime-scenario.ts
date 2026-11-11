// Child process for sourcemaps-runtime.e2e.ts: loads a bundle stamped like `bugsee-cli sourcemaps inject`,
// throws from it, and prints what the SDK's crash builder produces (frames + debug-ids) plus the registration keys.
import { createRequire } from 'node:module';
import process from 'node:process';
import { buildCrashJson } from '@bugsee/core';

// tsx turns source maps on for its own TS transform, so the harness pins the mode explicitly.
const mode = process.env.SOURCE_MAPS;
const setter = (process as unknown as { setSourceMapsEnabled?: (on: boolean) => void })
  .setSourceMapsEnabled;
if (mode !== undefined && setter !== undefined) {
  setter.call(process, mode === 'on');
}
const bundlePath = process.env.BUNDLE_PATH as string;
const require = createRequire(import.meta.url);
const app = require(bundlePath) as { fail: () => never };
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
    sourceMapsEnabled: (process as unknown as { sourceMapsEnabled?: boolean }).sourceMapsEnabled,
    registrationTopFrames: Object.keys(registry).map((k) => (k.split('\n')[1] ?? '').trim()),
    frames: crash.exception.frames
      .filter((f) => f.user)
      .map((f) => ({ at: f.trace, debug_id: f.debug_id })),
  })}\n`,
);
