// Replacement-Promise libraries (docs/design/async-origin-capture.md §10.2): the page loads the library BEFORE the SDK, so the global
// `Promise` the SDK sees at install is not the engine's. The platform still returns NATIVE promises from `play()`, so the recorder must
// attach its reaction with a pristine `then` (not the replaced global's) and still hand the app the rejection, an `unhandledrejection`
// report with the call site, and a `logException` report with the call site. (native-promise-only is not in the matrix: it has no
// `Promise.allSettled`, which the SDK itself needs, so it fails before this feature is involved.) Same two reports as `async-origin.browser.e2e.ts`.
import { fileURLToPath } from 'node:url';
import {
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
  libSource,
  type PageScript,
  runPage,
  startPageServer,
  waitForUploads,
} from './support/browser-harness';

const scenarioPath = fileURLToPath(new URL('../app/async-origin-scenario.ts', import.meta.url));

// The marker lets the scenario tell whether `Promise` was replaced (`toString` cannot: core-js disguises its own). `delete window.Promise`
// first where the library only installs itself when there is no native `Promise` (core-js forced).
const MARK: PageScript = { inline: 'window.__nativePromise = window.Promise;' };
const NO_NATIVE: PageScript = {
  inline: 'window.__nativePromise = window.Promise; delete window.Promise;',
};
const LIBS: { name: string; asset: string; scripts: PageScript[] }[] = [
  { name: 'Bluebird', asset: 'bluebird/js/browser/bluebird.js', scripts: [MARK, '/lib.js'] },
  {
    name: 'core-js (forced over a deleted native Promise)',
    asset: 'core-js-bundle',
    scripts: [NO_NATIVE, '/lib.js'],
  },
];

const ENGINES = [
  { name: 'Chromium', launch: () => chromium.launch({ headless: true }) },
  { name: 'Firefox', launch: () => firefox.launch({ headless: true }) },
  { name: 'WebKit', launch: () => webkit.launch() },
] as const;

interface Request {
  source?: { mechanism?: string };
  description?: string;
}
interface Crash {
  exception: { name: string; frames: Array<{ trace: string; origin?: string }> };
}

describe.each(ENGINES)('async origin with a replacement Promise - real $name', (engine) => {
  let browser: Browser;
  let script: string;

  beforeAll(async () => {
    script = await bundleEntry(scenarioPath);
    browser = await engine.launch();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  describe.each(LIBS)('$name', (lib) => {
    let collector: MockCollector;
    let bundles: ParsedBundle[];
    let run: Awaited<ReturnType<typeof runPage>>;

    beforeAll(async () => {
      collector = await startMockCollector();
      const pages = await startPageServer(script, {
        assets: { '/lib.js': libSource(lib.asset) },
        pages: { '/': lib.scripts },
      });
      try {
        run = await runPage(browser, pages.url, '/', collector.url, () =>
          waitForUploads(collector, 2),
        );
      } finally {
        await pages.close();
      }
      bundles = parseBundles(collector);
    }, 120_000);

    afterAll(async () => {
      await collector?.close();
    });

    const bundleFor = (mechanism: string): ParsedBundle => {
      const found = bundles.find((b) => (b.request as Request).source?.mechanism === mechanism);
      expect(found, `no ${mechanism} report`).toBeDefined();
      return found as ParsedBundle;
    };

    it('the fixture really replaced Promise (otherwise this proves nothing)', () => {
      expect(run.promiseIsNative).toBe(false);
    });

    it('reports without internal SDK errors', () => {
      expect(run.sdkErrors).toEqual([]);
    });

    it('the ignored play() still raises unhandledrejection and is reported with its call site and target', () => {
      const bundle = bundleFor('unhandledrejection');
      const crash = readJson<Crash>(bundle, 'crash.json');
      expect(crash.exception.name).toBe('NotSupportedError');
      expect(crash.exception.frames.length).toBeGreaterThan(0);
      expect(crash.exception.frames.every((f) => f.origin === 'call')).toBe(true);
      expect(crash.exception.frames[0]?.trace).toContain('ignoredPlayFromHeroClick');
      expect((bundle.request as Request).description ?? '').toContain('Target: <video id="hero">');
    });

    it('the caught play() passed to logException carries its call site', () => {
      const crash = readJson<Crash>(bundleFor('programmatic'), 'crash.json');
      expect(crash.exception.frames.length).toBeGreaterThan(0);
      expect(crash.exception.frames.some((f) => f.trace.includes('caughtPlayFromPromoClick'))).toBe(
        true,
      );
    });
  });
});
