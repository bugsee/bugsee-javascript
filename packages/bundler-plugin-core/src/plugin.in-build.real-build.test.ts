// Stamping INSIDE the build, end to end, with REAL bundlers and the REAL bugsee-cli: Vite 8 (Rolldown), Vite 7
// (Rollup), Rollup and Rspack, each with a step that pins Subresource Integrity hashes of what it emits.
//
// The claim under test is the one the post-emit design could not make: the hash the page pins is the hash of
// the bytes that are on disk, AFTER the debug-ID stamp, with the maps uploaded and removed. Where a real
// browser run (Chromium) is infeasible here, the emitted bytes are hash-verified against the pinned
// `integrity` with node:crypto — the same comparison the browser makes.
//
// Before this change the same builds were REFUSED by the SRI guard (nothing stamped, nothing uploaded, maps
// left on disk); the "post-emit fallback" test pins that this still holds when the in-build stamp is not
// possible.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { rspack } from '@rspack/core';
import { rollup } from 'rollup';
import { type Plugin as VitePlugin, build as viteBuild } from 'vite';
import { build as vite7Build } from 'vite7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bugseeRollupPlugin, bugseeRspackPlugin, bugseeUnplugin } from './plugin';
import { resolveBugseeCli } from './run-cli';
import { findIntegrityMismatches } from './sri';

let server: Server;
let endpoint: string;
const requests: Array<{ url: string; body: string }> = [];
/** The debug-id a stamped bundle on disk carries. */
const debugIdOf = (file: string): string =>
  /\/\/# debugId=([0-9a-f-]{36})/.exec(readFileSync(file, 'utf8'))?.[1] ?? '';

let root: string;

