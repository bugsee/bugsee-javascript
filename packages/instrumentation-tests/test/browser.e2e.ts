// The REAL-BROWSER e2e: the `@bugsee/browser` SDK running inside a real Chromium, driven by Playwright,
// uploading to the real mock collector, asserted on the bundle that actually arrived.
//
// Why this exists. Every other browser-tier test in this repo runs under jsdom, and `replay.e2e.ts` names
// the gap in its own header: "jsdom is a real DOM but NOT a real browser engine; a cross-browser
// Playwright run is a documented follow-up". Three things that only a browser can answer were therefore
// never answered together: rrweb recording against a real layout engine, `window.onerror` from a real
// uncaught throw, and IndexedDB durability against the engine's own implementation rather than
// `fake-indexeddb`.
//
// The page is served from its own origin and uploads CROSS-ORIGIN to the collector, which is what a
// customer's page does — the SDK's own endpoint is never same-origin with the app.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  assertBundleIntegrity,
  assertNoContractViolations,
  assertNoSecrets,
  type MockCollector,
  type ParsedBundle,
  parseBundles,
  readJson,
  startMockCollector,
} from '@bugsee/e2e-kit';
import { strFromU8 } from '@bugsee/util';
import { build } from 'esbuild';
import { gunzipSync } from 'fflate';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BROWSER_BODY_TEXT, BROWSER_SECRET, BROWSER_VISIBLE_TEXT } from '../app/browser-constants';

const scenarioPath = fileURLToPath(new URL('../app/browser-scenario.ts', import.meta.url));

/** Bundle the page script the way a customer's bundler would — real esbuild over the real workspace source. */
async function bundleScenario(): Promise<string> {
  const result = await build({
    entryPoints: [scenarioPath],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome110',
    write: false,
    // The SDK reads `process.env.NODE_ENV` in a few shared-tier guards; a browser has no `process`.
    define: { 'process.env.NODE_ENV': '"production"' },
    // `@bugsee/util`'s sha256 falls back to `node:crypto` when no global WebCrypto exists, and esbuild
    // honours none of the ignore comments that specifier carries — so a browser-target esbuild build
    // fails hard on it and this is what a customer bundling that way has to pass. Hiding the specifier
    // from static analysis was tried and reverted: workerd rejects dynamic module specifiers outright
    // (see the note in `packages/util/src/sha256.ts`). The branch is unreachable here anyway — 127.0.0.1
    // is a secure context, so `crypto.subtle` is present.
    external: ['node:crypto'],
  });
  const out = result.outputFiles[0];
  if (out === undefined) {
    throw new Error('esbuild produced no output for the browser scenario');
  }
  return out.text;
}

/** Serve the harness page (and its bundle) on its own ephemeral origin. */
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
    res.end('<!doctype html><html><head><title>bugsee e2e</title></head><body></body></html>');
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

/** The `request.json` fields these assertions read. */
interface BugseeRequest {
  type: string;
  summary: string;
  description?: string;
  source?: { type?: string; mechanism?: string };
}

/** The `crash.json` fields these assertions read (the full contract lives in `@bugsee/core`). */
interface CrashJsonShape {
  handled: boolean;
  exception: { name: string; reason?: string; frames: Array<{ trace: string }> };
}

interface BridgeState {
  state: 'running' | 'done' | 'failed';
  error?: string;
  sdkErrors: string[];
}

/** Load the page, run a scenario to completion, and return what the SDK reported through `onError`. */
async function runScenario(
  browser: Browser,
  pageUrl: string,
  collectorUrl: string,
  scenario: string,
): Promise<{ sdkErrors: string[]; consoleErrors: string[] }> {
  const context = await browser.newContext();
  const page: Page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.goto(pageUrl);
  await page.addInitScript(() => {});
  await page.evaluate(
    ([collector, name]) => {
      const w = window as unknown as { __E2E_COLLECTOR__: string; __E2E_SCENARIO__: string };
      w.__E2E_COLLECTOR__ = collector as string;
      w.__E2E_SCENARIO__ = name as string;
    },
    [collectorUrl, scenario],
  );
  await page.addScriptTag({ url: `${pageUrl}/scenario.js` });

  await page.waitForFunction(
    () => (window as unknown as { __E2E__?: BridgeState }).__E2E__?.state !== 'running',
    undefined,
    { timeout: 45_000 },
  );
  const bridge = (await page.evaluate(
    () => (window as unknown as { __E2E__: BridgeState }).__E2E__,
  )) as BridgeState;

  await context.close();

  if (bridge.state === 'failed') {
    throw new Error(`browser scenario "${scenario}" failed: ${bridge.error ?? '(no error)'}`);
  }
  return { sdkErrors: bridge.sdkErrors, consoleErrors };
}

