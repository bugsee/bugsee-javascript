// Stamping inside the build must not break a page that lazy-loads a content-hashed chunk.
//
// The in-build stamp runs at PROCESS_ASSETS_STAGE_DEV_TOOLING + 1, BEFORE webpack's RealContentHashPlugin renames
// `[contenthash]` chunks from their final bytes. That plugin rewrites hash references only inside STRING
// sources: stamped bytes handed back as a Buffer kept stale references (the runtime asked for
// `x.<oldhash>.js` while `x.<newhash>.js` was on disk: ChunkLoadError, a broken page). The stamp therefore writes
// its result back as a string source.
//
// Real webpack and Rspack builds, the real bugsee-cli, a real Chromium that triggers the lazy `import()`.
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
import { dirname, extname, join, normalize } from 'node:path';
import { bugseeRollupPlugin, bugseeRspackPlugin } from '@bugsee/bundler-plugin-core';
import { bugseeVitePlugin } from '@bugsee/vite-plugin';
import { bugseeWebpackPlugin } from '@bugsee/webpack-plugin';
import { rspack } from '@rspack/core';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import { type Browser, chromium } from 'playwright';
import { rollup } from 'rollup';
import { build as viteBuild } from 'vite';
import { build as vite7Build } from 'vite7';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import webpack from 'webpack';

const requests: string[] = [];
let collector: Server;
let endpoint: string;
let root: string;
let browser: Browser;

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.map': 'application/json',
};

async function serve(dir: string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const path = normalize(
      join(dir, (req.url ?? '/').split('?')[0] === '/' ? 'index.html' : (req.url as string)),
    );
    try {
      res.setHeader('content-type', TYPES[extname(path)] ?? 'application/octet-stream');
      res.end(readFileSync(path));
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, server };
}

interface PageOutcome {
  ran: boolean;
  lazy: string | undefined;
  debugIds: number;
  failed: string[];
}