const cli = resolveBugseeCli();
const cliProbe = cli.endsWith('.js')
  ? spawnSync(process.execPath, [cli, '--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      killSignal: 'SIGKILL',
    })
  : spawnSync(cli, ['--version'], { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' });
const cliAvailable = cliProbe.status === 0;
const cliRequired = process.env.CI !== undefined || process.env.BUGSEE_REQUIRE_CLI !== undefined;
if (!cliAvailable && !cliRequired) {
  console.warn('[bugsee] bugsee-cli binary not available: skipping the in-build real-build tests');
}
const describeReal = cliAvailable || cliRequired ? describe : describe.skip;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'bugsee-in-build-'));
  // Every request is answered "already uploaded", so the upload succeeds without a backend.
  server = createServer((req, res) => {
    const entry = { url: req.url ?? '', body: '' };
    requests.push(entry);
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      entry.body = Buffer.concat(chunks).toString('latin1');
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

const pluginOptions = () => ({
  appToken: 'in-build-token',
  endpoint,
  vcs: false,
  registerBuild: false as const,
  failOnError: true,
});

/** An app with a page, an entry and a lazily loaded chunk. */
function makeApp(name: string, options: { lazy?: boolean } = {}): { dir: string; out: string } {
  const lazy = options.lazy ?? true;
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
      lazy ? "import('./lazy.js').then((m) => console.log(m.default));\n" : ''
    }`,
  );
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3' }));
  return { dir, out: join(dir, 'dist') };
}

const sri = (bytes: string | Buffer): string =>
  `sha384-${createHash('sha384').update(bytes).digest('base64')}`;

interface Pin {
  tag: string;
  file: string;
  integrity: string;
}

/** Every script / modulepreload in `<out>/index.html` with an integrity, resolved to its file in `out`. */
function pinsOf(out: string): Pin[] {
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  const pins: Pin[] = [];
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) ?? []) {
    const integrity = /\bintegrity="([^"]+)"/i.exec(tag)?.[1];
    const url = /\b(?:src|href)="([^"]+)"/i.exec(tag)?.[1];
    if (integrity !== undefined && url !== undefined) {
      pins.push({ tag, file: join(out, url.replace(/^\.?\//, '')), integrity });
    }
  }
  return pins;
}

/** The comparison the browser makes: the pinned digest against the digest of the bytes on disk. */
function expectPinsMatchDisk(out: string, atLeast = 1): void {
  const pins = pinsOf(out);
  expect(pins.length).toBeGreaterThanOrEqual(atLeast);
  for (const pin of pins) {
    expect(sri(readFileSync(pin.file)), `${pin.file} vs ${pin.integrity}`).toBe(pin.integrity);
  }
}

function expectStampedAndUploaded(out: string, before: number, atLeast = 2): void {
  const files = readdirSync(out, { recursive: true }) as string[];
  const bundles = files.filter((f) => /\.[cm]?js$/.test(f));
  expect(bundles.length).toBeGreaterThanOrEqual(atLeast); // entry (+ lazy chunk)
  for (const bundle of bundles) {
    const code = readFileSync(join(out, bundle), 'utf8');
    expect(code, bundle).toMatch(/\/\/# debugId=[0-9a-f-]{36}/);
    expect(code, bundle).toContain('_bugseeDebugIds');
  }
  // Uploaded, then the client maps were deleted.
  expect(requests.length).toBeGreaterThan(before);
  expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
}

/** Add `integrity` to every script / modulepreload tag whose file is a chunk of the bundle. */
function pinChunks(html: string, bundle: Record<string, { type: string; code?: string }>): string {
  return html.replace(
    /<(?:script|link)\b[^>]*?(?:src|href)="\.?\/?([^"]+\.js)"[^>]*>/gi,
    (tag, file: string) => {
      const entry = bundle[file];
      return entry?.type === 'chunk' && entry.code !== undefined
        ? tag.replace(/>$/, ` integrity="${sri(entry.code)}">`)
        : tag;
    },
  );
}

/** A hand-rolled SRI step for Vite that hashes in `transformIndexHtml`, as vite-plugin-sri does. */
const viteSri = (): VitePlugin => ({
  name: 'hand-rolled-sri',
  enforce: 'post',
  transformIndexHtml: {
    order: 'post',
    handler: (html, ctx) => pinChunks(html, (ctx.bundle ?? {}) as never),
  },
});

/** A hand-rolled SRI step that hashes LAST, in generateBundle (order post), into the emitted page. */
const viteLateSri = (): VitePlugin => ({
  name: 'hand-rolled-late-sri',
  enforce: 'post',
  generateBundle: {
    order: 'post',
    handler(_options, bundle) {
      const page = bundle['index.html'];
      if (page?.type === 'asset') {
        page.source = pinChunks(String(page.source), bundle as never);
      }
    },
  },
});

const viteConfig = (app: { dir: string; out: string }, plugins: unknown[], build: object = {}) =>
  ({
    root: app.dir,
    configFile: false,
    logLevel: 'silent',
    base: './',
    plugins,
    build: { outDir: app.out, emptyOutDir: true, minify: false, sourcemap: true, ...build },
  }) as never;

const bugseeVite = (extra: object = {}) =>
  bugseeUnplugin.vite({ ...pluginOptions(), ...extra }) as VitePlugin;

describeReal('real Vite builds with an SRI step', () => {
  for (const [label, build] of [
    ['Vite 8 (Rolldown)', viteBuild],
    ['Vite 7 (Rollup)', vite7Build],
  ] as const) {
    const slug = label.replace(/\W+/g, '');

    it(`${label}: an SRI step in transformIndexHtml pins the STAMPED bytes; maps uploaded and removed`, async () => {
      const app = makeApp(`vite-html-${slug}`, { lazy: false });
      const before = requests.length;
      const warnings: unknown[] = [];
      await build(
        viteConfig(app, [
          bugseeVite({ failOnError: false, onError: (e: unknown) => warnings.push(e) }),
          viteSri(),
        ]),
      );
      expect(warnings).toEqual([]);
      expectStampedAndUploaded(app.out, before, 1);
      expectPinsMatchDisk(app.out);
      expect(await findIntegrityMismatches(app.out)).toEqual([]);
    });

    it(`${label}: an app with a lazy chunk and an SRI step that hashes last (generateBundle, post)`, async () => {
      const app = makeApp(`vite-late-${slug}`);
      const before = requests.length;
      const warnings: unknown[] = [];
      await build(
        viteConfig(app, [
          bugseeVite({ failOnError: false, onError: (e: unknown) => warnings.push(e) }),
          viteLateSri(),
        ]),
      );
      expect(warnings.map(String)).toEqual([]);
      expectStampedAndUploaded(app.out, before);
      expectPinsMatchDisk(app.out);
      expect(await findIntegrityMismatches(app.out)).toEqual([]);
    });
  }

  it('Vite 8: the match is not an accident of nothing being stamped (a disabled build pins other bytes)', async () => {
    const stamped = makeApp('vite-compare-stamped', { lazy: false });
    const plain = makeApp('vite-compare-plain', { lazy: false });
    for (const [app, disabled] of [
      [stamped, false],
      [plain, true],
    ] as const) {
      await viteBuild(viteConfig(app, [bugseeVite({ disabled }), viteSri()]));
    }
    const entry = (out: string): string =>
      readFileSync(
        join(
          out,
          'assets',
          readdirSync(join(out, 'assets')).find((f) => f.endsWith('.js')) as string,
        ),
        'utf8',
      );
    expect(entry(stamped.out)).toContain('debugId');
    expect(entry(plain.out)).not.toContain('debugId');
    expectPinsMatchDisk(stamped.out);
    expectPinsMatchDisk(plain.out);
    expect(pinsOf(stamped.out)[0]?.integrity).not.toBe(pinsOf(plain.out)[0]?.integrity);
  });

  it('Vite 8: a build whose maps cannot be stamped in memory (inline) falls back to post-emit, where the SRI guard still refuses', async () => {
    const app = makeApp('vite-inline', { lazy: false });
    const before = requests.length;
    const errors: unknown[] = [];
    const notices: string[] = [];
    await viteBuild(
      viteConfig(
        app,
        [
          bugseeVite({
            failOnError: false,
            onError: (e: unknown) => errors.push(e),
            onNotice: (m: string) => notices.push(m),
          }),
          viteSri(),
        ],
        { sourcemap: 'inline' },
      ),
    );
    expect(notices.join('\n')).toContain('after emit');
    expect(errors.map(String).join('\n')).toContain('refusing to stamp debug-IDs');
    // Nothing stamped, nothing uploaded, and the page's pins are intact.
    expect(requests.length).toBe(before);
    for (const f of readdirSync(join(app.out, 'assets'))) {
      expect(readFileSync(join(app.out, 'assets', f), 'utf8')).not.toContain('_bugseeDebugIds');
    }
    expectPinsMatchDisk(app.out);
  });
});

describeReal('real Rollup build with an SRI step', () => {
  it('the pinned hashes match the STAMPED bytes, maps uploaded and removed', async () => {
    const app = makeApp('rollup-sri');
    const before = requests.length;
    const sriHtml = {
      name: 'sri-html',
      generateBundle(
        this: { emitFile(file: object): void },
        _output: unknown,
        bundle: Record<
          string,
          { type: string; code?: string; isEntry?: boolean; fileName: string }
        >,
      ) {
        const tags = Object.values(bundle)
          .filter((entry) => entry.type === 'chunk')
          .map((entry) =>
            entry.isEntry
              ? `<script type="module" src="./${entry.fileName}" integrity="${sri(entry.code as string)}"></script>`
              : `<link rel="modulepreload" href="./${entry.fileName}" integrity="${sri(entry.code as string)}">`,
          );
        this.emitFile({
          type: 'asset',
          fileName: 'index.html',
          source: `<!doctype html><html><head></head><body>${tags.join('')}</body></html>`,
        });
      },
    };
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [bugseeRollupPlugin({ ...pluginOptions() }), sriHtml],
    });
    await bundle.write({ dir: app.out, sourcemap: true });
    await bundle.close();
    expectStampedAndUploaded(app.out, before);
    expectPinsMatchDisk(app.out, 2);
    expect(await findIntegrityMismatches(app.out)).toEqual([]);
  });
});

describeReal('real Rspack build with the built-in SubresourceIntegrityPlugin', () => {
  function runRspack(config: Parameters<typeof rspack>[0]): Promise<{ errors: unknown[] }> {
    return new Promise((resolve, reject) => {
      const compiler = rspack(config);
      compiler.run((err, stats) => {
        compiler.close(() => {
          if (err) {
            reject(err);
          } else {
            resolve({
              errors: (stats as { compilation: { errors: unknown[] } }).compilation.errors,
            });
          }
        });
      });
    });
  }

  it('the pinned hashes (page AND the lazy-chunk table in the runtime) match the STAMPED bytes', async () => {
    const app = makeApp('rspack-sri-built-in');
    const before = requests.length;
    const warnings: unknown[] = [];
    const { errors } = await runRspack({
      context: app.dir,
      mode: 'production',
      entry: join(app.dir, 'index.js'),
      devtool: 'source-map',
      output: { path: app.out, crossOriginLoading: 'anonymous' },
      plugins: [
        bugseeRspackPlugin({ ...pluginOptions(), onError: (e: unknown) => warnings.push(e) }),
        new rspack.HtmlRspackPlugin({
          template: join(app.dir, 'index.html'),
          scriptLoading: 'defer',
        }),
        new rspack.SubresourceIntegrityPlugin({ hashFuncNames: ['sha384'] }),
      ],
    });
    console.log('RSERR', errors.map(String));
    expect(errors.map((e) => String((e as Error).message ?? e))).toEqual([]);
    expect(warnings.map(String)).toEqual([]);
    expectStampedAndUploaded(app.out, before);
    expectPinsMatchDisk(app.out);
    expect(await findIntegrityMismatches(app.out)).toEqual([]);
    // The lazy chunk is not in the HTML; the plugin embeds ITS hash in the runtime. That hash must be of the
    // stamped bytes too, or `import()` of the chunk fails in the browser.
    const files = readdirSync(app.out).filter((f) => f.endsWith('.js'));
    const runtimeText = files.map((f) => readFileSync(join(app.out, f), 'utf8')).join('\n');
    const pinned = new Set(pinsOf(app.out).map((pin) => pin.file));
    const lazy = files.filter((f) => !pinned.has(join(app.out, f)));
    expect(lazy.length).toBeGreaterThan(0);
    for (const f of lazy) {
      expect(runtimeText, `${f} hash is in the runtime table`).toContain(
        createHash('sha384')
          .update(readFileSync(join(app.out, f)))
          .digest('base64'),
      );
    }
    expect(existsSync(join(app.out, 'index.html'))).toBe(true);
  });
});

// A script that is NOT part of the bundle (a `publicDir` copy, a stale file with `emptyOutDir: false`) has no
// debug-id, and the real bugsee-cli exits non-zero for a directory that holds a map without one ("nothing was
// uploaded"). Uploading the DIRECTORY would therefore lose every map of the build; the pre-stamped path names
// its files instead. Real CLI, no --dry-run, failOnError on.
describeReal('an unstamped vendor script + map beside a stamped build', () => {
  const VENDOR_MAP = '{"version":3,"sources":["vendor.src.js"],"names":[],"mappings":"AAAA"}';
  const addVendor = (dir: string): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'vendor.js'),
      'window.__vendor = 1;\n//# sourceMappingURL=vendor.js.map\n',
    );
    writeFileSync(join(dir, 'vendor.js.map'), VENDOR_MAP);
  };
  const expectVendorUntouched = (out: string): void => {
    expect(readFileSync(join(out, 'vendor.js.map'), 'utf8')).toBe(VENDOR_MAP);
    expect(readFileSync(join(out, 'vendor.js'), 'utf8')).not.toContain('debugId');
  };

  for (const [label, build] of [
    ['Vite 8 (Rolldown)', viteBuild],
    ['Vite 7 (Rollup)', vite7Build],
  ] as const) {
    it(`${label}: publicDir/vendor.js is left alone and said; the stamped maps still upload; failOnError does not fail`, async () => {
      const app = makeApp(`vite-vendor-${label.replace(/\W+/g, '')}`, { lazy: false });
      addVendor(join(app.dir, 'public'));
      const before = requests.length;
      const notices: string[] = [];
      const errors: unknown[] = [];
      await build(
        viteConfig(app, [
          bugseeVite({
            onNotice: (m: string) => notices.push(m),
            onError: (e: unknown) => errors.push(e),
          }),
        ]),
      );
      expect(errors.map(String)).toEqual([]);
      expect(requests.length).toBeGreaterThan(before);
      expect(readdirSync(join(app.out, 'assets')).filter((f) => f.endsWith('.map'))).toEqual([]);
      expectVendorUntouched(app.out);
      expect(notices.join('\n')).toContain('vendor.js.map');
    });
  }

  it('Rollup: a stale vendor script in the output directory is left alone and said', async () => {
    const app = makeApp('rollup-vendor');
    addVendor(app.out);
    const before = requests.length;
    const notices: string[] = [];
    const errors: unknown[] = [];
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [
        bugseeRollupPlugin({
          ...pluginOptions(),
          onNotice: (m: string) => notices.push(m),
          onError: (e: unknown) => errors.push(e),
        }),
      ],
    });
    await bundle.write({ dir: app.out, sourcemap: true });
    await bundle.close();
    expect(errors.map(String)).toEqual([]);
    expect(requests.length).toBeGreaterThan(before);
    const maps = readdirSync(app.out).filter((f) => f.endsWith('.map'));
    expect(maps).toEqual(['vendor.js.map']);
    expectVendorUntouched(app.out);
    expect(notices.join('\n')).toContain('vendor.js.map');
  });
});

// The stamp keys a map whatever it is called (`sourcemapFileName(s)`, `[name].map`), so the upload set must be
// everything the CLI scans a directory for, not just `*.js.map`, and a map is deleted only if it was uploaded.
// Real bugsee-cli, no dry run.
describeReal('maps with custom names (sourcemapFileNames: "[name].map")', () => {
  for (const failOnError of [true, false]) {
    const tag = `failOnError ${failOnError}`;
    const expectUploadedAndGone = (out: string, before: number): void => {
      const files = readdirSync(out, { recursive: true }) as string[];
      expect(requests.length, 'uploaded').toBeGreaterThan(before);
      expect(
        files.filter((f) => f.endsWith('.map')),
        'deleted after the confirmed upload',
      ).toEqual([]);
      for (const bundle of files.filter((f) => /\.[cm]?js$/.test(f))) {
        const code = readFileSync(join(out, bundle), 'utf8');
        expect(code, bundle).toMatch(/\/\/# debugId=[0-9a-f-]{36}/);
        expect(code, bundle).toMatch(/sourceMappingURL=[^\s]*\.map(?!\.)/);
        expect(code, bundle).not.toMatch(/sourceMappingURL=[^\s]*\.js\.map/);
      }
    };

    it(`Rollup (${tag})`, async () => {
      const app = makeApp(`rollup-custom-${failOnError}`, { lazy: false });
      const before = requests.length;
      const errors: unknown[] = [];
      const bundle = await rollup({
        input: join(app.dir, 'index.js'),
        plugins: [
          bugseeRollupPlugin({
            ...pluginOptions(),
            failOnError,
            onError: (e: unknown) => errors.push(e),
          }),
        ],
      });
      await bundle.write({ dir: app.out, sourcemap: true, sourcemapFileNames: '[name].map' });
      await bundle.close();
      expect(errors.map(String)).toEqual([]);
      expectUploadedAndGone(app.out, before);
    });

    for (const [label, build] of [
      ['Vite 8 (Rolldown)', viteBuild],
      ['Vite 7 (Rollup)', vite7Build],
    ] as const) {
      it(`${label} (${tag})`, async () => {
        const app = makeApp(`vite-custom-${label.replace(/\W+/g, '')}-${failOnError}`, {
          lazy: false,
        });
        const before = requests.length;
        const errors: unknown[] = [];
        await build(
          viteConfig(app, [bugseeVite({ failOnError, onError: (e: unknown) => errors.push(e) })], {
            rollupOptions: { output: { sourcemapFileNames: 'assets/[name].map' } },
          }),
        );
        expect(errors.map(String)).toEqual([]);
        expectUploadedAndGone(app.out, before);
      });
    }

    it(`Rspack (${tag})`, async () => {
      const app = makeApp(`rspack-custom-${failOnError}`, { lazy: false });
      const before = requests.length;
      const errors: unknown[] = [];
      const compile = await new Promise<{ errors: unknown[] }>((resolve, reject) => {
        const compiler = rspack({
          context: app.dir,
          mode: 'production',
          entry: join(app.dir, 'index.js'),
          devtool: false,
          output: { path: app.out },
          plugins: [
            new rspack.SourceMapDevToolPlugin({ filename: '[name].map' }),
            bugseeRspackPlugin({
              ...pluginOptions(),
              failOnError,
              onError: (e: unknown) => errors.push(e),
            }),
          ],
        });
        compiler.run((err, stats) => {
          compiler.close(() =>
            err
              ? reject(err)
              : resolve({
                  errors: [...(stats as { compilation: { errors: unknown[] } }).compilation.errors],
                }),
          );
        });
      });
      expect(compile.errors.map(String)).toEqual([]);
      expect(errors.map(String)).toEqual([]);
      expectUploadedAndGone(app.out, before);
    });
  }
});

// A stylesheet map is never uploaded, but it embeds the source: it is still deleted with the rest.
describeReal('a stylesheet map beside the stamped maps (Rspack, [file].map)', () => {
  it('uploads the keyed js map and deletes the css map too (real CLI, failOnError on)', async () => {
    const app = makeApp('rspack-css', { lazy: false });
    writeFileSync(join(app.dir, 'style.css'), 'body { color: red; }\n');
    writeFileSync(join(app.dir, 'index.js'), "import './style.css';\nconsole.log('css');\n");
    const before = requests.length;
    const errors: unknown[] = [];
    const out = await new Promise<{ errors: unknown[]; files: string[] }>((resolve, reject) => {
      const compiler = rspack({
        context: app.dir,
        mode: 'production',
        entry: join(app.dir, 'index.js'),
        devtool: false,
        output: { path: app.out },
        module: { rules: [{ test: /\.css$/, type: 'css' }] },
        experiments: { css: true },
        plugins: [
          new rspack.SourceMapDevToolPlugin({ filename: '[file].map' }),
          bugseeRspackPlugin({ ...pluginOptions(), onError: (e: unknown) => errors.push(e) }),
        ],
      });
      compiler.run((err, stats) => {
        compiler.close(() =>
          err
            ? reject(err)
            : resolve({
                errors: [...(stats as { compilation: { errors: unknown[] } }).compilation.errors],
                files: readdirSync(app.out),
              }),
        );
      });
    });
    expect(out.errors.map(String)).toEqual([]);
    expect(errors.map(String)).toEqual([]);
    expect(requests.length, 'the keyed js map was uploaded').toBeGreaterThan(before);
    expect(out.files.some((f) => f.endsWith('.css'))).toBe(true);
    expect(out.files.filter((f) => f.endsWith('.map'))).toEqual([]);
  });
});

// A map can be MOVED by `sourcemapFileNames` (another directory of the output). inject pairs a staged bundle
// with its map by the sourceMappingURL comment or the sibling name, so the stamp must make the pairing work
// for any location, or the bundle is stamped with an id that is never uploaded and the map is left behind.
describeReal('maps moved to another directory (sourcemapFileNames: "maps/[name].js.map")', () => {
  const shapes = [
    ['same directory tree, maps/ beside the bundles', {}],
    [
      'bundles in js/, maps in maps/',
      { entryFileNames: 'js/[name].js', chunkFileNames: 'js/[name].js' },
    ],
  ] as const;
  for (const failOnError of [true, false]) {
    for (const [shape, extraOutput] of shapes) {
      const tag = `${shape}, failOnError ${failOnError}`;
      const check = (out: string, before: number, notices: string[], errors: unknown[]): void => {
        const files = readdirSync(out, { recursive: true }) as string[];
        expect(errors.map(String)).toEqual([]);
        expect(notices.join('\n')).not.toContain('not part of this build');
        expect(requests.length, 'uploaded').toBeGreaterThan(before);
        expect(
          files.filter((f) => f.endsWith('.map')),
          'maps deleted after the upload',
        ).toEqual([]);
        const bundles = files.filter((f) => /\.[cm]?js$/.test(f));
        expect(bundles.length).toBeGreaterThan(0);
        for (const bundle of bundles) {
          expect(readFileSync(join(out, bundle), 'utf8'), bundle).toMatch(
            /\/\/# debugId=[0-9a-f-]{36}/,
          );
        }
      };

      it(`Rollup (${tag})`, async () => {
        const app = makeApp(`rollup-moved-${shape.length}-${failOnError}`, { lazy: false });
        const before = requests.length;
        const [notices, errors]: [string[], unknown[]] = [[], []];
        const bundle = await rollup({
          input: join(app.dir, 'index.js'),
          plugins: [
            bugseeRollupPlugin({
              ...pluginOptions(),
              failOnError,
              onNotice: (m: string) => notices.push(m),
              onError: (e: unknown) => errors.push(e),
            }),
          ],
        });
        await bundle.write({
          dir: app.out,
          sourcemap: true,
          sourcemapFileNames: 'maps/[name].js.map',
          ...extraOutput,
        });
        await bundle.close();
        check(app.out, before, notices, errors);
      });

      for (const [label, build] of [
        ['Vite 8 (Rolldown)', viteBuild],
        ['Vite 7 (Rollup)', vite7Build],
      ] as const) {
        it(`${label} (${tag})`, async () => {
          const app = makeApp(
            `vite-moved-${label.replace(/\W+/g, '')}-${shape.length}-${failOnError}`,
            { lazy: false },
          );
          const before = requests.length;
          const [notices, errors]: [string[], unknown[]] = [[], []];
          await build(
            viteConfig(
              app,
              [
                bugseeVite({
                  failOnError,
                  onNotice: (m: string) => notices.push(m),
                  onError: (e: unknown) => errors.push(e),
                }),
              ],
              {
                rollupOptions: {
                  output: { sourcemapFileNames: 'maps/[name].js.map', ...extraOutput },
                },
              },
            ),
          );
          check(app.out, before, notices, errors);
        });
      }
    }
  }
});

// The CLI's directory scan has no depth limit and inject stamps a bundle however deep it is.
describeReal('a bundle deeper than the walk depth cap', () => {
  it('Rollup: entryFileNames a/b/c/d/e/f/g/[name].js is stamped, uploaded and its map deleted', async () => {
    const app = makeApp('rollup-deep', { lazy: false });
    const before = requests.length;
    const [notices, errors]: [string[], unknown[]] = [[], []];
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [
        bugseeRollupPlugin({
          ...pluginOptions(),
          onNotice: (m: string) => notices.push(m),
          onError: (e: unknown) => errors.push(e),
        }),
      ],
    });
    await bundle.write({
      dir: app.out,
      sourcemap: true,
      entryFileNames: 'a/b/c/d/e/f/g/[name].js',
    });
    await bundle.close();
    expect(errors.map(String)).toEqual([]);
    expect(notices).toEqual([]);
    expect(requests.length).toBeGreaterThan(before);
    const files = readdirSync(app.out, { recursive: true }) as string[];
    expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
    expect(readFileSync(join(app.out, 'a/b/c/d/e/f/g/index.js'), 'utf8')).toMatch(/debugId=/);
  });
});

// Maps this build did not produce, in directories that are not its output, must survive (the CLI's directory
// scan reaches them; deleting them is not this build's business).
describeReal('foreign css/declaration maps in an existing output directory', () => {
  it("Rollup: dist/node_modules, src, dot-dirs are untouched; this build's own maps are gone", async () => {
    const app = makeApp('rollup-foreign', { lazy: false });
    const foreign = [
      'node_modules/pkg/style.css.map',
      'node_modules/pkg/types.d.ts.map',
      '.cache/x.d.ts.map',
      'src/old.d.ts.map',
    ];
    for (const rel of foreign) {
      mkdirSync(join(app.out, rel, '..'), { recursive: true });
      writeFileSync(join(app.out, rel), '{}');
    }
    const before = requests.length;
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [bugseeRollupPlugin(pluginOptions())],
    });
    await bundle.write({ dir: app.out, sourcemap: true });
    await bundle.close();
    expect(requests.length).toBeGreaterThan(before);
    const left = (readdirSync(app.out, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.map'))
      .sort();
    expect(left).toEqual([...foreign].sort());
  });
});

// A map the bundle points at but that cannot be stamped with it (outside the output, or an unencoded space) must
// never leave a stamped bundle whose id never reaches its map: the stamp is refused/restored and reported.
describeReal('Rspack: a source map the stamp cannot reach', () => {
  const build = (
    app: { dir: string; out: string },
    output: object,
    filename: string,
    failOnError: boolean,
    errors: unknown[],
  ) =>
    new Promise<{ errors: unknown[] }>((resolve, reject) => {
      const compiler = rspack({
        context: app.dir,
        mode: 'production',
        entry: join(app.dir, 'index.js'),
        devtool: false,
        output: { path: app.out, ...output },
        plugins: [
          new rspack.SourceMapDevToolPlugin({ filename }),
          bugseeRspackPlugin({
            ...pluginOptions(),
            failOnError,
            onError: (e: unknown) => errors.push(e),
          }),
        ],
      });
      compiler.run((err, stats) => {
        compiler.close(() =>
          err
            ? reject(err)
            : resolve({
                errors: [...(stats as { compilation: { errors: unknown[] } }).compilation.errors],
              }),
        );
      });
    });

  it('a map OUTSIDE the output directory: nothing is stamped or uploaded, and it is said (never a silent half-stamp)', async () => {
    const app = makeApp('rspack-outside', { lazy: false });
    const before = requests.length;
    const errors: unknown[] = [];
    await build(app, { filename: 'js/[name].js' }, '../maps/[file].map', false, errors);
    expect(errors.map((e) => String((e as Error).message ?? e)).join('\n')).toContain(
      'outside the output directory',
    );
    expect(readFileSync(join(app.out, 'js', 'main.js'), 'utf8')).not.toContain('debugId');
    expect(requests.length).toBe(before);
  });

  it('a map OUTSIDE the output directory fails the build under failOnError', async () => {
    const app = makeApp('rspack-outside-strict', { lazy: false });
    const before = requests.length;
    await expect(
      build(app, { filename: 'js/[name].js' }, '../maps/[file].map', true, []),
    ).rejects.toThrow(/outside the output directory/);
    expect(requests.length).toBe(before);
  });

  it('a map under a directory with a space, pointer emitted unencoded: stamped (mapOf) and uploaded', async () => {
    const app = makeApp('rspack-space', { lazy: false });
    const before = requests.length;
    const errors: unknown[] = [];
    const result = await build(
      app,
      { filename: 'j s/[name].js' },
      'my maps/[file].map',
      true,
      errors,
    );
    expect(result.errors.map(String)).toEqual([]);
    expect(errors.map(String)).toEqual([]);
    expect(requests.length).toBeGreaterThan(before);
    const files = readdirSync(app.out, { recursive: true }) as string[];
    expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
    expect(readFileSync(join(app.out, 'j s', 'main.js'), 'utf8')).toMatch(/debugId=/);
  });

  it('a map moved into another directory of the output (maps/[file].map, bundles in js/): stamped and uploaded', async () => {
    const app = makeApp('rspack-moved', { lazy: false });
    const before = requests.length;
    const errors: unknown[] = [];
    const result = await build(app, { filename: 'js/[name].js' }, 'maps/[file].map', true, errors);
    expect(result.errors.map(String)).toEqual([]);
    expect(errors.map(String)).toEqual([]);
    expect(requests.length).toBeGreaterThan(before);
    expect(
      (readdirSync(app.out, { recursive: true }) as string[]).filter((f) => f.endsWith('.map')),
    ).toEqual([]);
  });
});

// Identity, not directory names: this build's own css/declaration maps are deleted wherever they are (even under
// dist/src from preserveModules), and files it did not emit are never deleted, even under an innocent name.
describeReal('ownership: only what this build emitted is deleted', () => {
  const seed = (out: string, rels: string[]): void => {
    for (const rel of rels) {
      mkdirSync(join(out, rel, '..'), { recursive: true });
      writeFileSync(join(out, rel), '{}');
    }
  };
  const mapsLeft = (out: string): string[] =>
    (readdirSync(out, { recursive: true }) as string[]).filter((f) => f.endsWith('.map')).sort();
  const emitExtraMaps = (names: string[]) => ({
    name: 'emit-extra-maps',
    generateBundle(this: { emitFile(f: object): void }) {
      for (const fileName of names) {
        this.emitFile({ type: 'asset', fileName, source: '{}' });
      }
    },
  });

  it('Rollup preserveModules: dist/src/** css + declaration maps of THIS build are deleted; seeded foreign ones survive', async () => {
    const app = makeApp('rollup-own', { lazy: false });
    const foreign = ['node_modules/pkg/style.css.map', '.cache/x.d.ts.map', 'src/old.d.ts.map'];
    seed(app.out, foreign);
    const before = requests.length;
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [
        bugseeRollupPlugin(pluginOptions()),
        emitExtraMaps(['src/style.css.map', 'src/a.d.ts.map']),
      ],
    });
    await bundle.write({
      dir: app.out,
      sourcemap: true,
      preserveModules: true,
      entryFileNames: 'src/[name].js',
    });
    await bundle.close();
    expect(requests.length).toBeGreaterThan(before);
    expect(mapsLeft(app.out)).toEqual([...foreign].sort());
  });

  it('Vite 8: foreign public/vendor/bootstrap.css.map and a foreign KEYED public/x.js.map are not deleted', async () => {
    const app = makeApp('vite-own', { lazy: false });
    mkdirSync(join(app.dir, 'public', 'vendor'), { recursive: true });
    writeFileSync(join(app.dir, 'public', 'vendor', 'bootstrap.css.map'), '{}');
    writeFileSync(
      join(app.dir, 'public', 'x.js.map'),
      '{"version":3,"debugId":"b039c7fb-d958-5fe6-b76f-136179e9a728"}',
    );
    const notices: string[] = [];
    const before = requests.length;
    await viteBuild(viteConfig(app, [bugseeVite({ onNotice: (m: string) => notices.push(m) })]));
    expect(requests.length).toBeGreaterThan(before);
    expect(mapsLeft(app.out)).toEqual(['vendor/bootstrap.css.map', 'x.js.map']);
    expect(notices.join('\n')).toContain('x.js.map');
  });

  it("Rspack: a pre-seeded foreign css map survives, this build's own js map is deleted", async () => {
    const app = makeApp('rspack-own', { lazy: false });
    seed(app.out, ['vendor/foreign.css.map', 'src/old.d.ts.map']);
    const before = requests.length;
    const compile = await new Promise<void>((resolve, reject) => {
      const compiler = rspack({
        context: app.dir,
        mode: 'production',
        entry: join(app.dir, 'index.js'),
        devtool: 'source-map',
        output: { path: app.out },
        plugins: [bugseeRspackPlugin(pluginOptions())],
      });
      compiler.run((err) => compiler.close(() => (err ? reject(err) : resolve())));
    });
    void compile;
    expect(requests.length).toBeGreaterThan(before);
    expect(mapsLeft(app.out)).toEqual(['src/old.d.ts.map', 'vendor/foreign.css.map']);
  });
});

// webpack/Rspack asset names can carry a ?query (`[name].js?[contenthash]`); the disk name does not. The stamp
// must match, stage and write back through the query, and the deletion by identity must too.
describeReal('Rspack: asset names with a ?query', () => {
  for (const failOnError of [true, false]) {
    it(`[name].js?[contenthash] and a chunkFilename query: stamped, uploaded, all of this build's maps deleted (failOnError ${failOnError})`, async () => {
      const app = makeApp(`rspack-query-${failOnError}`);
      const before = requests.length;
      const errors: unknown[] = [];
      const result = await new Promise<{ errors: unknown[] }>((resolve, reject) => {
        const compiler = rspack({
          context: app.dir,
          mode: 'production',
          entry: join(app.dir, 'index.js'),
          devtool: 'source-map',
          output: {
            path: app.out,
            filename: '[name].js?[contenthash]',
            chunkFilename: '[name].js?[contenthash]',
          },
          plugins: [
            bugseeRspackPlugin({
              ...pluginOptions(),
              failOnError,
              onError: (e: unknown) => errors.push(e),
            }),
          ],
        });
        compiler.run((err, stats) =>
          compiler.close(() =>
            err
              ? reject(err)
              : resolve({
                  errors: [...(stats as { compilation: { errors: unknown[] } }).compilation.errors],
                }),
          ),
        );
      });
      expect(result.errors.map(String)).toEqual([]);
      expect(errors.map(String)).toEqual([]);
      expect(requests.length, 'uploaded').toBeGreaterThan(before);
      const files = readdirSync(app.out, { recursive: true }) as string[];
      expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
      const bundles = files.filter((f) => /\.js$/.test(f));
      expect(bundles.length).toBeGreaterThanOrEqual(2);
      for (const bundle of bundles) {
        expect(readFileSync(join(app.out, bundle), 'utf8'), bundle).toMatch(/\/\/# debugId=/);
      }
    });
  }
});

