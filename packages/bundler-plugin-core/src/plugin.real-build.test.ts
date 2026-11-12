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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rspack } from '@rspack/core';
import { build as esbuild, context as esbuildContext, type Plugin } from 'esbuild';
import { build as tsupBuild } from 'tsup';
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

describeReal('real tsup build (tsup always runs esbuild with write:false)', () => {
  it('uploads nothing, leaves the maps, and says why instead of silently doing nothing', async () => {
    const app = makeApp('tsup-app');
    const notices: string[] = [];
    const before = requests.length;
    await tsupBuild({
      config: false,
      entry: [app.entry],
      format: ['esm', 'cjs'],
      outDir: app.out,
      sourcemap: true,
      silent: true,
      dts: false,
      clean: true,
      esbuildPlugins: [
        bugseeEsbuildPlugin({
          ...pluginOptions,
          endpoint,
          onNotice: (m) => notices.push(m),
        }),
      ],
    });
    expect(requests.length).toBe(before);
    expect(notices.filter((m) => m.includes('write: false'))).toHaveLength(1);
    const files = readdirSync(app.out);
    expect(files.filter((f) => f.endsWith('.map')).length).toBeGreaterThan(0);
    expect(files.filter((f) => f.endsWith('.js') || f.endsWith('.cjs'))).not.toEqual([]);
    for (const f of files.filter((f) => /\.c?js$/.test(f))) {
      expect(readFileSync(join(app.out, f), 'utf8')).not.toContain('debugId');
    }
  });
});

/**
 * A `BUGSEE_CLI_PATH` wrapper: run the real CLI, then (for the FIRST `sourcemaps inject` only) signal via a file
 * and pause until the test releases it. Lets a test place another build's files exactly between a run's inject
 * and its upload, with no timing involved.
 */
function pauseAfterInjectWrapper(dir: string): {
  wrapper: string;
  injected: string;
  proceed: string;
} {
  const injected = join(dir, 'injected.flag');
  const proceed = join(dir, 'proceed.flag');
  const wrapper = join(dir, 'pause-after-inject.js');
  writeFileSync(
    wrapper,
    `const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const r = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...process.argv.slice(2)], { stdio: 'inherit' });
if (process.argv[2] === 'sourcemaps' && !fs.existsSync(${JSON.stringify(injected)})) {
  fs.writeFileSync(${JSON.stringify(injected)}, '1');
  for (let i = 0; i < 2000 && !fs.existsSync(${JSON.stringify(proceed)}); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
process.exit(r.status ?? 1);
`,
  );
  return { wrapper, injected, proceed };
}

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 2000 && !existsSync(path); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(existsSync(path)).toBe(true);
}

async function withCliPath<T>(wrapper: string, run: () => Promise<T>): Promise<T> {
  const saved = process.env.BUGSEE_CLI_PATH;
  process.env.BUGSEE_CLI_PATH = wrapper;
  try {
    return await run();
  } finally {
    if (saved === undefined) {
      delete process.env.BUGSEE_CLI_PATH;
    } else {
      process.env.BUGSEE_CLI_PATH = saved;
    }
  }
}

const esmBuild = (app: { dir: string; entry: string; out: string }, plugins: Plugin[], more = {}) =>
  esbuild({
    entryPoints: [app.entry],
    bundle: true,
    outdir: app.out,
    absWorkingDir: app.dir,
    format: 'esm',
    outExtension: { '.js': '.mjs' },
    logLevel: 'silent',
    plugins,
    ...more,
  });
const cjsBuild = (app: { dir: string; out: string }, plugins: Plugin[], more = {}) =>
  esbuild({
    entryPoints: [join(app.dir, 'second.js')],
    bundle: true,
    outdir: app.out,
    absWorkingDir: app.dir,
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
    logLevel: 'silent',
    plugins,
    ...more,
  });

