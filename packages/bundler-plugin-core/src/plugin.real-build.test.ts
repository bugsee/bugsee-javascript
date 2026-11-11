// #184, end to end: a REAL esbuild build and a REAL Rspack build with the REAL plugin and the REAL
// bugsee-cli. The hook wiring is unit-tested in plugin.esbuild-rspack.test.ts; this proves the hooks fire
// at the right moment in the real bundlers (maps already on disk), that the CLI stamps the bundle, that the
// upload reaches a collector, and that the client map is deleted afterwards.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rspack } from '@rspack/core';
import { build as esbuild } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bugseeEsbuildPlugin, bugseeRspackPlugin } from './plugin';
import { resolveBugseeCli } from './run-cli';

let server: Server;
let endpoint: string;
const requests: Array<{ url: string }> = [];
let root: string;
/** How long the collector holds each answer; a slow backend is what exposes overlapping-build races. */
let delayMs = 0;

// The real `bugsee-cli` binary is downloaded by its postinstall. Locally a missing binary SKIPS these tests
// with a reason; CI (or BUGSEE_REQUIRE_CLI=1) requires it, so a CI run can never go green testing less.
const cli = resolveBugseeCli();
const cliProbe = cli.endsWith('.js')
  ? spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
  : spawnSync(cli, ['--version'], { encoding: 'utf8' });
const cliAvailable = cliProbe.status === 0;
const cliRequired = process.env.CI !== undefined || process.env.BUGSEE_REQUIRE_CLI !== undefined;
if (!cliAvailable && !cliRequired) {
  console.warn('[bugsee] bugsee-cli binary not available: skipping the real-build tests');
}
const describeReal = cliAvailable || cliRequired ? describe : describe.skip;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'bugsee-real-build-'));
  // Every request is answered "already uploaded", so the upload succeeds without a backend.
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? '' });
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ ok: false, error: { type: 'DuplicateSymbolsFoundError', code: 16004 } }),
        );
      }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

function makeApp(name: string): { dir: string; entry: string; out: string } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, 'index.js');
  writeFileSync(join(dir, 'greet.js'), "export const greet = (n) => 'hello ' + n;\n");
  writeFileSync(entry, "import { greet } from './greet.js';\nconsole.log(greet('world'));\n");
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3' }));
  return { dir, entry, out: join(dir, 'dist') };
}

const pluginOptions = {
  appToken: 'real-build-token',
  endpoint: '',
  vcs: false,
  registerBuild: false as const,
  failOnError: true,
};