// GROUND TRUTH: webpack/Rspack write `a#1.js` as `a#1.js` (the `#` stays); only `?...` is dropped.
describeReal('Rspack: # in a file name is part of the name', () => {
  const run = (
    app: { dir: string; out: string },
    filename: unknown,
    failOnError: boolean,
    errors: unknown[],
  ) =>
    new Promise<{ errors: unknown[] }>((resolve, reject) => {
      writeFileSync(join(app.dir, 'other.js'), "console.log('other');\n");
      const compiler = rspack({
        context: app.dir,
        mode: 'production',
        entry: { main: join(app.dir, 'index.js'), a: join(app.dir, 'other.js') },
        devtool: 'source-map',
        output: { path: app.out, filename: filename as never },
        plugins: [
          bugseeRspackPlugin({
            ...pluginOptions(),
            failOnError,
            onError: (e: unknown) => errors.push(e),
          }),
        ],
      });
      compiler.run((err, stats) =>
        compiler.close(() =>
          err
            ? reject(err)
            : resolve({
                errors: [...(stats as { compilation: { errors: unknown[] } }).compilation.errors],
              }),
        ),
      );
    });
  const expectAllStampedAndGone = (out: string, before: number, atLeast: number): void => {
    const files = readdirSync(out, { recursive: true }) as string[];
    expect(requests.length, 'uploaded').toBeGreaterThan(before);
    expect(
      files.filter((f) => f.endsWith('.map')),
      'every own map deleted',
    ).toEqual([]);
    const bundles = files.filter((f) => /\.js$/.test(f));
    expect(bundles.length).toBeGreaterThanOrEqual(atLeast);
    for (const bundle of bundles) {
      expect(readFileSync(join(out, bundle), 'utf8'), bundle).toMatch(/\/\/# debugId=/);
    }
  };

  for (const failOnError of [true, false]) {
    it(`one entry emitted as a#1.js beside normal bundles (failOnError ${failOnError})`, async () => {
      const app = makeApp(`rspack-hash-mixed-${failOnError}`, { lazy: false });
      const before = requests.length;
      const errors: unknown[] = [];
      const result = await run(
        app,
        (p: { chunk?: { name?: string } }) => (p.chunk?.name === 'a' ? 'a#1.js' : '[name].js'),
        failOnError,
        errors,
      );
      expect(result.errors.map(String)).toEqual([]);
      expect(errors.map(String)).toEqual([]);
      expect(readdirSync(app.out)).toContain('a#1.js');
      expectAllStampedAndGone(app.out, before, 2);
    });

    it(`every file named [name]#[contenthash:6].js (failOnError ${failOnError})`, async () => {
      const app = makeApp(`rspack-hash-all-${failOnError}`, { lazy: false });
      const before = requests.length;
      const errors: unknown[] = [];
      const result = await run(app, '[name]#[contenthash:6].js', failOnError, errors);
      expect(result.errors.map(String)).toEqual([]);
      expect(errors.map(String)).toEqual([]);
      expectAllStampedAndGone(app.out, before, 2);
    });
  }
});

// Vite builds a worker through its OWN sub-build and then copies the worker code into the main output while
// REGENERATING the worker's `.map` (Vite 8) or emitting both after our generateBundle (Vite 7): the worker file is
// stamped without its map carrying the id, or not stamped at all. The upload catches up the build's OWN unkeyed
// script maps (inject is idempotent on an already-stamped bundle and puts its id in the map).
describeReal('Vite workers: the worker bundle and its map carry the same debug-id', () => {
  const workerApp = (name: string, form: 'url' | 'query'): { dir: string; out: string } => {
    const app = makeApp(name, { lazy: false });
    writeFileSync(join(app.dir, 'w.js'), "postMessage('worker-ok');\n");
    writeFileSync(
      join(app.dir, 'index.js'),
      form === 'url'
        ? "const w = new Worker(new URL('./w.js', import.meta.url), { type: 'module' });\nw.onmessage = (e) => console.log(e.data);\n"
        : "import W from './w.js?worker';\nconst w = new W();\nw.onmessage = (e) => console.log(e.data);\n",
    );
    return app;
  };
  const idOf = (code: string): string | undefined =>
    /\/\/# debugId=([0-9a-f-]{36})/.exec(code)?.[1];

  for (const [label, build] of [
    ['Vite 8 (Rolldown)', viteBuild],
    ['Vite 7 (Rollup)', vite7Build],
  ] as const) {
    for (const form of ['url', 'query'] as const) {
      for (const failOnError of [true, false]) {
        it(`${label}, ${form} worker (failOnError ${failOnError}): stamped, same id in its map, uploaded and deleted`, async () => {
          const app = workerApp(
            `vite-worker-${label.replace(/\W+/g, '')}-${form}-${failOnError}`,
            form,
          );
          const before = requests.length;
          const errors: unknown[] = [];
          // Keep the maps for the first build so their ids can be compared.
          await build(
            viteConfig(app, [
              bugseeVite({
                failOnError,
                deleteMaps: false,
                onError: (e: unknown) => errors.push(e),
                onNotice: () => undefined,
              }),
            ]),
          );
          expect(errors.map(String)).toEqual([]);
          expect(requests.length, 'uploaded').toBeGreaterThan(before);
          const files = readdirSync(join(app.out, 'assets'));
          const bundles = files.filter((f) => f.endsWith('.js'));
          expect(bundles.length).toBeGreaterThanOrEqual(2); // main + worker
          for (const bundle of bundles) {
            const id = idOf(readFileSync(join(app.out, 'assets', bundle), 'utf8'));
            expect(id, `${bundle} stamped`).toBeDefined();
            const map = JSON.parse(
              readFileSync(join(app.out, 'assets', `${bundle}.map`), 'utf8'),
            ) as { debugId?: string };
            expect(map.debugId, `${bundle}.map carries the same id`).toBe(id);
          }
          // And with the default (delete after a confirmed upload) nothing is left behind.
          const app2 = workerApp(
            `vite-worker-del-${label.replace(/\W+/g, '')}-${form}-${failOnError}`,
            form,
          );
          await build(viteConfig(app2, [bugseeVite({ failOnError, onNotice: () => undefined })]));
          expect(
            (readdirSync(join(app2.out, 'assets')) as string[]).filter((f) => f.endsWith('.map')),
          ).toEqual([]);
        });
      }
    }
  }
});

// A plugin that emits its own script + a map that is not a source map (after our stamp) must cost the build nothing:
// the real CLI rejects a batch containing a non-object map, which used to lose the upload of every stamped map.
describeReal('Vite: an own script with a broken map does not cost the other maps', () => {
  const extPlugin = (map: string): VitePlugin => ({
    name: 'emit-ext',
    generateBundle: {
      order: 'post',
      handler() {
        (this as unknown as { emitFile(f: object): void }).emitFile({
          type: 'asset',
          fileName: 'ext.js',
          source: 'ext();\n//# sourceMappingURL=ext.js.map\n',
        });
        (this as unknown as { emitFile(f: object): void }).emitFile({
          type: 'asset',
          fileName: 'ext.js.map',
          source: map,
        });
      },
    },
  });
  for (const [label, build] of [
    ['Vite 8', viteBuild],
    ['Vite 7', vite7Build],
  ] as const) {
    for (const bad of ['', 'not json', '[]', 'null']) {
      for (const failOnError of [true, false]) {
        it(`${label}, map ${JSON.stringify(bad)} (failOnError ${failOnError}): the main maps still upload and are deleted`, async () => {
          const app = makeApp(
            `vite-badmap-${label.replace(/\W+/g, '')}-${bad.length}-${failOnError}-${Math.abs(bad.charCodeAt(0) || 0)}`,
            { lazy: false },
          );
          const before = requests.length;
          const errors: unknown[] = [];
          await build(
            viteConfig(app, [
              bugseeVite({
                failOnError,
                onError: (e: unknown) => errors.push(e),
                onNotice: () => undefined,
              }),
              extPlugin(bad),
            ]),
          );
          expect(errors.map(String)).toEqual([]);
          expect(requests.length, 'uploaded').toBeGreaterThan(before);
          const files = readdirSync(app.out, { recursive: true }) as string[];
          expect(files.filter((f) => f.endsWith('.map'))).toEqual(['ext.js.map']);
          expect(readFileSync(join(app.out, 'ext.js.map'), 'utf8')).toBe(bad);
        });
      }
    }
  }
});

// N Rollup outputs written CONCURRENTLY into one directory: each uploads and deletes ITS OWN maps, once, and none
// reports another's maps as foreign.
describeReal('several Rollup outputs written concurrently into one directory', () => {
  it("uploads once per output (not N times everything) and never says another output's maps are foreign", async () => {
    const app = makeApp('rollup-many-outputs', { lazy: false });
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const before = requests.length;
    const notices: string[] = [];
    const errors: unknown[] = [];
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [
        bugseeRollupPlugin({
          ...pluginOptions(),
          onNotice: (m: string) => notices.push(m),
          onError: (e: unknown) => errors.push(e),
        }),
      ],
    });
    await Promise.all(
      names.map((n) =>
        bundle.write({
          file: join(app.out, `${n}.js`),
          format: 'iife',
          name: `app_${n}`,
          sourcemap: true,
        }),
      ),
    );
    await bundle.close();
    expect(errors.map(String)).toEqual([]);
    expect(notices.filter((m) => m.includes('not produced by this build'))).toEqual([]);
    const files = readdirSync(app.out);
    expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
    expect(files.filter((f) => f.endsWith('.js')).sort()).toEqual(names.map((n) => `${n}.js`));
    // every output's map was uploaded exactly once (by debug-id), not merely "some upload happened"
    for (const n of names) {
      const id = debugIdOf(join(app.out, `${n}.js`));
      expect(id).not.toBe('');
      expect(requests.slice(before).filter((r) => r.body.includes(id))).toHaveLength(1);
    }
  });
});

