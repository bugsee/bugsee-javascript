// The Subresource Integrity SEV1, end to end (docs/review/cli-js-flows.md §7).
//
// Reproduced 2026-09-18 on webpack 5.111 + html-webpack-plugin + webpack-subresource-integrity in
// Chromium: after `bugsee-cli sourcemaps inject` ran over the emitted build, the entry script was
// BLOCKED — "Failed to find a valid digest in the 'integrity' attribute" — and the page ran nothing.
// Stamping happened after the SRI plugin had hashed the files.
//
// The fix stamps INSIDE the compilation, between the source-map emit (stage 500) and the SRI hashing
// (stage 700), so the hashes describe the stamped bytes (packages/bundler-plugin-core/src/stamp-assets.ts).
// This proves it the only way that counts: a REAL build with the REAL plugins and the REAL bugsee-cli,
// loaded in a REAL browser. A lazy chunk is included because its hash is not in the HTML at all —
// webpack-subresource-integrity writes it into the runtime chunk (`__webpack_require__.sriHashes`), and a
// fix that only kept the HTML consistent would still break every dynamic import.
//
// The CONTROL rebuilds the same app and stamps it AFTER emit, as the plugin used to. It must fail in the
// same browser: without it, a page that loads would prove nothing about whether this harness can see
// the bug at all.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { resolveBugseeCli, runBugseeCli } from '@bugsee/bundler-plugin-core';
import { bugseeWebpackPlugin } from '@bugsee/webpack-plugin';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import webpack from 'webpack';
import { SubresourceIntegrityPlugin } from 'webpack-subresource-integrity';

/** Every request is answered "already uploaded", so the source-map upload succeeds without a backend. */
async function startCollector(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ ok: false, error: { type: 'DuplicateSymbolsFoundError', code: 16004 } }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.map': 'application/json',
};

/** Serve a build directory over HTTP — SRI with `crossorigin` is not exercised over file://. */
async function serve(dir: string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const path = normalize(
      join(dir, (req.url ?? '/').split('?')[0] === '/' ? 'index.html' : (req.url as string)),
    );
    if (!path.startsWith(dir)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    try {
      const body = readFileSync(path);
      res.setHeader('content-type', TYPES[extname(path)] ?? 'application/octet-stream');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/`, server };
}

function build(config: webpack.Configuration): Promise<void> {
  return new Promise((resolve, reject) => {
    webpack(config, (error, stats) => {
      if (error) {
        reject(error);
      } else if (stats?.hasErrors()) {
        reject(new Error(stats.toString({ colors: false, all: false, errors: true })));
      } else {
        resolve();
      }
    });
  });
}

interface PageOutcome {
  ran: boolean;
  lazy: string | undefined;
  debugIds: number;
  blocked: string[];
}

async function load(browser: Browser, dir: string): Promise<PageOutcome> {
  const { url, server } = await serve(dir);
  const page = await browser.newPage();
  const blocked: string[] = [];
  page.on('console', (message) => {
    if (/integrity|digest/i.test(message.text())) {
      blocked.push(message.text());
    }
  });
  try {
    await page.goto(url);
    // The lazy chunk is fetched after the entry runs; give it a bounded moment, and do not treat its
    // absence as a hang — a blocked entry never requests it at all.
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
    return { ...state, blocked };
  } finally {
    await page.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('SRI: a webpack-subresource-integrity page still loads after Bugsee stamps it', () => {
  let root: string;
  let browser: Browser;
  let collector: { url: string; close: () => Promise<void> };

  const app = (
    outDir: string,
    plugins: webpack.WebpackPluginInstance[],
  ): webpack.Configuration => ({
    mode: 'production',
    context: root,
    entry: './src/index.js',
    devtool: 'source-map',
    output: {
      path: outDir,
      filename: '[name].[contenthash].js',
      chunkFilename: '[name].[contenthash].js',
      // webpack-subresource-integrity requires it, and it is what a real SRI deployment sets.
      crossOriginLoading: 'anonymous',
      publicPath: '/',
      clean: true,
    },
    plugins: [
      new HtmlWebpackPlugin(),
      new SubresourceIntegrityPlugin({ hashFuncNames: ['sha384'] }),
      ...plugins,
    ],
    infrastructureLogging: { level: 'error' },
  });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'bugsee-sri-e2e-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'index.js'),
      `window.__ran = true;\nimport('./lazy.js').then((m) => { window.__lazy = m.value; });\n`,
    );
    writeFileSync(join(root, 'src', 'lazy.js'), `export const value = 'lazy-ok';\n`);
    collector = await startCollector();
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await collector?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('runs the entry AND the lazy chunk, with every bundle stamped', async () => {
    const outDir = join(root, 'dist');
    await build(
      app(outDir, [
        bugseeWebpackPlugin({
          appToken: 'sri-e2e-token',
          endpoint: collector.url,
          appVersion: '1.0.0',
          appBuild: '1',
          vcs: false,
          registerBuild: false,
          failOnError: true,
        }) as unknown as webpack.WebpackPluginInstance,
      ]),
    );

    // Stamped: every emitted bundle ends with the debug-id comment inject writes.
    const bundles = readdirSync(outDir).filter((f) => f.endsWith('.js'));
    expect(bundles.length).toBeGreaterThanOrEqual(2);
    for (const file of bundles) {
      expect(readFileSync(join(outDir, file), 'utf8'), file).toMatch(/\/\/# debugId=[0-9a-f-]{36}/);
    }
    // ...and still pinned — the page really is an SRI page, not one the plugin quietly unpinned.
    // (html-webpack-plugin minifies production HTML, so the attribute is unquoted.)
    expect(readFileSync(join(outDir, 'index.html'), 'utf8')).toMatch(/integrity="?sha384-/);

    const outcome = await load(browser, outDir);
    expect(outcome.blocked).toEqual([]);
    expect(outcome.ran).toBe(true);
    // The runtime-embedded hash path: blocked here means the fix only covered the HTML.
    expect(outcome.lazy).toBe('lazy-ok');
    // The stamp is live, too — the SDK can attach a debug-id to a crash from these bundles.
    expect(outcome.debugIds).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('CONTROL: the same page stamped AFTER emit is blocked — the bug this exists to prevent', async () => {
    const outDir = join(root, 'dist-control');
    await build(app(outDir, []));
    // Exactly what the plugin used to do after emit. `--allow-sri` because the CLI now refuses this
    // itself — which is the other half of the fix.
    await runBugseeCli(['sourcemaps', 'inject', outDir, '--allow-sri'], {});

    const outcome = await load(browser, outDir);
    expect(outcome.ran).toBe(false);
    expect(outcome.blocked.length).toBeGreaterThan(0);
  }, 120_000);

  it('uses the real bugsee-cli, not a stand-in', () => {
    // Guards the premise: a fake binary could make both tests above pass without touching SRI.
    expect(process.env.BUGSEE_CLI_PATH).toBeUndefined();
    expect(resolveBugseeCli()).toMatch(/bugsee-cli/);
  });
});
