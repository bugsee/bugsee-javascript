// SM8 — the source-map plugin e2e. Drives the REAL @bugsee/vite-plugin writeBundle hook against a REAL
// (fake) `bugsee-cli` subprocess and a REAL build-output directory on disk. Proves the whole chain end to
// end — resolve the binary → spawn `sourcemaps inject` → spawn `debug-files upload` → delete client maps —
// exercising the actual child_process spawn + fs the unit tests could only mock. Only the Rust binary is
// faked (a tiny node script that records its argv + token). Also asserts the runtime debug-ID attach.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveBuildUuid } from '@bugsee/bundler-plugin-core';
import { applyDebugIds, formatStack, parseV8Stack, type StackFrame } from '@bugsee/core';
import { bugseeVitePlugin } from '@bugsee/vite-plugin';
import { afterEach, describe, expect, it } from 'vitest';

/** Extract the callable writeBundle hook from an unplugin-produced Vite plugin. */
function writeBundleHook(plugin: unknown): (output: { dir: string }) => Promise<void> {
  const one = Array.isArray(plugin) ? plugin[0] : plugin;
  const hook = (one as { writeBundle: unknown }).writeBundle;
  // unplugin may expose the hook as a bare function or as { handler }.
  const fn = typeof hook === 'function' ? hook : (hook as { handler: unknown }).handler;
  return fn as (output: { dir: string }) => Promise<void>;
}

