// The REAL-BROWSER e2e for user-identifier persistence, which is OPT-IN (PII): with `persistUserIdentifier:
// true` `setUserIdentifier` survives a page reload (iOS parity) and `clearUserIdentifier` does not; by default
// nothing reaches localStorage, and a value an opted-in launch left behind is removed. jsdom's localStorage is a stand-in; this asserts it against a real Chromium.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { type MockCollector, parseBundles, readJson, startMockCollector } from '@bugsee/e2e-kit';
import { build } from 'esbuild';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Same page script as the report-dialog e2e: it launches the REAL `@bugsee/browser` and exposes the client.
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

const PAGE = `<!doctype html><html><head><title>identifier e2e</title></head><body>
<script src="/scenario.js"></script></body></html>`;

async function startPageServer(
  script: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if ((req.url ?? '/').startsWith('/scenario.js')) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end(script);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

const OPT_IN = { persistUserIdentifier: true };

type Api = {
  setUserIdentifier(id: string): void;
  clearUserIdentifier(): void;
  getUserIdentifier(): string | null;
  upload(o: { summary: string }): Promise<unknown>;
};

describe('user identifier persistence — REAL Chromium end to end', () => {
  let browser: Browser;
  let script: string;

  beforeAll(async () => {
    script = await bundleScenario();
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function open(
    context: BrowserContext,
    url: string,
    collector: MockCollector,
    options: Record<string, unknown> = {},
  ): Promise<Page> {
    const page = await context.newPage();
    await page.addInitScript(
      ([collectorUrl, opts]) => {
        const w = window as unknown as Record<string, unknown>;
        w.__E2E_COLLECTOR__ = collectorUrl;
        w.__E2E_OPTIONS__ = opts;
      },
      [collector.url, options] as const,
    );
    await page.goto(url);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
    return page;
  }

  /** Upload a report from `page` and return the `email` of the bundle the collector received. */
  async function reportEmail(page: Page, collector: MockCollector): Promise<string | undefined> {
    const before = collector.uploads.length;
    await page.evaluate(() =>
      (window as unknown as { __bugsee: Api }).__bugsee.upload({ summary: 'identifier probe' }),
    );
    const deadline = Date.now() + 20_000;
    while (collector.uploads.length <= before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const bundle = parseBundles(collector).at(-1);
    expect(bundle).toBeDefined();
    return readJson<{ email?: string }>(bundle as NonNullable<typeof bundle>, 'request.json').email;
  }

  async function scenario(
    run: (ctx: { context: BrowserContext; url: string; collector: MockCollector }) => Promise<void>,
  ): Promise<void> {
    const collector = await startMockCollector();
    const server = await startPageServer(script);
    const context = await browser.newContext();
    try {
      await run({ context, url: server.url, collector });
    } finally {
      await context.close();
      await server.close();
      await collector.close();
    }
  }

  it('set -> reload: the next report already carries the identifier', async () => {
    await scenario(async ({ context, url, collector }) => {
      const first = await open(context, url, collector, OPT_IN);
      await first.evaluate(() =>
        (window as unknown as { __bugsee: Api }).__bugsee.setUserIdentifier('ann@example.com'),
      );
      await first.close();

      const second = await open(context, url, collector, OPT_IN);
      expect(
        await second.evaluate(() =>
          (window as unknown as { __bugsee: Api }).__bugsee.getUserIdentifier(),
        ),
      ).toBe('ann@example.com');
      expect(await reportEmail(second, collector)).toBe('ann@example.com');
      expect(
        await second.evaluate(() => (window as unknown as { __sdkErrors: string[] }).__sdkErrors),
      ).toEqual([]);
    });
  });

  it('set -> clear -> reload: the identifier is gone', async () => {
    await scenario(async ({ context, url, collector }) => {
      const first = await open(context, url, collector, OPT_IN);
      await first.evaluate(() => {
        (window as unknown as { __bugsee: Api }).__bugsee.setUserIdentifier('ann@example.com');
        (window as unknown as { __bugsee: Api }).__bugsee.clearUserIdentifier();
      });
      await first.close();

      const second = await open(context, url, collector, OPT_IN);
      expect(
        await second.evaluate(() =>
          (window as unknown as { __bugsee: Api }).__bugsee.getUserIdentifier(),
        ),
      ).toBeNull();
      expect(await reportEmail(second, collector)).toBeUndefined();
    });
  });

  it('is OFF by default: the identifier never reaches localStorage and is not restored', async () => {
    await scenario(async ({ context, url, collector }) => {
      const first = await open(context, url, collector);
      await first.evaluate(() =>
        (window as unknown as { __bugsee: Api }).__bugsee.setUserIdentifier('ann@example.com'),
      );
      const stored = await first.evaluate(() =>
        Object.keys(localStorage).filter((k) => k.startsWith('bugsee.user_identifier.')),
      );
      expect(stored).toEqual([]);
      await first.close();

      const second = await open(context, url, collector);
      expect(
        await second.evaluate(() =>
          (window as unknown as { __bugsee: Api }).__bugsee.getUserIdentifier(),
        ),
      ).toBeNull();
    });
  });

  it('a launch with persistence off removes a value an opted-in launch left behind', async () => {
    await scenario(async ({ context, url, collector }) => {
      const first = await open(context, url, collector, OPT_IN);
      await first.evaluate(() =>
        (window as unknown as { __bugsee: Api }).__bugsee.setUserIdentifier('ann@example.com'),
      );
      await first.close();

      const second = await open(context, url, collector); // default: off
      expect(
        await second.evaluate(() =>
          (window as unknown as { __bugsee: Api }).__bugsee.getUserIdentifier(),
        ),
      ).toBeNull();
      expect(
        await second.evaluate(() =>
          Object.keys(localStorage).filter((k) => k.startsWith('bugsee.user_identifier.')),
        ),
      ).toEqual([]);
    });
  });
});
