// Subresource Integrity with Vite and Rollup, end to end in a REAL browser.
//
// sri.e2e.ts proves it for webpack. Vite and Rollup used to stamp AFTER emit (`writeBundle`), so a page whose
// hashes were taken in the build was refused. They now stamp in `generateBundle` (order 'pre'), before the
// hashes are taken. This builds a real app with the real plugin and the real bugsee-cli, pins hashes with a
// hand-rolled SRI step, loads the result in Chromium, and requires: the entry runs, the lazy chunk runs, the
// browser blocks nothing, and the SDK's debug-id registrations are live.
//
// The CONTROL stamps the same Vite build AFTER emit, as the plugin used to; it must be blocked, or a page
// that loads would prove nothing about whether this harness can see the defect.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { runBugseeCli } from '@bugsee/bundler-plugin-core';
import { bugseeVitePlugin } from '@bugsee/vite-plugin';
import { type Browser, chromium } from 'playwright';
import { rollup } from 'rollup';
import { type Plugin as VitePlugin, build as viteBuild } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.map': 'application/json',
};

async function serve(dir: string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    // Contain the request inside `dir`: a path-aware check (a raw prefix also accepts a sibling directory).
    const requested = (req.url ?? '/').split('?')[0] as string;
    const path = resolve(dir, `.${requested === '/' ? '/index.html' : requested}`);
    const inside = relative(dir, path);
    if (inside.startsWith('..') || isAbsolute(inside)) {
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
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, server };
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

const sri = (bytes: string | Buffer): string =>
  `sha384-${createHash('sha384').update(bytes).digest('base64')}`;

/** Pin every script / modulepreload that is a chunk of the bundle. */
function pinChunks(html: string, bundle: Record<string, { type: string; code?: string }>): string {
  return html.replace(
    /<(?:script|link)\b[^>]*?(?:src|href)="\/?([^"]+\.js)"[^>]*>/g,
    (tag, file: string) => {
      const entry = bundle[file];
      return entry?.type === 'chunk' && entry.code !== undefined
        ? tag.replace(/>$/, ` integrity="${sri(entry.code)}">`)
        : tag;
    },
  );
}

/** A hand-rolled SRI step that hashes LAST (generateBundle, order post), into the emitted page. */
const lateSri = (): VitePlugin => ({
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

describe('SRI: a Vite / Rollup page still loads after Bugsee stamps it', () => {
  let root: string;
  let browser: Browser;
  let collector: { url: string; close: () => Promise<void> };

  const pluginOptions = () => ({
    appToken: 'sri-e2e-token',
    endpoint: collector.url,
    appVersion: '1.0.0',
    appBuild: '1',
    vcs: false,
    registerBuild: false as const,
    failOnError: true,
  });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'bugsee-sri-vite-e2e-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'index.html'),
      '<!doctype html><html><head></head><body><script type="module" src="/src/index.js"></script></body></html>\n',
    );
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

  const viteApp = (outDir: string, plugins: unknown[]) =>
    ({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins,
      build: { outDir, emptyOutDir: true, minify: false, sourcemap: true },
    }) as never;

  it('Vite: runs the entry AND the lazy chunk, every bundle stamped, hashes taken after the stamp', async () => {
    const outDir = join(root, 'dist-vite');
    await viteBuild(viteApp(outDir, [bugseeVitePlugin(pluginOptions()) as VitePlugin, lateSri()]));

    const bundles = readdirSync(join(outDir, 'assets')).filter((f) => f.endsWith('.js'));
    expect(bundles.length).toBeGreaterThanOrEqual(2);
    for (const file of bundles) {
      expect(readFileSync(join(outDir, 'assets', file), 'utf8'), file).toMatch(
        /\/\/# debugId=[0-9a-f-]{36}/,
      );
    }
    expect(readFileSync(join(outDir, 'index.html'), 'utf8')).toMatch(/integrity="sha384-/);

    const outcome = await load(browser, outDir);
    expect(outcome.blocked).toEqual([]);
    expect(outcome.ran).toBe(true);
    expect(outcome.lazy).toBe('lazy-ok');
    expect(outcome.debugIds).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('Rollup: the same, with a page emitted by a plugin that hashes what Rollup is about to write', async () => {
    const outDir = join(root, 'dist-rollup');
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
          .filter((entry) => entry.type === 'chunk' && entry.isEntry)
          .map(
            (entry) =>
              `<script type="module" crossorigin src="/${entry.fileName}" integrity="${sri(entry.code as string)}"></script>`,
          );
        this.emitFile({
          type: 'asset',
          fileName: 'index.html',
          source: `<!doctype html><html><head></head><body>${tags.join('')}</body></html>`,
        });
      },
    };
    const { bugseeRollupPlugin } = await import('@bugsee/bundler-plugin-core');
    const bundle = await rollup({
      input: join(root, 'src', 'index.js'),
      plugins: [bugseeRollupPlugin(pluginOptions()), sriHtml],
    });
    await bundle.write({ dir: outDir, sourcemap: true });
    await bundle.close();

    const outcome = await load(browser, outDir);
    expect(outcome.blocked).toEqual([]);
    expect(outcome.ran).toBe(true);
    expect(outcome.lazy).toBe('lazy-ok');
    expect(outcome.debugIds).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('CONTROL: the same Vite page stamped AFTER emit is blocked — the bug this exists to prevent', async () => {
    const outDir = join(root, 'dist-vite-control');
    await viteBuild(viteApp(outDir, [lateSri()]));
    await runBugseeCli(['sourcemaps', 'inject', outDir, '--allow-sri'], {});

    const outcome = await load(browser, outDir);
    expect(outcome.ran).toBe(false);
    expect(outcome.blocked.length).toBeGreaterThan(0);
  }, 120_000);
});