describeReal('Rollup generate() before write() into the same directory', () => {
  it('the written output still uploads and deletes its own maps (a generated-only output is not a sibling)', async () => {
    const app = makeApp('rollup-generate-then-write', { lazy: false });
    const before = requests.length;
    const errors: unknown[] = [];
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [
        bugseeRollupPlugin({ ...pluginOptions(), onError: (e: unknown) => errors.push(e) }),
      ],
    });
    await bundle.generate({ dir: app.out, sourcemap: true }); // e.g. to measure size: never written
    await bundle.write({ dir: app.out, sourcemap: true });
    await bundle.close();
    expect(errors.map(String)).toEqual([]);
    expect(requests.length).toBeGreaterThan(before);
    expect((readdirSync(app.out) as string[]).filter((f) => f.endsWith('.map'))).toEqual([]);
  });
});

describeReal('one directory spelled several ways', () => {
  it('outputs into `dist`, `dist/`, a symlink to it and a relative spelling coordinate as ONE directory', async () => {
    const app = makeApp('rollup-spellings', { lazy: false });
    const link = `${app.out}-link`;
    mkdirSync(app.out); // first: Rollup creating a directory through a still-dangling link races the others
    symlinkSync(app.out, link);
    const spellings = [app.out, `${app.out}/`, link, relative(process.cwd(), app.out)];
    const before = requests.length;
    const notices: string[] = [];
    const errors: unknown[] = [];
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [
        bugseeRollupPlugin({
          ...pluginOptions(),
          onNotice: (m: string) => notices.push(m),
          onError: (e: unknown) => errors.push(e),
        }),
      ],
    });
    await Promise.all(
      spellings.map((dir, i) =>
        bundle.write({
          dir,
          entryFileNames: `s${i}.js`,
          format: 'iife',
          name: `s${i}`,
          sourcemap: true,
        }),
      ),
    );
    await bundle.close();
    expect(errors.map(String)).toEqual([]);
    expect(notices.filter((m) => m.includes('not produced by this build'))).toEqual([]);
    expect((readdirSync(app.out) as string[]).filter((f) => f.endsWith('.map'))).toEqual([]);
    for (let i = 0; i < spellings.length; i++) {
      const id = debugIdOf(join(app.out, `s${i}.js`));
      expect(id).not.toBe('');
      expect(requests.slice(before).filter((r) => r.body.includes(id))).toHaveLength(1);
    }
  });
});