async function load(dir: string): Promise<PageOutcome> {
  const { url, server } = await serve(dir);
  const page = await browser.newPage();
  const failed: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  page.on('console', (m) => {
    if (/ChunkLoadError|Loading chunk|Failed to load resource/i.test(m.text()))
      failed.push(m.text());
  });
  page.on('pageerror', (e) => failed.push(String(e)));
  try {
    await page.goto(url);
    await page
      .waitForFunction(() => (window as { __lazy?: string }).__lazy !== undefined, null, {
        timeout: 5_000,
      })
      .catch(() => undefined);
    const state = await page.evaluate(() => {
      const w = window as { __ran?: boolean; __lazy?: string; _bugseeDebugIds?: object };
      return {
        ran: w.__ran === true,
        lazy: w.__lazy,
        debugIds: Object.keys(w._bugseeDebugIds ?? {}).length,
      };
    });
    return { ...state, failed };
  } finally {
    await page.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const pluginOptions = () => ({
  appToken: 'lazy-e2e-token',
  endpoint,
  appVersion: '1.0.0',
  appBuild: '1',
  vcs: false,
  registerBuild: false as const,
  failOnError: true,
  // Keep the maps: this test inspects their names.
  deleteMaps: false,
});

/** Every emitted bundle points at a map that exists, whose `file` and debugId match the bundle. */
function expectConsistentNames(out: string): void {
  const files = readdirSync(out, { recursive: true }) as string[];
  const bundles = files.filter((f) => f.endsWith('.js'));
  expect(bundles.length).toBeGreaterThanOrEqual(2);
  for (const bundle of bundles) {
    const code = readFileSync(join(out, bundle), 'utf8');
    const pointer = [...code.matchAll(/^\/\/# sourceMappingURL=(.+)$/gm)].pop()?.[1]?.trim();
    expect(pointer, `${bundle} has a sourceMappingURL`).toBeDefined();
    const mapPath = join(dirname(bundle), (pointer as string).split('?')[0] as string);
    expect(files, `${bundle} -> ${mapPath}`).toContain(mapPath);
    const map = JSON.parse(readFileSync(join(out, mapPath), 'utf8')) as {
      file?: string;
      debugId?: string;
    };
    if (map.file !== undefined) {
      expect(map.file.split('?')[0], `${mapPath} file`).toBe(bundle.split('/').pop());
    }
    const id = /\/\/# debugId=([0-9a-f-]{36})/.exec(code)?.[1];
    expect(id, `${bundle} stamped`).toBeDefined();
    expect(map.debugId, `${mapPath} debugId`).toBe(id);
  }
}

describe('a content-hashed lazy chunk still loads after the in-build stamp', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'bugsee-lazy-e2e-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'index.js'),
      "window.__ran = true;\nimport('./lazy.js').then((m) => { window.__lazy = m.value; });\n",
    );
    writeFileSync(join(root, 'src', 'lazy.js'), "export const value = 'lazy-ok';\n");
    collector = createServer((req, res) => {
      requests.push(req.url ?? '');
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ ok: false, error: { type: 'DuplicateSymbolsFoundError', code: 16004 } }),
        );
      });
    });
    await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
    endpoint = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => collector?.close(() => r()));
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const expectHealthy = async (out: string, before: number): Promise<void> => {
    expect(requests.length, 'maps uploaded').toBeGreaterThan(before);
    expectConsistentNames(out);
    const outcome = await load(out);
    expect(outcome.failed).toEqual([]);
    expect(outcome.ran).toBe(true);
    expect(outcome.lazy).toBe('lazy-ok');
    expect(outcome.debugIds).toBeGreaterThanOrEqual(2);
  };

  it('webpack 5 (realContentHash)', async () => {
    const out = join(root, 'dist-webpack');
    const before = requests.length;
    await new Promise<void>((resolve, reject) => {
      webpack(
        {
          mode: 'production',
          context: root,
          entry: './src/index.js',
          devtool: 'source-map',
          optimization: {
            realContentHash: true,
            moduleIds: 'deterministic',
            chunkIds: 'deterministic',
          },
          output: {
            path: out,
            filename: '[name].[contenthash].js',
            chunkFilename: '[name].[contenthash].js',
            publicPath: '/',
            clean: true,
          },
          plugins: [
            new HtmlWebpackPlugin(),
            bugseeWebpackPlugin(pluginOptions()) as unknown as webpack.WebpackPluginInstance,
          ],
          infrastructureLogging: { level: 'error' },
        },
        (error, stats) => {
          if (error) reject(error);
          else if (stats?.hasErrors())
            reject(new Error(stats.toString({ all: false, errors: true })));
          else resolve();
        },
      );
    });
    await expectHealthy(out, before);
  }, 120_000);

  it('Rspack', async () => {
    const out = join(root, 'dist-rspack');
    const before = requests.length;
    await new Promise<void>((resolve, reject) => {
      const compiler = rspack({
        mode: 'production',
        context: root,
        entry: './src/index.js',
        devtool: 'source-map',
        output: {
          path: out,
          filename: '[name].[contenthash].js',
          chunkFilename: '[name].[contenthash].js',
          publicPath: '/',
          clean: true,
        },
        plugins: [new rspack.HtmlRspackPlugin(), bugseeRspackPlugin(pluginOptions())],
      });
      compiler.run((err, stats) =>
        compiler.close(() => {
          if (err) reject(err);
          else if (stats?.hasErrors())
            reject(new Error(stats.toString({ all: false, errors: true })));
          else resolve();
        }),
      );
    });
    await expectHealthy(out, before);
  }, 120_000);

  it('Rspack + SubresourceIntegrityPlugin + contenthash: the lazy chunk executes and every pin matches', async () => {
    const out = join(root, 'dist-rspack-sri');
    const before = requests.length;
    await new Promise<void>((resolve, reject) => {
      const compiler = rspack({
        mode: 'production',
        context: root,
        entry: './src/index.js',
        devtool: 'source-map',
        output: {
          path: out,
          filename: '[name].[contenthash].js',
          chunkFilename: '[name].[contenthash].js',
          publicPath: '/',
          crossOriginLoading: 'anonymous',
          clean: true,
        },
        plugins: [
          new rspack.HtmlRspackPlugin(),
          new rspack.SubresourceIntegrityPlugin({ hashFuncNames: ['sha384'] }),
          bugseeRspackPlugin(pluginOptions()),
        ],
      });
      compiler.run((err, stats) =>
        compiler.close(() => {
          if (err) reject(err);
          else if (stats?.hasErrors())
            reject(new Error(stats.toString({ all: false, errors: true })));
          else resolve();
        }),
      );
    });
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toMatch(/integrity="?sha384-/);
    await expectHealthy(out, before);
  }, 120_000);

  it('Rollup: hashed chunk file names are final at generateBundle, so the lazy chunk and pointers are consistent', async () => {
    const out = join(root, 'dist-rollup');
    const before = requests.length;
    const html = {
      name: 'html',
      generateBundle(
        this: { emitFile(f: object): void },
        _o: unknown,
        bundle: Record<string, { type: string; isEntry?: boolean; fileName: string }>,
      ) {
        const tags = Object.values(bundle)
          .filter((e) => e.type === 'chunk' && e.isEntry)
          .map((e) => `<script type="module" src="/${e.fileName}"></script>`);
        this.emitFile({
          type: 'asset',
          fileName: 'index.html',
          source: `<!doctype html><html><body>${tags.join('')}</body></html>`,
        });
      },
    };
    const bundle = await rollup({
      input: join(root, 'src', 'index.js'),
      plugins: [bugseeRollupPlugin(pluginOptions()), html],
    });
    await bundle.write({
      dir: out,
      sourcemap: true,
      entryFileNames: '[name]-[hash].js',
      chunkFileNames: '[name]-[hash].js',
    });
    await bundle.close();
    await expectHealthy(out, before);
  }, 120_000);

  it('Vite: hashed chunk file names, the lazy chunk executes and pointers are consistent', async () => {
    const out = join(root, 'dist-vite');
    const before = requests.length;
    writeFileSync(
      join(root, 'index.html'),
      '<!doctype html><html><body><script type="module" src="/src/index.js"></script></body></html>\n',
    );
    await viteBuild({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [bugseeVitePlugin(pluginOptions()) as never],
      build: { outDir: out, emptyOutDir: true, minify: false, sourcemap: true },
    } as never);
    await expectHealthy(out, before);
  }, 120_000);
});

