// The doctor against REAL build output: Vite 8 (Rolldown), Vite 7 (Rollup), Rollup and Rspack (webpack's
// processAssets stamping path) stamped by the real plugin + the real bugsee-cli, an unstamped build, an
// inline-map build, and SRI builds (stamped-first = fine; stamped-after-hash = the browser-blocking mismatch).
// Webpack itself is not a dependency of this package; Rspack exercises the same in-build stamp code.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rspack } from '@rspack/core';
import { rollup } from 'rollup';
import { type Plugin as VitePlugin, build as viteBuild } from 'vite';
import { build as vite7Build } from 'vite7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DoctorReport, diagnoseBuildOutput, doctorExitCode } from './doctor';
import { bugseeRollupPlugin, bugseeRspackPlugin, bugseeUnplugin } from './plugin';
import { resolveBugseeCli, runBugseeCli } from './run-cli';

let server: Server;
let endpoint: string;
let root: string;

const cli = resolveBugseeCli();
const probe = cli.endsWith('.js')
  ? spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' })
  : spawnSync(cli, ['--version'], { encoding: 'utf8' });
const cliAvailable = probe.status === 0;
const cliRequired = process.env.CI !== undefined || process.env.BUGSEE_REQUIRE_CLI !== undefined;
const describeReal = cliAvailable || cliRequired ? describe : describe.skip;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'bugsee-doctor-real-'));
  server = createServer((req, res) => {
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

const pluginOptions = (extra: object = {}) => ({
  appToken: 'doctor-token',
  endpoint,
  vcs: false,
  registerBuild: false as const,
  failOnError: true,
  deleteMaps: false, // keep the maps on disk so the doctor has pairs to check
  ...extra,
});

function makeApp(name: string): { dir: string; out: string } {
  const dir = join(realpathSync(root), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head></head><body><script type="module" src="./index.js"></script></body></html>\n',
  );
  writeFileSync(join(dir, 'greet.js'), "export const greet = (n) => 'hello ' + n;\n");
  writeFileSync(join(dir, 'lazy.js'), "export default 'lazy chunk ' + Date.now();\n");
  writeFileSync(
    join(dir, 'index.js'),
    "import { greet } from './greet.js';\nconsole.log(greet('world'));\nimport('./lazy.js').then((m) => console.log(m.default));\n",
  );
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3' }));
  return { dir, out: join(dir, 'dist') };
}

const sri = (bytes: string | Buffer): string =>
  `sha384-${createHash('sha384').update(bytes).digest('base64')}`;

const viteConfig = (app: { dir: string; out: string }, plugins: unknown[], build: object = {}) =>
  ({
    root: app.dir,
    configFile: false,
    logLevel: 'silent',
    base: './',
    plugins,
    build: { outDir: app.out, emptyOutDir: true, minify: false, sourcemap: 'hidden', ...build },
  }) as never;

/** Pins every emitted chunk in the page, hashing in generateBundle (post), like an SRI plugin does. */
const viteSri = (): VitePlugin => ({
  name: 'doctor-sri',
  enforce: 'post',
  generateBundle: {
    order: 'post',
    handler(_options, bundle) {
      const page = bundle['index.html'];
      if (page?.type === 'asset') {
        page.source = String(page.source).replace(
          /<script\b[^>]*?src="\.?\/?([^"]+\.js)"[^>]*>/g,
          (tag, file: string) => {
            const entry = bundle[file];
            return entry?.type === 'chunk'
              ? tag.replace(/>$/, ` integrity="${sri(entry.code)}">`)
              : tag;
          },
        );
      }
    },
  },
});

const doctor = (out: string, extra: { deployed?: boolean } = {}): Promise<DoctorReport> =>
  diagnoseBuildOutput(out, {
    ...extra,
    env: { BUGSEE_APP_TOKEN: 't', BUGSEE_APP_BUILD: 'b' },
    projectRoot: dirname(out),
  });
const idsOf = (report: DoctorReport, severity?: string): string[] =>
  report.findings.filter((f) => severity === undefined || f.severity === severity).map((f) => f.id);

/** The only non-error findings a correctly stamped, maps-kept, hidden-map build is allowed to have. */
function expectHealthyStamped(report: DoctorReport): void {
  expect(idsOf(report, 'error')).toEqual([]);
  expect(report.summary.bundles).toBeGreaterThanOrEqual(1);
  expect(report.summary.maps).toBe(report.summary.bundles);
  expect(idsOf(report).sort()).toEqual(
    expect.arrayContaining(['map.hidden', 'map.public-leftover', 'map.sources-content']),
  );
  // Straight after a plugin run nothing warns (so `--strict` passes); the leftover maps are a note...
  expect(idsOf(report, 'warning')).toEqual([]);
  expect(idsOf(report, 'info')).toContain('map.public-leftover');
  expect(report.passed).toEqual(
    expect.arrayContaining([
      'stamp.missing-debug-id',
      'stamp.map-id-mismatch',
      'stamp.missing-registration',
    ]),
  );
}