describeReal('a mapped and an unmapped output into one directory under failOnError', () => {
  it('the unmapped output has nothing to do and does not fail the build', async () => {
    const app = makeApp('rollup-mapped-unmapped', { lazy: false });
    const before = requests.length;
    const errors: unknown[] = [];
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [
        bugseeRollupPlugin({
          ...pluginOptions(),
          failOnError: true,
          onError: (e: unknown) => errors.push(e),
        }),
      ],
    });
    await Promise.all([
      bundle.write({
        dir: app.out,
        entryFileNames: 'm.js',
        format: 'iife',
        name: 'm',
        sourcemap: true,
      }),
      bundle.write({
        dir: app.out,
        entryFileNames: 'u.js',
        format: 'iife',
        name: 'u',
        sourcemap: false,
      }),
    ]);
    await bundle.close();
    expect(errors.map(String)).toEqual([]);
    expect((readdirSync(app.out) as string[]).filter((f) => f.endsWith('.map'))).toEqual([]);
    // the mapped output really uploaded its map, once; the unmapped one uploaded nothing
    const id = debugIdOf(join(app.out, 'm.js'));
    expect(id).not.toBe('');
    expect(requests.slice(before)).toHaveLength(1);
    expect(requests.slice(before)[0]?.body.includes(id)).toBe(true);
  });
});