const STAMP = /\/\/# debugId=[0-9a-f-]{36}/;
const stamped = (path: string): boolean => STAMP.test(readFileSync(path, 'utf8'));
const mapsIn = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.map'));
const withSecond = (name: string) => {
  const app = makeApp(name);
  writeFileSync(join(app.dir, 'second.js'), "console.log('second');\n");
  return app;
};

describeReal('esm + cjs builds into one outdir (tsup-style, one shared plugin)', () => {
  it.each([
    [true, 0],
    [false, 0],
    [true, 400],
    [false, 400],
  ])('both are stamped, uploaded and cleaned (failOnError %s, collector delay %s ms)', async (failOnError, delay) => {
    const app = withSecond(`esbuild-dual-${failOnError}-${delay}`);
    const errors: unknown[] = [];
    const plugin = bugseeEsbuildPlugin({
      ...pluginOptions,
      endpoint,
      failOnError,
      onError: (e) => errors.push(e),
    });
    const before = requests.length;
    delayMs = delay;
    try {
      await Promise.all([esmBuild(app, [plugin]), cjsBuild(app, [plugin])]);
    } finally {
      delayMs = 0;
    }
    expect(errors).toEqual([]);
    expect(stamped(join(app.out, 'index.mjs'))).toBe(true);
    expect(stamped(join(app.out, 'second.cjs'))).toBe(true);
    expect(mapsIn(app.out)).toEqual([]);
    expect(requests.length - before).toBeGreaterThanOrEqual(2); // one upload per build
  });
});

describeReal('a build only touches the files it wrote', () => {
  it("foreign files appearing between the run's inject and upload are left exactly as they are", async () => {
    const app = withSecond('esbuild-foreign');
    const { wrapper, injected, proceed } = pauseAfterInjectWrapper(app.dir);
    const errors: unknown[] = [];
    const plugin = bugseeEsbuildPlugin({
      ...pluginOptions,
      endpoint,
      failOnError: true,
      onError: (e) => errors.push(e),
    });
    mkdirSync(app.out, { recursive: true });
    await withCliPath(wrapper, async () => {
      const first = esmBuild(app, [plugin]);
      await waitForFile(injected);
      // A foreign build (no plugin) writes an unstamped bundle and map between inject and upload.
      const foreign = cjsBuild(app, [], { sourcemap: 'external' });
      await foreign;
      writeFileSync(proceed, '1');
      await first;
    });
    expect(errors).toEqual([]);
    expect(stamped(join(app.out, 'index.mjs'))).toBe(true);
    expect(mapsIn(app.out)).toEqual(['second.cjs.map']); // not uploaded, not deleted
    expect(stamped(join(app.out, 'second.cjs'))).toBe(false); // not stamped
  });

  it('two plugin instances over one outdir each upload only their own build, with their own options', async () => {
    const app = withSecond('esbuild-two-instances');
    const a = bugseeEsbuildPlugin({ ...pluginOptions, endpoint, deleteMaps: true });
    const b = bugseeEsbuildPlugin({ ...pluginOptions, endpoint, deleteMaps: false });
    const before = requests.length;
    await Promise.all([esmBuild(app, [a]), cjsBuild(app, [b])]);
    expect(requests.length - before).toBeGreaterThanOrEqual(2);
    expect(stamped(join(app.out, 'index.mjs'))).toBe(true);
    expect(stamped(join(app.out, 'second.cjs'))).toBe(true);
    // A deleted its build's map; B (deleteMaps: false) kept its own, and neither touched the other's.
    expect(mapsIn(app.out)).toEqual(['second.cjs.map']);
  });

  it('an external-maps build and an inline-maps build together under failOnError: the inline one FAILS', async () => {
    const app = withSecond('esbuild-ext-and-inline');
    const plugin = bugseeEsbuildPlugin({ ...pluginOptions, endpoint, failOnError: true });
    const results = await Promise.allSettled([
      esmBuild(app, [plugin], { sourcemap: 'external' }),
      cjsBuild(app, [plugin], { sourcemap: 'inline' }),
    ]);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]?.status).toBe('rejected');
    expect(stamped(join(app.out, 'index.mjs'))).toBe(true);
  });
});