/** Poll until the collector has received `count` uploads, or fail with what it did receive. */
async function waitForUploads(collector: MockCollector, count: number): Promise<void> {
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

/**
 * The decoded rrweb stream from `replay.bin` (it is written gzipped).
 *
 * This is how the gzip blind spot in `assertNoSecrets` was found: with masking disabled, a typed
 * password appeared verbatim inside `replay.bin` and the shared secret scan swept clean over it, because
 * the plaintext is not a substring of the compressed bytes. That helper now inflates gzip entries
 * itself; this reads the stream directly so the replay assertions can also check what IS there.
 */
function replayText(bundle: ParsedBundle): string {
  const bin = bundle.files['replay.bin'];
  if (bin === undefined) {
    throw new Error(
      `bundle ${bundle.issueId}: no replay.bin. Present: ${Object.keys(bundle.files).sort().join(', ')}`,
    );
  }
  return strFromU8(gunzipSync(bin));
}

describe('@bugsee/browser — REAL Chromium end to end', () => {
  let browser: Browser;
  let script: string;

  beforeAll(async () => {
    script = await bundleScenario();
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  describe('the main capture battery', () => {
    let collector: MockCollector;
    let bundles: ParsedBundle[];
    let sdkErrors: string[];

    beforeAll(async () => {
      collector = await startMockCollector();
      const pages = await startPageServer(script);
      try {
        const run = await runScenario(browser, pages.url, collector.url, 'main');
        sdkErrors = run.sdkErrors;
        // Two reports: the logged exception and the uncaught `window.onerror` crash.
        await waitForUploads(collector, 2);
      } finally {
        await pages.close();
      }
      bundles = parseBundles(collector);
    }, 120_000);

    afterAll(async () => {
      await collector?.close();
    });

    it('reports no internal SDK errors and no contract violations', () => {
      expect(sdkErrors).toEqual([]);
      assertNoContractViolations(collector);
    });

    it('uploads self-consistent bundles from a real browser', () => {
      expect(bundles.length).toBeGreaterThanOrEqual(2);
      for (const bundle of bundles) {
        assertBundleIntegrity(bundle);
      }
    });

    it('captures the page’s console output', () => {
      const logs = bundles.flatMap((b) =>
        b.files['logs.json'] === undefined
          ? []
          : readJson<Array<{ message: string; level: number }>>(b, 'logs.json'),
      );
      expect(logs.some((l) => l.message.includes('e2e browser log line'))).toBe(true);
      // 1 = LogLevel.Error, asserted as the NUMBER the viewer reads (the same regression guard the node
      // suite carries — a string level passes every envelope check and breaks the viewer).
      expect(
        logs.some((l) => l.level === 1 && l.message.includes('e2e browser error log line')),
      ).toBe(true);
      expect(logs.every((l) => typeof l.level === 'number')).toBe(true);
    });

    it('captures a real cross-origin fetch', () => {
      const network = bundles.flatMap((b) =>
        b.files['network.json'] === undefined
          ? []
          : readJson<Array<{ url?: string }>>(b, 'network.json'),
      );
      expect(network.some((n) => (n.url ?? '').includes('probe=browser'))).toBe(true);
    });

    it('records a real rrweb replay containing a full snapshot', () => {
      const withReplay = bundles.filter((b) => b.files['replay.bin'] !== undefined);
      expect(withReplay.length).toBeGreaterThan(0);
      // rrweb event type 2 is the full snapshot; without one a replay cannot be played back at all.
      const text = replayText(withReplay[0] as ParsedBundle);
      expect(text).toContain('"type":2');
    });

    it('reports the REAL uncaught error that reached window.onerror', () => {
      const requests = bundles.map((b) => b.request as BugseeRequest);
      const crash = requests.find((r) => r.summary === 'e2e browser uncaught failure');
      expect(
        crash,
        `no uncaught crash among ${JSON.stringify(requests.map((r) => r.summary))}`,
      ).toBeDefined();
      // Not merely "a report arrived": it is typed as a CRASH with the uncaught mechanism, which is what
      // separates a real `window.onerror` capture from the handled `logException` path beside it.
      expect(crash?.type).toBe('crash');
      expect(crash?.source?.mechanism).toBe('uncaught');
    });

    it('ships a structured crash.json for the uncaught error, with real frames', () => {
      const bundle = bundles.find(
        (b) => (b.request as BugseeRequest).summary === 'e2e browser uncaught failure',
      );
      const crash = readJson<CrashJsonShape>(bundle as ParsedBundle, 'crash.json');
      expect(crash.handled).toBe(false);
      expect(crash.exception.name).toBe('Error');
      expect(crash.exception.reason).toContain('e2e browser uncaught failure');
      // A frame pointing at the served bundle — proof the browser's own stack dialect was parsed, not
      // that an empty frame list was accepted.
      expect(crash.exception.frames.length).toBeGreaterThan(0);
      expect(crash.exception.frames.some((f) => f.trace.includes('scenario.js'))).toBe(true);
    });

    it('reports the handled exception', () => {
      const requests = bundles.map((b) => b.request as BugseeRequest);
      const handled = requests.find((r) => r.summary === 'e2e browser handled failure');
      expect(
        handled,
        `no handled report among ${JSON.stringify(requests.map((r) => r.summary))}`,
      ).toBeDefined();
      expect(handled?.type).toBe('error');
      expect(handled?.description ?? '').toContain('scenario.js');
    });

    it('never ships the typed password — in any file, including the replay stream', () => {
      for (const bundle of bundles) {
        assertNoSecrets(bundle, [BROWSER_SECRET]);
      }
      for (const bundle of bundles.filter((b) => b.files['replay.bin'] !== undefined)) {
        expect(replayText(bundle)).not.toContain(BROWSER_SECRET);
      }
    });

    it('masks page text in the replay, so the recorder is provably masking rather than empty', () => {
      // The negative above passes trivially if the recorder captured nothing. This pins the other side:
      // ordinary page text is ALSO absent (maskAllText), while the stream is demonstrably non-trivial.
      const withReplay = bundles.filter((b) => b.files['replay.bin'] !== undefined);
      const text = replayText(withReplay[0] as ParsedBundle);
      expect(text.length).toBeGreaterThan(500);
      expect(text).not.toContain(BROWSER_BODY_TEXT);
      expect(text).not.toContain(BROWSER_VISIBLE_TEXT);
    });
  });

  describe('durable capture against the browser’s own IndexedDB', () => {
    let collector: MockCollector;
    let bundles: ParsedBundle[];
    let sdkErrors: string[];

    beforeAll(async () => {
      collector = await startMockCollector();
      const pages = await startPageServer(script);
      try {
        const run = await runScenario(browser, pages.url, collector.url, 'persist');
        sdkErrors = run.sdkErrors;
        await waitForUploads(collector, 1);
      } finally {
        await pages.close();
      }
      bundles = parseBundles(collector);
    }, 120_000);

    afterAll(async () => {
      await collector?.close();
    });

    it('persists and uploads with real IndexedDB, reporting no internal errors', () => {
      // Every other persistence test in the repo runs on `fake-indexeddb`. This is the SDK's IDB code
      // meeting the engine's own transaction semantics.
      expect(sdkErrors).toEqual([]);
      assertNoContractViolations(collector);
      expect(bundles.length).toBeGreaterThanOrEqual(1);
      assertBundleIntegrity(bundles[0] as ParsedBundle);
    });

    it('carries the persisted capture, not just an empty envelope', () => {
      // The point of the durable path: what was written to IndexedDB comes back out into the bundle. An
      // envelope that uploads with no captured data would satisfy every check above this one.
      const logs = bundles.flatMap((b) =>
        b.files['logs.json'] === undefined
          ? []
          : readJson<Array<{ message: string }>>(b, 'logs.json'),
      );
      expect(logs.some((l) => l.message.includes('e2e persisted log line'))).toBe(true);
    });
  });
});