describeReal('a generate()-only output is not a sibling', () => {
  it('an unmapped write after a never-written mapped generate() still fails under failOnError', async () => {
    const app = makeApp('rollup-generate-unmapped', { lazy: false });
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [bugseeRollupPlugin({ ...pluginOptions(), failOnError: true })],
    });
    await bundle.generate({
      dir: app.out,
      entryFileNames: 'g.js',
      format: 'iife',
      name: 'g',
      sourcemap: true,
    });
    await expect(
      bundle.write({
        dir: app.out,
        entryFileNames: 'u.js',
        format: 'iife',
        name: 'u',
        sourcemap: false,
      }),
    ).rejects.toThrow(/no source maps with a debug-ID were found/);
    await bundle.close();
  });
});

describeReal('an output into a nested directory of another output', () => {
  it('the parent output neither uploads nor reports the nested output maps as foreign', async () => {
    const app = makeApp('rollup-nested-dirs', { lazy: false });
    const before = requests.length;
    const notices: string[] = [];
    const errors: unknown[] = [];
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [
        bugseeRollupPlugin({
          ...pluginOptions(),
          onNotice: (m: string) => notices.push(m),
          onError: (e: unknown) => errors.push(e),
        }),
      ],
    });
    await Promise.all([
      bundle.write({
        dir: app.out,
        entryFileNames: 'p.js',
        format: 'iife',
        name: 'p',
        sourcemap: true,
      }),
      bundle.write({
        dir: join(app.out, 'b'),
        entryFileNames: 'c.js',
        format: 'iife',
        name: 'c',
        sourcemap: true,
      }),
    ]);
    await bundle.close();
    expect(errors.map(String)).toEqual([]);
    expect(notices.filter((m) => m.includes('not produced by this build'))).toEqual([]);
    expect(
      readdirSync(app.out, { recursive: true }).filter((f) => String(f).endsWith('.map')),
    ).toEqual([]);
    expect(requests.length - before).toBeLessThanOrEqual(2);
  });
});