describeReal('watch mode (a long-lived esbuild context)', () => {
  it("uploads each rebuild's own outputs", async () => {
    const app = makeApp('esbuild-watch');
    const plugin = bugseeEsbuildPlugin({ ...pluginOptions, endpoint });
    const ctx = await esbuildContext({
      entryPoints: [app.entry],
      bundle: true,
      outdir: app.out,
      absWorkingDir: app.dir,
      logLevel: 'silent',
      plugins: [plugin],
    });
    try {
      const before = requests.length;
      await ctx.rebuild();
      expect(requests.length).toBeGreaterThan(before);
      expect(mapsIn(app.out)).toEqual([]);
      const afterFirst = requests.length;
      writeFileSync(app.entry, "console.log('changed');\n");
      await ctx.rebuild();
      expect(requests.length).toBeGreaterThan(afterFirst);
      expect(mapsIn(app.out)).toEqual([]);
      expect(stamped(join(app.out, 'index.js'))).toBe(true);
    } finally {
      await ctx.dispose();
    }
  });
});

describeReal('paths and sizes', () => {
  it('an outdir reached through a symlink works (nothing compares directories)', async () => {
    const app = makeApp('esbuild-symlink');
    const real = join(app.dir, 'real-out');
    mkdirSync(real, { recursive: true });
    const link = join(app.dir, 'linked-out');
    symlinkSync(real, link);
    await esbuild({
      entryPoints: [app.entry],
      bundle: true,
      outdir: link,
      absWorkingDir: app.dir,
      logLevel: 'silent',
      plugins: [bugseeEsbuildPlugin({ ...pluginOptions, endpoint })],
    });
    expect(stamped(join(real, 'index.js'))).toBe(true);
    expect(mapsIn(real)).toEqual([]);
  });

  it('a build with more outputs than fit in one CLI call is batched and fully uploaded', async () => {
    const app = makeApp('esbuild-many');
    const entries: string[] = [];
    for (let i = 0; i < 250; i++) {
      const f = join(app.dir, `e${i}.js`);
      writeFileSync(f, `console.log(${i});\n`);
      entries.push(f);
    }
    const before = requests.length;
    await esbuild({
      entryPoints: entries,
      bundle: true,
      outdir: app.out,
      absWorkingDir: app.dir,
      logLevel: 'silent',
      plugins: [bugseeEsbuildPlugin({ ...pluginOptions, endpoint })],
    });
    expect(mapsIn(app.out)).toEqual([]);
    expect(readdirSync(app.out).filter((f) => f.endsWith('.js'))).toHaveLength(250);
    for (const f of readdirSync(app.out)) {
      expect(stamped(join(app.out, f))).toBe(true);
    }
    expect(requests.length - before).toBeGreaterThanOrEqual(2);
  });
});
describeReal('failOnError with an esbuild build that emitted no maps', () => {
  const build = (name: string, options: object) => {
    const app = makeApp(name);
    return esbuild({
      entryPoints: [app.entry],
      bundle: true,
      outdir: app.out,
      absWorkingDir: app.dir,
      sourcemap: 'inline',
      logLevel: 'silent',
      plugins: [bugseeEsbuildPlugin({ ...pluginOptions, endpoint, ...options })],
    });
  };

  it('fails the build under failOnError (no maps at all is the misconfiguration it exists to stop)', async () => {
    const before = requests.length;
    await expect(build('esbuild-inline-strict', { failOnError: true })).rejects.toThrow();
    expect(requests.length).toBe(before);
  });

  it('does not fail the build without failOnError', async () => {
    const before = requests.length;
    await expect(build('esbuild-inline-lax', { failOnError: false })).resolves.toBeDefined();
    expect(requests.length).toBe(before);
  });
});

