// #184, end to end: a REAL esbuild build and a REAL Rspack build with the REAL plugin and the REAL
// bugsee-cli. The hook wiring is unit-tested in plugin.esbuild-rspack.test.ts; this proves the hooks fire
// at the right moment in the real bundlers (maps already on disk), that the CLI stamps the bundle, that the
// upload reaches a collector, and that the client map is deleted afterwards.
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

let server: Server;
let endpoint: string;
const requests: Array<{ url: string }> = [];
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'bugsee-real-build-'));
  // Every request is answered "already uploaded", so the upload succeeds without a backend.
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? '' });
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ ok: false, error: { type: 'DuplicateSymbolsFoundError', code: 16004 } }),
      );
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

describe('real esbuild build', () => {
  it('stamps, uploads and deletes the maps at the end of the build', async () => {
    const app = makeApp('esbuild-app');
    const before = requests.length;
    await esbuild({
      entryPoints: [app.entry],
      bundle: true,
      outdir: app.out,
      absWorkingDir: app.dir,
      logLevel: 'silent',
      // No `sourcemap` here on purpose: the plugin must make the build emit maps.
      plugins: [bugseeEsbuildPlugin({ ...pluginOptions, endpoint })],
    });
    expectUploaded(app.out, before);
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

describe('real Rspack build', () => {
  it('stamps, uploads and deletes the maps after emit', async () => {
    const app = makeApp('rspack-app');
    const before = requests.length;
    await new Promise<void>((resolve, reject) => {
      const compiler = rspack({
        context: app.dir,
        mode: 'production',
        entry: app.entry,
        devtool: 'source-map',
        output: { path: app.out },
        plugins: [bugseeRspackPlugin({ ...pluginOptions, endpoint })],
      });
      compiler.run((err, stats) => {
        compiler.close(() => {
          if (err) {
            reject(err);
          } else if (stats?.hasErrors()) {
            reject(new Error(stats.toString()));
          } else {
            resolve();
          }
        });
      });
    });
    expectUploaded(app.out, before);
  });
});
