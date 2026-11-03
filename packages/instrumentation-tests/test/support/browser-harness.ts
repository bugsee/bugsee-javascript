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
  promiseIsNative?: boolean;
  /** The platform-API batch's per-case results (the apis scenario only). */
  cases?: Array<{
    name: string;
    mode: string;
    settled: string;
    reasonName?: string;
    hasOwnStack?: boolean;
  }>;
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
export const zoneJsSource = (): string => libSource('zone.js');

/** The source of a dependency's main file (its `require` condition, i.e. the UMD where there is one). */
export const libSource = (specifier: string): string =>
  readFileSync(createRequire(import.meta.url).resolve(specifier), 'utf8');

/** A script on a served page: a URL of one of the `assets`, or inline code. */
export type PageScript = string | { inline: string };

/**
 * Serve the pages. `/scenario.js` is the bundle; `assets` are extra files by URL path (`/zone.js`); `pages` says which scripts the HTML
 * at a path loads BEFORE the scenario, in order (any other path gets an empty page). A page that loads a library first is how an
 * Angular (zone.js) or Bluebird page looks to the SDK.
 */
export async function startPageServer(
  script: string,
  options: { assets?: Record<string, string>; pages?: Record<string, PageScript[]> } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] as string;
    const js = (body: string): void => {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(body);
    };
    if (path === '/scenario.js') {
      js(script);
      return;
    }
    if (path === '/broken.mp4') {
      // 200 and a video type, but not a video: the element fails to open it and `play()` rejects with NotSupportedError.
      // (Any OTHER unknown path gets the empty HTML page below, so `/missing-sw.js`, `/broken.png` and the like fail as a wrong
      // MIME type or an undecodable body, not as a network 404.)
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end('this is not a video');
      return;
    }
    const asset = options.assets?.[path];
    if (asset !== undefined) {
      js(asset);
      return;
    }
    const head = (options.pages?.[path] ?? [])
      .map((entry) =>
        typeof entry === 'string'
          ? `<script src="${entry}"></script>`
          : `<script>${entry.inline}</script>`,
      )
      .join('');
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
  // Awaited with the finished bridge before the context closes: closing it cancels an upload still in flight.
  beforeClose: (bridge: BridgeState) => Promise<void> = async () => undefined,
): Promise<{
  sdkErrors: string[];
  pageErrors: string[];
  promiseIsNative: boolean | undefined;
  bridge: BridgeState;
}> {
  const context = await browser.newContext();
  try {
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
      { timeout: 90_000 },
    );
    const bridge = (await page.evaluate(
      () => (window as unknown as { __E2E__: BridgeState }).__E2E__,
    )) as BridgeState;
    if (bridge.state === 'failed') {
      throw new Error(`scenario failed: ${bridge.error ?? '(no error)'}`);
    }
    await beforeClose(bridge);
    return {
      sdkErrors: bridge.sdkErrors,
      pageErrors,
      promiseIsNative: bridge.promiseIsNative,
      bridge,
    };
  } finally {
    await context.close();
  }
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