describeReal('a build nested inside another into the same outdir (worker bundling)', () => {
  const nested = async (name: string, options: object) => {
    const app = makeApp(name);
    writeFileSync(join(app.dir, 'worker.js'), "console.log('worker');\n");
    const plugin = bugseeEsbuildPlugin({ ...pluginOptions, endpoint, ...options });
    const inner = {
      entryPoints: [join(app.dir, 'worker.js')],
      bundle: true,
      outdir: app.out,
      absWorkingDir: app.dir,
      format: 'cjs' as const,
      outExtension: { '.js': '.cjs' },
      logLevel: 'silent' as const,
    };
    const t0 = Date.now();
    await esbuild({
      entryPoints: [app.entry],
      bundle: true,
      outdir: app.out,
      absWorkingDir: app.dir,
      format: 'esm',
      outExtension: { '.js': '.mjs' },
      logLevel: 'silent',
      plugins: [
        plugin,
        {
          // The pattern: a plugin runs a sub-build from onResolve, reusing the same plugins array.
          name: 'worker-subbuild',
          setup: (b) => {
            let done = false;
            b.onStart(async () => {
              if (!done) {
                done = true;
                await esbuild({ ...inner, plugins: [plugin] });
              }
            });
          },
        },
      ],
    });
    return { app, elapsed: Date.now() - t0 };
  };

  it('does not stall a build with no token (plugin effectively disabled)', async () => {
    const saved = process.env.BUGSEE_APP_TOKEN;
    delete process.env.BUGSEE_APP_TOKEN;
    try {
      const { elapsed } = await nested('esbuild-nested-notoken', { appToken: undefined });
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      if (saved !== undefined) {
        process.env.BUGSEE_APP_TOKEN = saved;
      }
    }
  });

  it('does not stall an enabled plugin either, and uploads both outputs', async () => {
    const { app, elapsed } = await nested('esbuild-nested-enabled', {});
    expect(elapsed).toBeLessThan(10_000);
    expect(readdirSync(app.out).filter((f) => f.endsWith('.map'))).toEqual([]);
  });
});

describeReal('builds that emit stylesheet maps (.css.map)', () => {
  // The CLI skips a `.css.map` it finds while scanning a directory, but a map named as an explicit path that has no
  // debug-id fails the whole call (exit 11). The plugin therefore sends only the maps of the build's own scripts.
  const cssApp = (name: string) => {
    const app = makeApp(name);
    writeFileSync(join(app.dir, 'a.css'), 'body { color: red; }\n');
    writeFileSync(join(app.dir, 'lazy.js'), "export const lazy = () => 'lazy';\n");
    writeFileSync(
      app.entry,
      "import './a.css';\nimport('./lazy.js').then((m) => console.log(m.lazy()));\n",
    );
    return app;
  };

  it.each([
    true,
    false,
  ])('splitting + hashed names + css uploads the script maps and removes every map (failOnError %s)', async (failOnError) => {
    const app = cssApp(`esbuild-css-${failOnError}`);
    const errors: unknown[] = [];
    const before = requests.length;
    await esbuild({
      entryPoints: [app.entry],
      bundle: true,
      splitting: true,
      format: 'esm',
      entryNames: '[name]-[hash]',
      chunkNames: '[name]-[hash]',
      outdir: app.out,
      absWorkingDir: app.dir,
      logLevel: 'silent',
      plugins: [
        bugseeEsbuildPlugin({
          ...pluginOptions,
          endpoint,
          failOnError,
          onError: (e) => errors.push(e),
        }),
      ],
    });
    expect(errors).toEqual([]);
    expect(requests.length).toBeGreaterThan(before);
    const files = readdirSync(app.out);
    expect(files.some((f) => f.endsWith('.css'))).toBe(true);
    for (const f of files.filter((f) => f.endsWith('.js'))) {
      expect(stamped(join(app.out, f))).toBe(true);
    }
    expect(mapsIn(app.out)).toEqual([]); // including the .css.map, as the directory path did
  });

  it.each([
    true,
    false,
  ])('a css-only build (no scripts) is a quiet no-op, even under failOnError (%s)', async (failOnError) => {
    const app = makeApp(`esbuild-css-only-${failOnError}`);
    writeFileSync(join(app.dir, 'only.css'), 'a { color: blue; }\n');
    const before = requests.length;
    await esbuild({
      entryPoints: [join(app.dir, 'only.css')],
      bundle: true,
      outdir: app.out,
      absWorkingDir: app.dir,
      logLevel: 'silent',
      plugins: [bugseeEsbuildPlugin({ ...pluginOptions, endpoint, failOnError })],
    });
    expect(requests.length).toBe(before);
  });

  it('watch rebuilds of an app that imports css keep uploading', async () => {
    const app = cssApp('esbuild-css-watch');
    const errors: unknown[] = [];
    const ctx = await esbuildContext({
      entryPoints: [app.entry],
      bundle: true,
      outdir: app.out,
      absWorkingDir: app.dir,
      logLevel: 'silent',
      plugins: [
        bugseeEsbuildPlugin({ ...pluginOptions, endpoint, onError: (e) => errors.push(e) }),
      ],
    });
    try {
      await ctx.rebuild();
      const afterFirst = requests.length;
      writeFileSync(join(app.dir, 'a.css'), 'body { color: green; }\n');
      await ctx.rebuild();
      expect(requests.length).toBeGreaterThan(afterFirst);
      expect(errors).toEqual([]);
      expect(mapsIn(app.out)).toEqual([]);
    } finally {
      await ctx.dispose();
    }
  });
});