describeReal('doctor on real, stamped build output', () => {
  it('Vite 8 (Rolldown) with hidden maps is healthy', async () => {
    const app = makeApp('vite8');
    await viteBuild(viteConfig(app, [bugseeUnplugin.vite(pluginOptions()) as VitePlugin]));
    expectHealthyStamped(await doctor(app.out));
  });

  it('Vite 7 (Rollup) with hidden maps is healthy', async () => {
    const app = makeApp('vite7');
    await vite7Build(viteConfig(app, [bugseeUnplugin.vite(pluginOptions()) as VitePlugin]));
    expectHealthyStamped(await doctor(app.out));
  });

  it('Rollup is healthy', async () => {
    const app = makeApp('rollup');
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [bugseeRollupPlugin(pluginOptions())],
    });
    await bundle.write({ dir: app.out, sourcemap: 'hidden' });
    await bundle.close();
    expectHealthyStamped(await doctor(app.out));
  });

  it('Rollup with maps moved by sourcemapFileNames has no errors (and reports the wrong pointer Rollup writes)', async () => {
    const app = makeApp('rollup-moved');
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [bugseeRollupPlugin(pluginOptions())],
    });
    await bundle.write({
      dir: app.out,
      sourcemap: true,
      sourcemapFileNames: 'maps/[name].map',
    });
    await bundle.close();
    const report = await doctor(app.out, { deployed: true });
    expect(idsOf(report, 'error')).toEqual([]);
    expect(report.summary.maps).toBe(report.summary.bundles);
    expect(report.findings.some((f) => f.file?.startsWith('maps/'))).toBe(true);
    // Rollup writes the pointer as `index.map` (relative to the file NAME, ignoring the `maps/` directory), so the
    // browser's request 404s: the doctor says so, truthfully. The moved maps are still read and validated.
    expect(idsOf(report, 'warning').sort()).toEqual([
      'map.pointer-dangling',
      'map.public-leftover',
    ]);
  });

  it('Rspack (webpack in-build stamping path) with hidden maps is healthy', async () => {
    const app = makeApp('rspack');
    await new Promise<void>((resolve, reject) => {
      const compiler = rspack({
        context: app.dir,
        mode: 'production',
        entry: join(app.dir, 'index.js'),
        devtool: 'hidden-source-map',
        output: { path: app.out },
        plugins: [bugseeRspackPlugin(pluginOptions())],
      });
      compiler.run((err) => compiler.close(() => (err ? reject(err) : resolve())));
    });
    expectHealthyStamped(await doctor(app.out));
  });

  it('Vite with visible maps and the default deleteMaps leaves a dangling pointer (a note, and --strict passes)', async () => {
    const app = makeApp('vite8-dangling');
    await viteBuild(
      viteConfig(app, [bugseeUnplugin.vite(pluginOptions({ deleteMaps: true })) as VitePlugin], {
        sourcemap: true,
      }),
    );
    const report = await doctor(app.out);
    expect(report.summary.maps).toBe(0);
    expect(idsOf(report, 'error')).toEqual([]);
    // maps removed on purpose and every bundle stamped: a note, so --strict passes right after the plugin
    expect(idsOf(report, 'warning')).toEqual([]);
    expect(idsOf(report, 'info')).toContain('map.pointer-dangling');
    expect(doctorExitCode(report, true)).toBe(0);
  });
});

describeReal('doctor on real, problematic build output', () => {
  it('an unstamped Vite build (plugin disabled) is an error per bundle', async () => {
    const app = makeApp('vite8-unstamped');
    await viteBuild(
      viteConfig(app, [bugseeUnplugin.vite(pluginOptions({ disabled: true })) as VitePlugin], {
        sourcemap: true,
      }),
    );
    const report = await doctor(app.out);
    const errors = report.findings.filter((f) => f.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((f) => f.id === 'stamp.missing-debug-id')).toBe(true);
    expect(report.summary.errors).toBe(report.summary.bundles);
  });

  it('an inline-map Vite build is reported as map.inline', async () => {
    const app = makeApp('vite8-inline');
    await viteBuild(
      viteConfig(app, [bugseeUnplugin.vite(pluginOptions({ disabled: true })) as VitePlugin], {
        sourcemap: 'inline',
      }),
    );
    const report = await doctor(app.out);
    expect(idsOf(report, 'error')).toContain('map.inline');
    expect(report.summary.maps).toBe(0);
  });

  it('SRI: an unstamped build pinning hashes is flagged as a hazard; stamped-first is clean; stamped-after-hash is a mismatch', async () => {
    const plain = makeApp('vite8-sri-plain');
    await viteBuild(
      viteConfig(plain, [
        bugseeUnplugin.vite(pluginOptions({ disabled: true })) as VitePlugin,
        viteSri(),
      ]),
    );
    const hazard = await doctor(plain.out);
    expect(idsOf(hazard)).toContain('sri.unstamped-hazard');
    expect(idsOf(hazard)).not.toContain('sri.mismatch');

    const first = makeApp('vite8-sri-first');
    await viteBuild(
      viteConfig(first, [bugseeUnplugin.vite(pluginOptions()) as VitePlugin, viteSri()]),
    );
    const clean = await doctor(first.out);
    expect(idsOf(clean)).not.toContain('sri.unstamped-hazard');
    expect(idsOf(clean)).not.toContain('sri.mismatch');
    expect(idsOf(clean, 'error')).toEqual([]);
    expect(clean.passed).toContain('sri.mismatch');

    // The post-emit stamp the in-build design exists to avoid: the page was hashed before the stamp.
    const result = await runBugseeCli(['sourcemaps', 'inject', plain.out, '--allow-sri'], {
      cwd: plain.dir,
    });
    expect(result.code).toBe(0);
    const broken = await doctor(plain.out);
    expect(idsOf(broken, 'error')).toContain('sri.mismatch');
    expect(idsOf(broken)).not.toContain('sri.unstamped-hazard');
    expect(readdirSync(plain.out).length).toBeGreaterThan(0);
    expect(readFileSync(join(plain.out, 'index.html'), 'utf8')).toContain('integrity=');
  });
});