function expectUploaded(out: string, before: number): void {
  const files = readdirSync(out);
  const bundle = files.find((f) => f.endsWith('.js'));
  expect(bundle).toBeDefined();
  const code = readFileSync(join(out, bundle as string), 'utf8');
  // `sourcemaps inject` stamped the bundle: the debug-id comment and the runtime registration.
  expect(code).toMatch(/\/\/# debugId=[0-9a-f-]{36}/);
  expect(code).toContain('_bugseeDebugIds');
  // The upload reached the collector, and the client maps were deleted afterwards.
  expect(requests.length).toBeGreaterThan(before);
  expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
}

describeReal('real esbuild build', () => {
  it('stamps, uploads and deletes the maps at the end of the build', async () => {
    const app = makeApp('esbuild-app');
    const before = requests.length;
    await esbuild({
      entryPoints: [app.entry],
      bundle: true,
      outdir: app.out,
      absWorkingDir: app.dir,
      logLevel: 'silent',
      // No `sourcemap` here on purpose: the plugin must make the build emit maps (external, so the
      // shipped bundle does not point at a map that is deleted after upload).
      plugins: [bugseeEsbuildPlugin({ ...pluginOptions, endpoint })],
    });
    expectUploaded(app.out, before);
    expect(readFileSync(join(app.out, 'index.js'), 'utf8')).not.toContain(
      'sourceMappingURL=index.js.map',
    );
  });

  it('two OVERLAPPING builds into one outdir (tsup esm+cjs) both get stamped, uploaded and cleaned', async () => {
    // One plugin object shared by both builds, as tsup does. The collector is slow, so the first build's
    // upload is still in flight when the second build writes its files. Joining that in-flight upload
    // (it had already scanned the directory) used to delete the second build's maps, never uploaded.
    const app = makeApp('esbuild-race');
    writeFileSync(join(app.dir, 'second.js'), "console.log('second');\n");
    const errors: unknown[] = [];
    const plugin = bugseeEsbuildPlugin({
      ...pluginOptions,
      endpoint,
      failOnError: false,
      onError: (e) => errors.push(e),
    });
    const before = requests.length;
    delayMs = 600;
    try {
      await Promise.all([
        esbuild({
          entryPoints: [app.entry],
          bundle: true,
          outdir: app.out,
          absWorkingDir: app.dir,
          format: 'esm',
          outExtension: { '.js': '.mjs' },
          logLevel: 'silent',
          plugins: [plugin],
        }),
        esbuild({
          entryPoints: [join(app.dir, 'second.js')],
          bundle: true,
          outdir: app.out,
          absWorkingDir: app.dir,
          format: 'cjs',
          outExtension: { '.js': '.cjs' },
          logLevel: 'silent',
          // Finishes while the first build's (slow) upload is in flight.
          plugins: [
            plugin,
            {
              name: 'delay',
              setup: (b) => {
                b.onStart(() => new Promise<void>((r) => setTimeout(r, 250)));
              },
            },
          ],
        }),
      ]);
    } finally {
      delayMs = 0;
    }
    expect(errors).toEqual([]);
    const files = readdirSync(app.out);
    for (const bundle of ['index.mjs', 'second.cjs']) {
      expect(readFileSync(join(app.out, bundle), 'utf8')).toMatch(/\/\/# debugId=[0-9a-f-]{36}/);
    }
    expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
    // Each build's maps were actually uploaded: at least one request per build.
    expect(requests.length - before).toBeGreaterThanOrEqual(2);
  });

  it('a disabled plugin leaves the build untouched', async () => {
    const app = makeApp('esbuild-disabled');
    const before = requests.length;
    await esbuild({
      entryPoints: [app.entry],
      bundle: true,
      outdir: app.out,
      absWorkingDir: app.dir,
      sourcemap: true,
      logLevel: 'silent',
      plugins: [bugseeEsbuildPlugin({ ...pluginOptions, endpoint, disabled: true })],
    });
    expect(requests.length).toBe(before);
    expect(readFileSync(join(app.out, 'index.js'), 'utf8')).not.toContain('debugId');
    expect(existsSync(join(app.out, 'index.js.map'))).toBe(true);
  });
});

function runRspack(config: Parameters<typeof rspack>[0]): Promise<{ errors: number }> {
  return new Promise((resolve, reject) => {
    const compiler = rspack(config);
    compiler.run((err, stats) => {
      compiler.close(() => {
        if (err) {
          reject(err);
        } else {
          resolve({
            errors:
              (stats as { compilation: { errors: unknown[] } } | undefined)?.compilation.errors
                .length ?? 0,
          });
        }
      });
    });
  });
}

describeReal('real Rspack build', () => {
  const config = (app: { dir: string; entry: string; out: string }, extra: object = {}) => ({
    context: app.dir,
    mode: 'production' as const,
    entry: app.entry,
    devtool: 'source-map' as const,
    output: { path: app.out },
    ...extra,
  });

  it('stamps, uploads and deletes the maps after emit', async () => {
    const app = makeApp('rspack-app');
    const before = requests.length;
    const { errors } = await runRspack(
      config(app, { plugins: [bugseeRspackPlugin({ ...pluginOptions, endpoint })] }),
    );
    expect(errors).toBe(0);
    expectUploaded(app.out, before);
  });

  it('REFUSES an SRI build: nothing is stamped or uploaded and the maps stay', async () => {
    const app = makeApp('rspack-sri');
    mkdirSync(app.out, { recursive: true });
    // What an SRI plugin leaves behind: a page pinning the hash of the entry script.
    writeFileSync(
      join(app.out, 'index.html'),
      '<script src="main.js" integrity="sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"></script>',
    );
    const errors: unknown[] = [];
    const before = requests.length;
    await runRspack(
      config(app, {
        plugins: [
          bugseeRspackPlugin({
            ...pluginOptions,
            endpoint,
            failOnError: false,
            onError: (e) => errors.push(e),
          }),
        ],
      }),
    );
    expect(errors.map(String).join()).toContain('refusing to stamp debug-IDs');
    expect(requests.length).toBe(before);
    expect(readFileSync(join(app.out, 'main.js'), 'utf8')).not.toContain('debugId');
    expect(existsSync(join(app.out, 'main.js.map'))).toBe(true);
  });

  it('a build with a compile error uploads nothing', async () => {
    const app = makeApp('rspack-broken');
    writeFileSync(app.entry, "import './does-not-exist.js';\n");
    const before = requests.length;
    const { errors } = await runRspack(
      config(app, { plugins: [bugseeRspackPlugin({ ...pluginOptions, endpoint })] }),
    );
    expect(errors).toBeGreaterThan(0);
    expect(requests.length).toBe(before);
    // Rspack emits nothing for a broken production build, so there is no output to stamp.
    expect(existsSync(app.out)).toBe(false);
  });
});