describeReal(
  'a build with JS output the plugin cannot upload must not pass silently under failOnError',
  () => {
    const run = (name: string, options: object, more: object) => {
      const app = makeApp(name);
      return {
        app,
        build: esbuild({
          entryPoints: [app.entry],
          bundle: true,
          outdir: app.out,
          absWorkingDir: app.dir,
          sourcemap: 'external',
          logLevel: 'silent',
          plugins: [bugseeEsbuildPlugin({ ...pluginOptions, endpoint, ...options })],
          ...more,
        }),
      };
    };

    it('another plugin turning the metafile off', async () => {
      const turnOff: Plugin = {
        name: 'metafile-off',
        setup(b) {
          b.initialOptions.metafile = false;
        },
      };
      const before = requests.length;
      const strict = run('esbuild-nometa-strict', { failOnError: true }, {});
      // the second plugin comes AFTER ours, so it wins
      strict.build.catch(() => undefined);
      await expect(
        esbuild({
          entryPoints: [strict.app.entry],
          bundle: true,
          outdir: strict.app.out,
          absWorkingDir: strict.app.dir,
          sourcemap: 'external',
          logLevel: 'silent',
          plugins: [
            bugseeEsbuildPlugin({ ...pluginOptions, endpoint, failOnError: true }),
            turnOff,
          ],
        }),
      ).rejects.toThrow();
      const notices: string[] = [];
      const lax = makeApp('esbuild-nometa-lax');
      await esbuild({
        entryPoints: [lax.entry],
        bundle: true,
        outdir: lax.out,
        absWorkingDir: lax.dir,
        sourcemap: 'external',
        logLevel: 'silent',
        plugins: [
          bugseeEsbuildPlugin({
            ...pluginOptions,
            endpoint,
            failOnError: false,
            onNotice: (m) => notices.push(m),
          }),
          turnOff,
        ],
      });
      expect(requests.length).toBe(before);
      expect(notices.some((m) => m.includes('no metafile'))).toBe(true);
    });

    it('outExtension .bundle.jsx (an extension inject does not stamp)', async () => {
      const before = requests.length;
      await expect(
        run('esbuild-jsx-strict', { failOnError: true }, { outExtension: { '.js': '.bundle.jsx' } })
          .build,
      ).rejects.toThrow();
      const notices: string[] = [];
      await run(
        'esbuild-jsx-lax',
        { failOnError: false, onNotice: (m: string) => notices.push(m) },
        { outExtension: { '.js': '.bundle.jsx' } },
      ).build;
      expect(requests.length).toBe(before);
      expect(notices.some((m) => m.includes('.js, .mjs or .cjs'))).toBe(true);
    });
  },
);
