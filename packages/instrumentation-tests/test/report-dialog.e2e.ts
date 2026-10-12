// The REAL-BROWSER e2e for `client.showReportDialog()`.
//
// The unit suite runs under jsdom, which cannot answer the questions that matter most for this feature:
// jsdom has no `showModal()` (so no top layer), no real Escape/close-watcher behaviour, no Content
// Security Policy, no layout, and no `::part()`. Each of those has already produced a real bug in a
// feature of this shape, so each is asserted here against a real Chromium.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  assertBundleIntegrity,
  assertNoContractViolations,
  type MockCollector,
  parseBundles,
  readJson,
  startMockCollector,
} from '@bugsee/e2e-kit';
import { build } from 'esbuild';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const scenarioPath = fileURLToPath(new URL('../app/report-dialog-scenario.ts', import.meta.url));

async function bundleScenario(): Promise<string> {
  const result = await build({
    entryPoints: [scenarioPath],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome110',
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const out = result.outputFiles[0];
  if (out === undefined) throw new Error('esbuild produced no output');
  return out.text;
}

// A deliberately hostile page: a max-z-index header, a z-index banner, and the page's OWN modal <dialog>
// already open in the top layer — the three things a position:fixed overlay loses to.
const PAGE_CSS = `
  body { font: 16px system-ui; margin: 0; }
  header { position: fixed; top: 0; left: 0; right: 0; height: 56px; background: #0a5; z-index: 2147483647; }
  .banner { position: fixed; right: 16px; bottom: 16px; z-index: 999999; background: #222; color: #fff; padding: 12px; }
  main { padding: 80px 24px; height: 1600px; }
`;

// The stylesheet is EXTERNAL (not an inline <style>) so the strict-CSP test measures the SDK, not this page.
const PAGE = `<!doctype html><html><head><title>dialog e2e</title>
<link rel="stylesheet" href="/page.css"></head><body>
<header>site header</header><main><h1>Acme</h1></main><div class="banner">cookie banner</div>
<dialog id="own-modal"><p>the page's own modal</p></dialog>
<script src="/scenario.js"></script></body></html>`;

interface PageServer {
  url: string;
  close: () => Promise<void>;
}

async function startPageServer(
  script: string,
  headers: Record<string, string> = {},
): Promise<PageServer> {
  const server: Server = createServer((req, res) => {
    if ((req.url ?? '/').startsWith('/page.css')) {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end(PAGE_CSS);
      return;
    }
    if ((req.url ?? '/').startsWith('/scenario.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(script);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(PAGE);
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

const HOST = '[data-bugsee-report-dialog]';

describe('client.showReportDialog() — REAL Chromium end to end', () => {
  let browser: Browser;
  let script: string;

  beforeAll(async () => {
    script = await bundleScenario();
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  /** Open a fresh page on `server`, launch the SDK against `collector`, return the page. */
  async function open(
    server: PageServer,
    collector: MockCollector,
    options: Record<string, unknown> = {},
  ): Promise<{ page: Page; context: BrowserContext; violations: string[] }> {
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    const page = await context.newPage();
    const violations: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
    });
    await page.addInitScript(
      ([collectorUrl, opts]) => {
        const w = window as unknown as Record<string, unknown>;
        w.__E2E_COLLECTOR__ = collectorUrl;
        w.__E2E_OPTIONS__ = opts;
      },
      [collector.url, options] as const,
    );
    await page.goto(server.url);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
    return { page, context, violations };
  }

  const shadow = <T>(page: Page, fn: (root: ShadowRoot) => T): Promise<T> =>
    page.evaluate(`(${fn.toString()})(document.querySelector('${HOST}').shadowRoot)`) as Promise<T>;

  it("sits above a max-z-index header, a banner AND the page's own open modal", async () => {
    const collector = await startMockCollector();
    const server = await startPageServer(script);
    try {
      const { page, context } = await open(server, collector);
      await page.evaluate(() =>
        (document.getElementById('own-modal') as HTMLDialogElement).showModal(),
      );
      await page.evaluate(() => {
        void (
          window as unknown as { __bugsee: { showReportDialog(): Promise<unknown> } }
        ).__bugsee.showReportDialog();
      });

      const hit = await page.evaluate((host) => {
        const el = document.querySelector(host);
        const at = (x: number, y: number): boolean => document.elementFromPoint(x, y) === el;
        return {
          centre: at(innerWidth / 2, innerHeight / 2),
          overHeader: at(20, 20),
          overBanner: at(innerWidth - 40, innerHeight - 30),
          topLayer: (el?.shadowRoot?.querySelector('dialog') as HTMLDialogElement).matches(
            ':modal',
          ),
        };
      }, HOST);
      expect(hit).toEqual({ centre: true, overHeader: true, overBanner: true, topLayer: true });
      await context.close();
    } finally {
      await server.close();
      await collector.close();
    }
  });

  it('sends a code_dialog report whose capture is frozen when the dialog opened', async () => {
    const collector = await startMockCollector();
    const server = await startPageServer(script);
    try {
      const { page, context } = await open(server, collector);
      await page.evaluate(() => {
        const w = window as unknown as {
          __bugsee: { log(m: string): void; showReportDialog(): Promise<unknown> };
        };
        w.__bugsee.log('before the dialog opened');
        void w.__bugsee.showReportDialog();
        w.__bugsee.log('while the user was typing');
      });
      await page.keyboard.type('Checkout is stuck');
      await page.keyboard.press('Enter'); // moves to the description rather than sending
      await page.keyboard.type('The spinner never stops');
      await page.locator(`${HOST} >> css=button[data-action="send"]`).click();

      const deadline = Date.now() + 20_000;
      while (collector.uploads.length < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const [bundle] = parseBundles(collector);
      expect(bundle).toBeDefined();
      assertBundleIntegrity(bundle as NonNullable<typeof bundle>);
      assertNoContractViolations(collector);
      const request = (bundle as NonNullable<typeof bundle>).request as {
        summary: string;
        description: string;
        severity: number;
        source: { type: string };
      };
      expect(request.source.type).toBe('code_dialog');
      expect(request.summary).toBe('Checkout is stuck');
      expect(request.description).toBe('The spinner never stops');
      expect(request.severity).toBe(3);
      const logs = readJson<Array<{ message: string }>>(
        bundle as NonNullable<typeof bundle>,
        'logs.json',
      ).map((l) => l.message);
      expect(logs).toContain('before the dialog opened');
      expect(logs).not.toContain('while the user was typing');
      expect(await page.evaluate((host) => document.querySelector(host) === null, HOST)).toBe(true);
      await context.close();
    } finally {
      await server.close();
      await collector.close();
    }
  });

  it('survives repeated Escape (Chrome makes the second one non-cancellable): no lock, can reopen', async () => {
    const collector = await startMockCollector();
    const server = await startPageServer(script);
    try {
      const { page, context } = await open(server, collector);
      await page.evaluate(() => {
        (window as unknown as { __p: Promise<unknown> }).__p = (
          window as unknown as { __bugsee: { showReportDialog(): Promise<unknown> } }
        ).__bugsee.showReportDialog();
      });
      await page.keyboard.type('half written');
      for (let i = 0; i < 4; i += 1) await page.keyboard.press('Escape');
      await page.waitForTimeout(150);

      expect(await page.evaluate((host) => document.querySelector(host) === null, HOST)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe('');
      expect(
        await page.evaluate(() =>
          Promise.race([
            (window as unknown as { __p: Promise<unknown> }).__p.then(() => 'settled'),
            new Promise((r) => setTimeout(() => r('hung'), 1000)),
          ]),
        ),
      ).toBe('settled');

      await page.evaluate(() => {
        void (
          window as unknown as { __bugsee: { showReportDialog(): Promise<unknown> } }
        ).__bugsee.showReportDialog();
      });
      expect(await page.evaluate((host) => document.querySelector(host) !== null, HOST)).toBe(true);
      await context.close();
    } finally {
      await server.close();
      await collector.close();
    }
  });

  it('can be restyled by the embedder: page::part(), page custom property, and the css option', async () => {
    const collector = await startMockCollector();
    const server = await startPageServer(script);
    try {
      const { page, context } = await open(server, collector);
      await page.addStyleTag({
        content:
          '.bugsee-reporting-dialog::part(bugsee-reporting-dialog-title) { color: rgb(0, 0, 255); } .bugsee-reporting-dialog { --bugsee-reporting-dialog-accent: rgb(0, 128, 0); }',
      });
      await page.evaluate(() => {
        void (
          window as unknown as {
            __bugsee: { showReportDialog(o: object): Promise<unknown> };
          }
        ).__bugsee.showReportDialog({
          css: '.bugsee-reporting-dialog-version { color: rgb(255, 0, 255); }',
        });
      });

      const colours = await shadow(page, (root) => {
        const colour = (sel: string): string =>
          getComputedStyle(root.querySelector(sel) as Element).color;
        return {
          viaPart: colour('.bugsee-reporting-dialog-title'),
          viaCustomProperty: colour('.bugsee-reporting-dialog-send'),
          viaCssOption: colour('.bugsee-reporting-dialog-version'),
        };
      });
      expect(colours).toEqual({
        viaPart: 'rgb(0, 0, 255)',
        viaCustomProperty: 'rgb(0, 128, 0)',
        viaCssOption: 'rgb(255, 0, 255)',
      });
      await context.close();
    } finally {
      await server.close();
      await collector.close();
    }
  });

  it('still renders styled under a strict style-src CSP (adopted stylesheets, no violations)', async () => {
    const collector = await startMockCollector();
    const server = await startPageServer(script, {
      'content-security-policy':
        "default-src 'self'; style-src 'self'; script-src 'self'; connect-src *",
    });
    try {
      const { page, context, violations } = await open(server, collector);
      await page.evaluate(() => {
        void (
          window as unknown as { __bugsee: { showReportDialog(): Promise<unknown> } }
        ).__bugsee.showReportDialog();
      });

      const styled = await shadow(page, (root) => ({
        styleElements: root.querySelectorAll('style').length,
        adopted: (root as unknown as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets.length,
        radius: getComputedStyle(root.querySelector('.bugsee-reporting-dialog-card') as Element)
          .borderRadius,
      }));
      expect(styled).toEqual({ styleElements: 0, adopted: 1, radius: '8px' });
      expect(violations.map((v) => v.slice(0, 300))).toEqual([]);
      await context.close();
    } finally {
      await server.close();
      await collector.close();
    }
  });

  it('opens bugsee.com in a new tab with no opener and no referrer', async () => {
    const collector = await startMockCollector();
    const server = await startPageServer(script);
    try {
      const { page, context } = await open(server, collector);
      const requests: Array<{ url: string; referer: string | null }> = [];
      await context.route('https://bugsee.com/**', (route) => {
        requests.push({
          url: route.request().url(),
          referer: route.request().headers().referer ?? null,
        });
        void route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<title>x</title><script>document.title = "opener=" + String(window.opener)</script>',
        });
      });
      await page.evaluate(() => {
        void (
          window as unknown as { __bugsee: { showReportDialog(): Promise<unknown> } }
        ).__bugsee.showReportDialog();
      });

      const [popup] = await Promise.all([
        context.waitForEvent('page'),
        page.locator(`${HOST} >> css=a[data-powered]`).click(),
      ]);
      await popup.waitForLoadState();

      expect(popup.url()).toBe('https://bugsee.com/');
      expect(await popup.title()).toBe('opener=null');
      expect(requests).toEqual([{ url: 'https://bugsee.com/', referer: null }]);
      expect(await page.evaluate((host) => document.querySelector(host) !== null, HOST)).toBe(true);
      await context.close();
    } finally {
      await server.close();
      await collector.close();
    }
  });
});
