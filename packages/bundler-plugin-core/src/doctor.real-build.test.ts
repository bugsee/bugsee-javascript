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
import {
  type DoctorReport,
  diagnoseBuildOutput,
  doctorExitCode,
  hasOriginalPosition,
} from './doctor';
import { isFacadeCode } from './facade';
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

function makeApp(name: string, options: { lazy?: boolean } = {}): { dir: string; out: string } {
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
    `import { greet } from './greet.js';\nconsole.log(greet('world'));\n${
      options.lazy === false ? '' : "import('./lazy.js').then((m) => console.log(m.default));\n"
    }`,
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

describeReal('doctor on Vite worker builds (stamped by the upload catch-up)', () => {
  const workerApp = (name: string, form: 'url' | 'query'): { dir: string; out: string } => {
    const app = makeApp(name);
    writeFileSync(join(app.dir, 'w.js'), "postMessage('worker-ok');\n");
    writeFileSync(
      join(app.dir, 'index.js'),
      form === 'url'
        ? "const w = new Worker(new URL('./w.js', import.meta.url), { type: 'module' });\nw.onmessage = (e) => console.log(e.data);\n"
        : "import W from './w.js?worker';\nconst w = new W();\nw.onmessage = (e) => console.log(e.data);\n",
    );
    return app;
  };
  for (const [label, build] of [
    ['Vite 8 (Rolldown)', viteBuild],
    ['Vite 7 (Rollup)', vite7Build],
  ] as const) {
    for (const form of ['url', 'query'] as const) {
      it(`${label}, ${form} worker: main and worker bundles are stamped and their maps carry the same id`, async () => {
        const app = workerApp(`doc-worker-${label.replace(/\W+/g, '')}-${form}`, form);
        await build(viteConfig(app, [bugseeUnplugin.vite(pluginOptions()) as VitePlugin]));
        const report = await doctor(app.out);
        expect(report.summary.bundles).toBeGreaterThanOrEqual(2); // main + worker
        expect(report.summary.maps).toBe(report.summary.bundles);
        expect(idsOf(report, 'error')).toEqual([]);
        expect(idsOf(report, 'warning')).toEqual([]);
        expect(report.passed).toEqual(
          expect.arrayContaining(['stamp.map-id-mismatch', 'stamp.map-no-debug-id', 'stamp.mixed']),
        );
      });
    }
  }
});

describeReal('doctor on multi-output and nested-directory Rollup builds', () => {
  it('six outputs into one directory (maps kept) are all stamped, paired and clean', async () => {
    const app = makeApp('doc-many-outputs', { lazy: false });
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [bugseeRollupPlugin(pluginOptions())],
    });
    await Promise.all(
      names.map((n) =>
        bundle.write({
          file: join(app.out, `${n}.js`),
          format: 'iife',
          name: `app_${n}`,
          sourcemap: 'hidden',
        }),
      ),
    );
    await bundle.close();
    const report = await doctor(app.out);
    expect(report.summary).toMatchObject({ bundles: 6, maps: 6, errors: 0, warnings: 0 });
    expect(report.passed).toEqual(
      expect.arrayContaining(['stamp.map-id-mismatch', 'stamp.duplicate-debug-id']),
    );
  });

  it('an output nested inside another: checking the parent walks both and finds no problem', async () => {
    const app = makeApp('doc-nested-outputs', { lazy: false });
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [bugseeRollupPlugin(pluginOptions())],
    });
    await Promise.all([
      bundle.write({
        dir: app.out,
        entryFileNames: 'p.js',
        format: 'iife',
        name: 'p',
        sourcemap: 'hidden',
      }),
      bundle.write({
        dir: join(app.out, 'b'),
        entryFileNames: 'c.js',
        format: 'iife',
        name: 'c',
        sourcemap: 'hidden',
      }),
    ]);
    await bundle.close();
    const parent = await doctor(app.out);
    expect(parent.summary).toMatchObject({ bundles: 2, maps: 2, errors: 0, warnings: 0 });
    const nested = await doctor(join(app.out, 'b'));
    expect(nested.summary).toMatchObject({ bundles: 1, maps: 1, errors: 0, warnings: 0 });
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

// A barrel that re-exports dependencies is a FACADE chunk: Rollup writes `sources: []` and an empty `mappings` for it,
// and for CommonJS it writes the `export *` loop and the interop helpers in ES5 or (with generatedCode: 'es2015', which
// Vite 7 library mode uses) arrow form. The doctor must read every one of them as a facade, from the real emitted text.
describe('facade chunks in real Rollup / Vite output', () => {
  const sources = (dir: string): void => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'index.js'),
      "export * from 'ext-a';\nexport * as ns from 'ext-b';\nexport { named } from 'ext-c';\nexport { default as dflt } from 'ext-d';\nexport { u } from './util.js';\n",
    );
    writeFileSync(
      join(dir, 'src', 'util.js'),
      'export const u = () => { throw new Error("u"); };\n',
    );
  };
  const externals = ['ext-a', 'ext-b', 'ext-c', 'ext-d'];

  const check = async (out: string, indexFiles: string[]): Promise<void> => {
    const report = await diagnoseBuildOutput(out, { skipEnv: true, projectRoot: dirname(out) });
    for (const file of indexFiles) {
      const code = readFileSync(join(out, file), 'utf8');
      expect(isFacadeCode(code), `${file}:\n${code}`).toBe(true);
      const note = report.findings.find(
        (f) => f.id === 'map.no-sources' && f.file === `${file}.map`,
      );
      expect(note?.severity, `${file}.map`).toBe('info');
    }
    // the chunk with real code keeps a REAL map: it exists, it maps to original positions, and the doctor has
    // nothing to say against it
    const utilFiles = readdirSync(out).filter((f) => /^util\.(m?js|cjs)$/.test(f));
    expect(utilFiles.length, `util chunks in ${out}`).toBeGreaterThanOrEqual(1);
    for (const file of utilFiles) {
      const map = JSON.parse(readFileSync(join(out, `${file}.map`), 'utf8')) as {
        sources: string[];
        mappings: string;
      };
      expect(map.sources.length, `${file}.map sources`).toBeGreaterThan(0);
      expect(hasOriginalPosition(map.mappings, map.sources.length), `${file}.map mappings`).toBe(
        true,
      );
      expect(
        report.findings
          .filter((f) => f.file === `${file}.map` && f.id.startsWith('map.'))
          .map((f) => f.id),
      ).not.toContain('map.invalid');
      expect(
        report.findings.some((f) => f.id === 'map.no-sources' && f.file === `${file}.map`),
      ).toBe(false);
    }
    // and nothing here is an error about maps or sources
    expect(
      report.findings.filter((f) => f.id === 'map.no-sources' && f.severity === 'error'),
    ).toEqual([]);
    expect(report.findings.filter((f) => f.id === 'map.invalid')).toEqual([]);
  };

  for (const generatedCode of ['es5', 'es2015'] as const) {
    for (const format of ['es', 'cjs'] as const) {
      it(`Rollup ${format} with generatedCode ${generatedCode}`, async () => {
        const dir = join(root, `facade-rollup-${format}-${generatedCode}`);
        sources(dir);
        const bundle = await rollup({
          input: { index: join(dir, 'src', 'index.js'), util: join(dir, 'src', 'util.js') },
          external: externals,
        });
        const out = join(dir, 'dist');
        await bundle.write({ dir: out, format, sourcemap: true, generatedCode, interop: 'auto' });
        await bundle.close();
        await check(out, ['index.js']);
      });
    }
  }

  it('Vite 7 library mode (es + cjs, es2015 output) with a re-export barrel', async () => {
    const dir = join(root, 'facade-vite7');
    sources(dir);
    await vite7Build({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      build: {
        lib: {
          entry: { index: join(dir, 'src', 'index.js'), util: join(dir, 'src', 'util.js') },
          formats: ['es', 'cjs'],
        },
        sourcemap: true,
        minify: false,
        outDir: join(dir, 'dist'),
        rollupOptions: { external: externals },
      },
    });
    const files = readdirSync(join(dir, 'dist')).filter((f) => /^index\.(m?js|cjs)$/.test(f));
    expect(files.length).toBe(2);
    await check(join(dir, 'dist'), files);
  });

  // Rather than one shape per review: sweep Rollup's output options and require that EVERY emitted chunk whose map
  // has no sources and no segments reads as a facade (the doctor's empty-map rule depends on it).
  const sweep = async (format: 'cjs' | 'amd' | 'es' | 'system'): Promise<number> => {
    const dir = join(root, `facade-sweep-${format}`);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'index.js'),
      "export { a } from './main.js';\nexport * from 'ext-a';\nexport * as ns from 'ext-b';\nexport { default as d, named } from 'ext-c';\n",
    );
    writeFileSync(
      join(dir, 'src', 'other.js'),
      "import { a } from './main.js';\nconsole.log(a);\n",
    );
    writeFileSync(
      join(dir, 'src', 'main.js'),
      'export const a = () => { throw new Error("a"); };\n',
    );
    const bundle = await rollup({
      input: { index: join(dir, 'src', 'index.js'), other: join(dir, 'src', 'other.js') },
      external: ['ext-a', 'ext-b', 'ext-c'],
    });
    let facades = 0;
    const failures: string[] = [];
    const interops = ['auto', 'default', 'esModule', 'compat'] as const;
    for (const interop of interops) {
      for (const preset of ['es5', 'es2015'] as const) {
        for (const symbols of [false, true]) {
          for (const externalLiveBindings of [true, false]) {
            for (const freeze of [true, false]) {
              for (const esModule of [true, false, 'if-default-prop'] as const) {
                const label = JSON.stringify({
                  format,
                  interop,
                  preset,
                  symbols,
                  externalLiveBindings,
                  freeze,
                  esModule,
                });
                const { output } = await bundle.generate({
                  format,
                  sourcemap: true,
                  interop,
                  generatedCode: { preset, symbols },
                  externalLiveBindings,
                  freeze,
                  esModule,
                });
                for (const chunk of output) {
                  if (chunk.type !== 'chunk' || chunk.map === null || chunk.map === undefined) {
                    continue;
                  }
                  const empty = chunk.map.sources.length === 0 && !/[^;,]/.test(chunk.map.mappings);
                  if (!empty) {
                    continue;
                  }
                  facades++;
                  if (!isFacadeCode(chunk.code)) {
                    failures.push(`${label} ${chunk.fileName}:\n${chunk.code}`);
                  }
                }
              }
            }
          }
        }
      }
    }
    await bundle.close();
    expect(failures.slice(0, 2).join('\n\n')).toBe('');
    return facades;
  };

  for (const format of ['cjs', 'amd', 'es', 'system'] as const) {
    it(`every empty-map chunk Rollup writes for ${format} (option sweep) is a facade`, async () => {
      expect(await sweep(format)).toBeGreaterThan(100);
    }, 120_000);
  }
});
