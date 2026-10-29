/**
 * Real-Electron smoke: the real `launchMain` + `launchRenderer` in a `sandbox: true` window on a REAL
 * Electron binary. Every other Electron test in the repo drives a fake IPC bus; this is the only one
 * that proves the sandboxed-preload + session-handshake + renderer→main convergence path on the real thing.
 *
 *   ELECTRON_BIN=/path/to/electron pnpm --filter @bugsee/instrumentation-tests exec tsx harness/electron-smoke.mts
 *
 * The repo deliberately has no Electron dependency, so the binary is supplied (the `electron-compat`
 * workflow installs `electron@alpha` into a scratch dir). No network is used: the transport is a recorder.
 * On Linux run it under a display (`xvfb-run -a …`); the window is created hidden.
 *
 * Exit code: 0 all assertions held, 1 an assertion failed, 2 the harness could not run.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const bin = process.env.ELECTRON_BIN;
if (!bin) {
  console.error('electron-smoke: set ELECTRON_BIN to a real Electron executable');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'bugsee-electron-smoke-'));
try {
  const common = { bundle: true, logLevel: 'error' as const, sourcemap: false };
  // Main + preload run under Electron's Node (CJS, `electron` is the runtime-provided built-in).
  for (const [entry, outfile] of [
    ['main-entry.ts', 'main.cjs'],
    ['preload-entry.ts', 'preload.cjs'],
  ] as const) {
    buildSync({
      ...common,
      entryPoints: [join(here, 'electron-smoke', entry)],
      outfile: join(dir, outfile),
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
    });
  }
  buildSync({
    ...common,
    entryPoints: [join(here, 'electron-smoke/renderer-entry.ts')],
    outfile: join(dir, 'renderer.js'),
    platform: 'browser',
    format: 'iife',
  });
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><body><script src="renderer.js"></script></body></html>',
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'bugsee-electron-smoke', main: 'main.cjs' }),
  );
} catch (e) {
  console.error('electron-smoke: bundling failed', e);
  rmSync(dir, { recursive: true, force: true });
  process.exit(2);
}

const env: NodeJS.ProcessEnv = { ...process.env, BUGSEE_SMOKE_DIR: dir };
delete env.ELECTRON_RUN_AS_NODE; // would make the binary a plain Node and skip the app entirely
// `--no-sandbox` turns off Chromium's OS-level renderer sandbox, which a CI container cannot set up (no SUID
// helper). So on Linux this lane covers the sandboxed-PRELOAD environment (`sandbox: true`: no Node polyfills,
// built-ins-only `require`, `process.sandboxed`), NOT the OS-sandboxed renderer path; only a run without the
// flag (e.g. the macOS measurement in the README) exercises that.
const args = process.platform === 'linux' ? ['--no-sandbox', dir] : [dir];
const run = spawnSync(bin, args, { env, encoding: 'utf8', timeout: 120_000 });
rmSync(dir, { recursive: true, force: true });

const line = `${run.stdout ?? ''}`.split('\n').find((l) => l.startsWith('RESULT_JSON '));
if (!line) {
  console.error('electron-smoke: no RESULT_JSON from Electron', {
    status: run.status,
    signal: run.signal,
  });
  console.error(run.stdout, run.stderr);
  process.exit(2);
}
// biome-ignore lint/suspicious/noExplicitAny: the result is an ad-hoc probe object asserted field by field below.
const r: any = JSON.parse(line.slice('RESULT_JSON '.length));

const checks: Array<[string, boolean]> = [
  ['main process did not throw', r.fatal === undefined],
  ['sandboxed preload ran without error', r.preloadError === undefined],
  ['renderer launched', r.renderer?.ok === true],
  [
    'renderer received the owner session id over IPC',
    typeof r.renderer?.sid === 'string' && r.renderer.sid.length > 0,
  ],
  ['preload exposed the bridge', r.renderer?.bridge === 'object'],
  [
    'preload runs in a sandboxed context (process.sandboxed)',
    r.renderer?.probe?.sandboxed === true,
  ],
  ['no Buffer in sandboxed preload', r.renderer?.probe?.hasBuffer === 'undefined'],
  ['no setImmediate in sandboxed preload', r.renderer?.probe?.hasSetImmediate === 'undefined'],
  ['no node globals in the renderer', r.rendererGlobals === 'undefined/undefined'],
  ['main uploaded exactly one bundle', r.bundles === 1],
  [
    'bundle carries logs, replay and crash files',
    ['logs.json', 'replay.bin', 'crash.json'].every((f) => r.files?.includes(f)),
  ],
  [
    'renderer console landed in the main bundle (convergence)',
    JSON.stringify(r.logs ?? '').includes('RENDERER-LOG-MARKER'),
  ],
  ['onError collected nothing', Array.isArray(r.errors) && r.errors.length === 0],
];
console.log(
  `electron ${r.electron} · chrome ${r.chrome} · node ${r.node} · getDisplayMedia ${r.displayMedia} · perms ${JSON.stringify(r.perms)}`,
);
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
if (failed) {
  console.error(JSON.stringify({ ...r, logs: undefined }, null, 2));
  process.exit(1);
}
