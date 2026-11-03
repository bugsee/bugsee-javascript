// Shared plumbing for the real-browser e2e files that follow `browser.e2e.ts`: bundle a scenario page with esbuild, serve it from its
// own origin (the SDK uploads cross-origin, as a customer's page does), run it in a headless browser and wait for its bridge.

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { MockCollector } from '@bugsee/e2e-kit';
import { build } from 'esbuild';
import type { Browser, Page } from 'playwright';

/** The bridge a scenario publishes on `window.__E2E__`. */
export interface BridgeState {
  state: 'running' | 'done' | 'failed';
  error?: string;
  sdkErrors: string[];
}

/** Bundle a scenario the way a customer's bundler would: real esbuild over the real workspace source, unminified (frame names matter). */
export async function bundleEntry(
  entry: string,
  define: Record<string, string> = {},
): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome110',
    write: false,
    define: { 'process.env.NODE_ENV': '"production"', ...define },
  });
  const out = result.outputFiles[0];
  if (out === undefined) {
    throw new Error(`esbuild produced no output for ${entry}`);
  }
  return out.text;
}

/** The zone.js UMD from this package's own dependency. */
export const zoneJsSource = (): string =>
  readFileSync(
    createRequire(import.meta.url).resolve('zone.js'), // the `require` condition is the UMD bundle
    'utf8',
  );

/**
 * Serve the page: `/` is plain; `/zone` loads zone.js BEFORE the scenario (an Angular-style page); `/scenario.js` is the bundle.
 * `extraHead` is added to the head of every page (a custom Promise library, say).
 */
export async function startPageServer(
  script: string,
  options: { zoneJs?: string; extraHead?: Record<string, string> } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] as string;
    if (path === '/scenario.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(script);
      return;
    }
    if (path === '/broken.mp4') {
      // 200 and a video type, but not a video: the element fails to open it and `play()` rejects with NotSupportedError.
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end('this is not a video');
      return;
    }
    if (path === '/zone.js' && options.zoneJs !== undefined) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(options.zoneJs);
      return;
    }
    if (path.startsWith('/lib/') && options.extraHead?.[path] !== undefined) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(options.extraHead[path]);
      return;
    }
    const head = [
      path === '/zone' ? '<script src="/zone.js"></script>' : '',
      ...Object.keys(options.extraHead ?? {})
        .filter((key) => path === `/with${key.slice('/lib'.length).replace(/\.js$/, '')}`)
        .map((key) => `<script src="${key}"></script>`),
    ].join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html><head><title>bugsee e2e</title>${head}</head><body></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Open `path` on the page server, start the scenario bundle and wait for its bridge to finish. */
export async function runPage(
  browser: Browser,
  pageUrl: string,
  path: string,
  collectorUrl: string,
  // Awaited before the context closes: closing it cancels an upload still in flight.
  beforeClose: () => Promise<void> = async () => undefined,
): Promise<{ sdkErrors: string[]; pageErrors: string[] }> {
  const context = await browser.newContext();
  const page: Page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto(`${pageUrl}${path}`);
  await page.evaluate((collector) => {
    (window as unknown as { __E2E_COLLECTOR__: string }).__E2E_COLLECTOR__ = collector as string;
  }, collectorUrl);
  await page.addScriptTag({ url: `${pageUrl}/scenario.js` });
  await page.waitForFunction(
    () => (window as unknown as { __E2E__?: BridgeState }).__E2E__?.state !== 'running',
    undefined,
    { timeout: 45_000 },
  );
  const bridge = (await page.evaluate(
    () => (window as unknown as { __E2E__: BridgeState }).__E2E__,
  )) as BridgeState;
  try {
    await beforeClose();
  } finally {
    await context.close();
  }
  if (bridge.state === 'failed') {
    throw new Error(`scenario failed: ${bridge.error ?? '(no error)'}`);
  }
  return { sdkErrors: bridge.sdkErrors, pageErrors };
}

/** Poll until the collector has received `count` uploads, or fail with what it did receive. */
export async function waitForUploads(collector: MockCollector, count: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (collector.uploads.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (collector.uploads.length < count) {
    throw new Error(
      `expected ${count} upload(s), got ${collector.uploads.length} (issues: ${collector.issues.length})`,
    );
  }
}