describeReal('a mapped output that FINISHED before an unmapped one, under failOnError', () => {
  it('the later unmapped output has nothing to do and does not fail', async () => {
    const app = makeApp('rollup-mapped-then-unmapped', { lazy: false });
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [bugseeRollupPlugin({ ...pluginOptions(), failOnError: true })],
    });
    await bundle.write({
      dir: app.out,
      entryFileNames: 'm.js',
      format: 'iife',
      name: 'm',
      sourcemap: true,
    });
    await bundle.write({
      dir: app.out,
      entryFileNames: 'u.js',
      format: 'iife',
      name: 'u',
      sourcemap: false,
    });
    await bundle.close();
  });
});

describeReal('a finished sibling whose maps stay on disk (deleteMaps: false)', () => {
  it('a later output does not upload them again or call them foreign', async () => {
    const app = makeApp('rollup-finished-sibling', { lazy: false });
    const before = requests.length;
    const notices: string[] = [];
    const bundle = await rollup({
      input: join(app.dir, 'index.js'),
      plugins: [
        bugseeRollupPlugin({
          ...pluginOptions(),
          deleteMaps: false,
          onNotice: (m: string) => notices.push(m),
        }),
      ],
    });
    await bundle.write({
      dir: app.out,
      entryFileNames: 'm.js',
      format: 'iife',
      name: 'm',
      sourcemap: true,
    });
    await bundle.write({
      dir: app.out,
      entryFileNames: 'u.js',
      format: 'iife',
      name: 'u',
      sourcemap: false,
    });
    await bundle.close();
    expect(notices.filter((m) => m.includes('not produced by this build'))).toEqual([]);
    expect(requests.slice(before)).toHaveLength(1);
    expect(requests.slice(before)[0]?.body.includes(debugIdOf(join(app.out, 'm.js')))).toBe(true);
    expect(readdirSync(app.out)).toContain('m.js.map'); // deleteMaps: false
  });
});
