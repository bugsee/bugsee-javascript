// REAL frameworks, REAL engines: the call site of a stackless `play()` rejection must survive the framework's own error channel and reach
// the report through the adapter (docs/design/async-origin-capture.md §10.3). React 18 hands the reason to `BugseeErrorBoundary` through
// `setState(() => { throw error })`; Vue 3 catches the async hook's rejection itself and calls `app.config.errorHandler` (so no
// `unhandledrejection` ever fires). Every other client-side adapter (Angular, Solid, Svelte; Next/Remix/Nuxt/SvelteKit re-export these)
// reaches the same `reportError` in `@bugsee/web-adapter`, which calls `client.logException` with the original error object.
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
import { bundleEntry, runPage, startPageServer, waitForUploads } from './support/browser-harness';

const app = (name: string): string => fileURLToPath(new URL(`../app/${name}`, import.meta.url));

const ADAPTERS = [
  {
    name: 'React 18 error boundary',
    entry: 'async-origin-react-scenario.ts',
    fn: 'playFromReactMount',
  },
  { name: 'Vue 3 errorHandler', entry: 'async-origin-vue-scenario.ts', fn: 'playFromVueMounted' },
] as const;

const ENGINES = [
  { name: 'Chromium', launch: () => chromium.launch({ headless: true }) },
  { name: 'Firefox', launch: () => firefox.launch({ headless: true }) },
  { name: 'WebKit', launch: () => webkit.launch() }, // headless by default
] as const;

interface Crash {
  exception: { name: string; frames: Array<{ trace: string; origin?: string }> };
}

describe.each(ENGINES)('async origin through framework adapters - real $name', (engine) => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await engine.launch();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  describe.each(ADAPTERS)('$name', (adapter) => {
    let collector: MockCollector;
    let bundles: ParsedBundle[];
    let sdkErrors: string[];

    beforeAll(async () => {
      const script = await bundleEntry(app(adapter.entry), {
        __VUE_OPTIONS_API__: 'true',
        __VUE_PROD_DEVTOOLS__: 'false',
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
      });
      collector = await startMockCollector();
      const pages = await startPageServer(script);
      try {
        sdkErrors = (
          await runPage(browser, pages.url, '/', collector.url, async () => {
            await waitForUploads(collector, 1);
            // "Exactly once" needs a window in which a SECOND report (the framework channel AND unhandledrejection) could arrive:
            // the context must not close the moment the first upload lands.
            await new Promise((resolve) => setTimeout(resolve, 2000));
          })
        ).sdkErrors;
      } finally {
        await pages.close();
      }
      bundles = parseBundles(collector);
    }, 120_000);

    afterAll(async () => {
      await collector?.close();
    });

    it('reports without internal SDK errors, and exactly once (the framework channel and unhandledrejection must not both report)', () => {
      expect(sdkErrors).toEqual([]);
      expect(bundles).toHaveLength(1);
    });

    it('the report carries the call site of the failed play(), naming the app function', () => {
      const crash = readJson<Crash>(bundles[0] as ParsedBundle, 'crash.json');
      expect(crash.exception.name).toBe('NotSupportedError');
      expect(crash.exception.frames.length).toBeGreaterThan(0);
      expect(crash.exception.frames.every((f) => f.origin === 'call')).toBe(true);
      expect(crash.exception.frames[0]?.trace).toContain(adapter.fn);
    });
  });
});
