// REAL-BROWSER e2e for async origin capture (docs/design/async-origin-capture.md §5): the `@bugsee/browser` SDK in headless Chromium
// AND Firefox, a stackless `HTMLMediaElement.play()` rejection, asserted on the bundle that actually reached the collector - the
// frames carry `origin: 'call'`, the top one names the application function that made the call, and the description names the target.
// Also with zone.js loaded first (Angular's page shape): the rejection must still be reported.
import { fileURLToPath } from 'node:url';
import {
  assertNoContractViolations,
  type MockCollector,
  type ParsedBundle,
  parseBundles,
  readJson,
  startMockCollector,
} from '@bugsee/e2e-kit';
import { type Browser, chromium, firefox, webkit } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bundleEntry,
  runPage,
  startPageServer,
  waitForUploads,
  zoneJsSource,
} from './support/browser-harness';

const scenarioPath = fileURLToPath(new URL('../app/async-origin-scenario.ts', import.meta.url));

interface Request {
  type: string;
  source?: { mechanism?: string };
  summary: string;
  description?: string;
}
interface Crash {
  exception: { name: string; frames: Array<{ trace: string; origin?: string }> };
}

const ENGINES = [
  { name: 'Chromium', launch: () => chromium.launch({ headless: true }) },
  { name: 'Firefox', launch: () => firefox.launch({ headless: true }) },
  { name: 'WebKit', launch: () => webkit.launch() }, // headless by default
] as const;

describe.each(ENGINES)('async origin capture - real $name', (engine) => {
  let browser: Browser;
  let script: string;

  beforeAll(async () => {
    script = await bundleEntry(scenarioPath);
    browser = await engine.launch();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  describe.each([
    { variant: 'plain page', path: '/' },
    { variant: 'page with zone.js loaded first', path: '/zone' },
  ])('$variant', ({ path }) => {
    let collector: MockCollector;
    let bundles: ParsedBundle[];
    let sdkErrors: string[];

    beforeAll(async () => {
      collector = await startMockCollector();
      const pages = await startPageServer(script, {
        assets: { '/zone.js': zoneJsSource() },
        pages: { '/zone': ['/zone.js'] },
      });
      try {
        sdkErrors = (
          await runPage(browser, pages.url, path, collector.url, () => waitForUploads(collector, 2))
        ).sdkErrors;
      } finally {
        await pages.close();
      }
      bundles = parseBundles(collector);
    }, 120_000);

    afterAll(async () => {
      await collector?.close();
    });

    // The two reports are told apart by how they were captured, not by text that differs per engine.
    const bundleFor = (mechanism: 'unhandledrejection' | 'programmatic'): ParsedBundle => {
      const found = bundles.find((b) => (b.request as Request).source?.mechanism === mechanism);
      expect(
        found,
        `no ${mechanism} report among ${JSON.stringify(bundles.map((b) => (b.request as Request).source))}`,
      ).toBeDefined();
      return found as ParsedBundle;
    };

    it('reports no internal SDK errors or contract violations', () => {
      expect(sdkErrors).toEqual([]);
      assertNoContractViolations(collector);
    });

    it('the IGNORED play() rejection is reported with the call site and the target', () => {
      const bundle = bundleFor('unhandledrejection');
      const request = bundle.request as Request;
      const crash = readJson<Crash>(bundle, 'crash.json');
      expect(crash.exception.name).toBe('NotSupportedError');
      expect(crash.exception.frames.length).toBeGreaterThan(0);
      expect(crash.exception.frames.every((f) => f.origin === 'call')).toBe(true);
      expect(crash.exception.frames[0]?.trace).toContain('ignoredPlayFromHeroClick');
      expect(request.description ?? '').toContain('Target: <video id="hero">');
      expect(request.description ?? '').toContain('/broken.mp4'); // the element's source, query-free
    });

    it('the CAUGHT play() rejection passed to logException carries the call-site frames', () => {
      const bundle = bundleFor('programmatic');
      const crash = readJson<Crash>(bundle, 'crash.json');
      expect(crash.exception.frames.length).toBeGreaterThan(0);
      expect(crash.exception.frames.every((f) => f.origin === 'call')).toBe(true);
      expect(crash.exception.frames.some((f) => f.trace.includes('caughtPlayFromPromoClick'))).toBe(
        true,
      );
    });
  });
});