// Vite builds a worker through its own sub-build and copies it into the output, regenerating (Vite 8) or
// emitting after our generateBundle (Vite 7) its map: the worker bundle must still carry the SAME debug id as its
// map, and the worker must run in a real browser and register its id.
describe('Vite workers in a real browser', () => {
  let wroot: string;
  let wbrowser: Browser;
  beforeAll(async () => {
    wroot = realpathSync(mkdtempSync(join(tmpdir(), 'bugsee-worker-e2e-')));
    // The previous describe closed the shared collector in its afterAll: start our own.
    collector = createServer((req, res) => {
      requests.push(req.url ?? '');
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ ok: false, error: { type: 'DuplicateSymbolsFoundError', code: 16004 } }),
        );
      });
    });
    await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
    endpoint = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
    wbrowser = await chromium.launch({ headless: true });
  }, 60_000);
  afterAll(async () => {
    await wbrowser?.close();
    await new Promise<void>((r) => collector?.close(() => r()));
    if (wroot) rmSync(wroot, { recursive: true, force: true });
  });

  // The registration stub is appended AFTER the worker's own code, so report on a later task.
  const WORKER =
    'setTimeout(() => postMessage({ ok: true, ids: Object.keys(self._bugseeDebugIds ?? {}).length }), 0);\n';
  const forms = {
    url: "const w = new Worker(new URL('./w.js', import.meta.url), { type: 'module' });\nw.onmessage = (e) => { window.__worker = e.data; };\n",
    query:
      "import W from './w.js?worker';\nconst w = new W();\nw.onmessage = (e) => { window.__worker = e.data; };\n",
  } as const;

  for (const [label, build] of [
    ['Vite 8', viteBuild],
    ['Vite 7', vite7Build],
  ] as const) {
    for (const form of ['url', 'query'] as const) {
      for (const failOnError of [true, false]) {
        it(`${label}, ${form} worker (failOnError ${failOnError}): runs, registers its id, map carries the same id`, async () => {
          const dir = join(wroot, `${label}-${form}-${failOnError}`.replace(/\W+/g, '-'));
          mkdirSync(join(dir, 'src'), { recursive: true });
          writeFileSync(
            join(dir, 'index.html'),
            '<!doctype html><html><body><script type="module" src="/src/index.js"></script></body></html>\n',
          );
          writeFileSync(join(dir, 'src', 'index.js'), forms[form]);
          writeFileSync(join(dir, 'src', 'w.js'), WORKER);
          const out = join(dir, 'dist');
          const before = requests.length;
          const errors: unknown[] = [];
          await build({
            root: dir,
            configFile: false,
            logLevel: 'silent',
            plugins: [
              bugseeVitePlugin({
                ...pluginOptions(),
                failOnError,
                onError: (e: unknown) => errors.push(e),
              }) as never,
            ],
            build: { outDir: out, emptyOutDir: true, minify: false, sourcemap: true },
          } as never);
          expect(errors.map(String)).toEqual([]);
          expect(requests.length, 'maps uploaded').toBeGreaterThan(before);
          // every bundle (main + worker) has a map with the SAME id
          const assets = readdirSync(join(out, 'assets'));
          const bundles = assets.filter((f) => f.endsWith('.js'));
          expect(bundles.length).toBeGreaterThanOrEqual(2);
          for (const bundle of bundles) {
            const id = /\/\/# debugId=([0-9a-f-]{36})/.exec(
              readFileSync(join(out, 'assets', bundle), 'utf8'),
            )?.[1];
            expect(id, `${bundle} stamped`).toBeDefined();
            const map = JSON.parse(readFileSync(join(out, 'assets', `${bundle}.map`), 'utf8')) as {
              debugId?: string;
            };
            expect(map.debugId, `${bundle}.map`).toBe(id);
          }
          const { url, server } = await serve(out);
          const page = await wbrowser.newPage();
          try {
            await page.goto(url);
            await page
              .waitForFunction(
                () => (window as { __worker?: unknown }).__worker !== undefined,
                null,
                { timeout: 5_000 },
              )
              .catch(() => undefined);
            const worker = await page.evaluate(
              () => (window as { __worker?: { ok: boolean; ids: number } }).__worker,
            );
            expect(worker?.ok).toBe(true);
            expect(worker?.ids, 'the worker registered its debug id').toBeGreaterThanOrEqual(1);
          } finally {
            await page.close();
            await new Promise<void>((r) => server.close(() => r()));
          }
        }, 120_000);
      }
    }
  }
});