describe('@bugsee source-maps — plugin drives bugsee-cli (e2e, fake binary)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    delete process.env.BUGSEE_CLI_PATH;
  });

  it('at writeBundle: spawns vcs-metadata → inject → upload with the right argv/token, then deletes the client .map', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bugsee-sm-e2e-'));
    const outDir = join(dir, 'dist');
    mkdirSync(outDir);
    writeFileSync(join(outDir, 'app.js'), 'console.log(1)\n//# sourceMappingURL=app.js.map');
    writeFileSync(join(outDir, 'app.js.map'), '{"version":3,"sources":[],"debugId":"e2e-id"}');

    // A fake `bugsee-cli`: records each invocation's argv + token to a log, exits 0.
    const logPath = join(dir, 'cli.log');
    const cliPath = join(dir, 'fake-bugsee-cli.mjs');
    writeFileSync(
      cliPath,
      `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\n` +
        `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv: process.argv.slice(2), token: process.env.BUGSEE_APP_TOKEN, endpoint: process.env.BUGSEE_ENDPOINT }) + '\\n');\n`,
    );
    chmodSync(cliPath, 0o755);
    process.env.BUGSEE_CLI_PATH = cliPath;

    const plugin = bugseeVitePlugin({
      appToken: 'e2e-tok',
      appVersion: '1.2.3',
      appBuild: '99',
      endpoint: 'https://api.e2e.test',
    });
    await writeBundleHook(plugin)({ dir: outDir });

    const lines = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { argv: string[]; token?: string; endpoint?: string });

    // 1) probe the commit, 2) inject, 3) upload — in that order.
    //
    // The probe is FIRST and that is not incidental: the metadata it resolves is the build's identity,
    // and it has to exist before the upload that will eventually carry it. It shells out to the same
    // `bugsee-cli vcs-metadata` the Android Gradle plugin uses rather than reimplementing git detection
    // in JavaScript — a fourth implementation is the one that drifts.
    expect(lines[0]?.argv).toEqual(['vcs-metadata', '--working-dir', process.cwd()]);

    expect(lines[1]?.argv).toEqual(['sourcemaps', 'inject', outDir]);

    // The upload argv carries no VCS metadata: it is collected and echoed on the result, but there is
    // no field for it in the upload protocol yet (docs/design/source-maps.md §9). This assertion is
    // what will fail, deliberately, on the day one is added — and it is also the assertion that
    // catches a flag appearing or disappearing, which is why it lists the argv in full.
    expect(lines[2]?.argv).toEqual([
      'debug-files',
      'upload',
      outDir,
      '--type',
      'sourcemaps',
      '--version',
      '1.2.3',
      '--build',
      '99',
      '--allow-empty',
    ]);
    // token + endpoint forwarded via env (never on argv).
    expect(lines[2]?.token).toBe('e2e-tok');
    expect(lines[2]?.endpoint).toBe('https://api.e2e.test');
    // The probe is NOT given the app token. It is a local git query and needs no credentials, so
    // handing them to it would expose them to one more subprocess for nothing.
    expect(lines[0]?.token).toBeUndefined();
    expect(lines.flatMap((l) => l.argv)).not.toContain('e2e-tok');

    // client .map deleted (privacy default); the .js kept.
    expect(existsSync(join(outDir, 'app.js.map'))).toBe(false);
    expect(existsSync(join(outDir, 'app.js'))).toBe(true);

    // Exactly three: this build is not a release one (no `configResolved`, and vitest runs under
    // NODE_ENV=test), so it must NOT register a build — a fourth call here would mean every dev build
    // in the wild creates a build record.
    expect(lines).toHaveLength(3);
  });

  it('registers a RELEASE build after the upload, from the bundles the upload stamped', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bugsee-reg-e2e-'));
    // The package that built this output — the nearest package.json ABOVE it. Written here so the
    // lookup is answered inside the test's own directory, not by whatever sits above the temp dir.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/e2e-web' }));
    const outDir = join(dir, 'dist');
    mkdirSync(outDir);
    // As `sourcemaps inject` leaves a bundle: the runtime stub, then the id comment, LAST. The fake
    // binary below does not stamp anything, so the stamp is written as the real one would have.
    const debugId = '3f1d2c4b-8a7e-5d6c-9b0a-1e2f3a4b5c6d';
    writeFileSync(
      join(outDir, 'app.js'),
      `console.log(1)\n;!function(){}();\n//# debugId=${debugId}\n//# sourceMappingURL=app.js.map`,
    );
    writeFileSync(join(outDir, 'app.js.map'), `{"version":3,"sources":[],"debugId":"${debugId}"}`);

    // Records argv + token, and — for `upload build` — the payload file's CONTENT, captured while the
    // file still exists (the plugin removes it once the CLI returns).
    const logPath = join(dir, 'cli.log');
    const cliPath = join(dir, 'fake-bugsee-cli.mjs');
    writeFileSync(
      cliPath,
      `#!/usr/bin/env node\nimport { appendFileSync, readFileSync } from 'node:fs';\n` +
        `const argv = process.argv.slice(2);\n` +
        `const at = argv.indexOf('--payload-json');\n` +
        `const payload = at === -1 ? undefined : JSON.parse(readFileSync(argv[at + 1], 'utf8'));\n` +
        `appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ argv, token: process.env.BUGSEE_APP_TOKEN, endpoint: process.env.BUGSEE_ENDPOINT, payload }) + '\\n');\n`,
    );
    chmodSync(cliPath, 0o755);
    process.env.BUGSEE_CLI_PATH = cliPath;

    const plugin = bugseeVitePlugin({
      appToken: 'e2e-tok',
      appVersion: '2.0.0',
      appBuild: '7',
      endpoint: 'https://api.e2e.test',
      vcs: false,
    });
    // The DEFAULT setting (`registerBuild: 'release'`), made release by the bundler itself — exactly
    // as `vite build` resolves its config before writing anything.
    const one = (Array.isArray(plugin) ? plugin[0] : plugin) as unknown as {
      configResolved: (c: { isProduction: boolean; mode: string }) => void;
    };
    one.configResolved({ isProduction: true, mode: 'production' });
    await writeBundleHook(plugin)({ dir: outDir });

    const lines = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(
        (l) =>
          JSON.parse(l) as { argv: string[]; token?: string; endpoint?: string; payload?: unknown },
      );

    // inject → upload → register. Registration LAST: it runs after the maps were deleted, which it
    // can because it reads the ids from the bundles.
    expect(lines.map((l) => l.argv.slice(0, 2))).toEqual([
      ['sourcemaps', 'inject'],
      ['debug-files', 'upload'],
      ['upload', 'build'],
    ]);
    const register = lines[2] as (typeof lines)[number];
    // Register-only: no artefact, and nothing but the payload file on argv.
    expect(register.argv.slice(2, 3)).toEqual(['--payload-json']);
    expect(register.argv).toHaveLength(4);
    expect(register.token).toBe('e2e-tok');
    expect(register.endpoint).toBe('https://api.e2e.test');

    expect(register.payload).toEqual({
      uuid: deriveBuildUuid([debugId], {
        packageId: '@acme/e2e-web',
        version: '2.0.0',
        build: '7',
        configuration: 'production',
      }),
      format: 'web',
      package_id: '@acme/e2e-web',
      version: '2.0.0',
      build: '7',
      build_configuration: 'production',
    });
    // The token is in the child's environment, never in the file written to disk.
    expect(JSON.stringify(register.payload)).not.toContain('e2e-tok');
    // ...and that file is gone.
    expect(existsSync(register.argv[3] as string)).toBe(false);
    // The maps were still deleted first — registration did not hold them back.
    expect(existsSync(join(outDir, 'app.js.map'))).toBe(false);
  });

  it('runtime: a report stack carries the debugId a bundle registered via _bugseeDebugIds', () => {
    const g = globalThis as { _bugseeDebugIds?: Record<string, string> };
    const prev = g._bugseeDebugIds;
    g._bugseeDebugIds = { 'Error\n    at reg (https://cdn/app.js:1:1)': 'e2e-debug-id' };
    try {
      const frames: StackFrame[] = parseV8Stack('Error\n    at handler (https://cdn/app.js:42:9)');
      applyDebugIds(frames, { parseStack: parseV8Stack });
      expect(formatStack(frames)).toContain('debugId=e2e-debug-id');
    } finally {
      if (prev === undefined) delete g._bugseeDebugIds;
      else g._bugseeDebugIds = prev;
    }
  });
});
