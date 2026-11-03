// REAL platform APIs in REAL engines (docs/design/async-origin-capture.md §3, §4.4): nine APIs rejecting asynchronously, each started from
// a named application function and passed to `logException`. For every rejection the report must contain frames that name that function:
//   - the engine's reason has no usable stack (none, or a header line only, as Chromium's DOMExceptions for clipboard/createImageBitmap):
//     the frames are the recorded call site, all `origin: 'call'`, top frame = the app function;
//   - the reason has a stack of its own (a TypeError from argument validation): those frames are kept, and the SDK's own wrapper is NOT
//     among them (it would be the top `user` frame and decide issue grouping).
// Armed rows (image.decode, FontFace.load, createImageBitmap) start recording after the first stackless rejection nobody could locate,
// which the scenario provokes first and leaves unhandled: that report has no frames, by design.
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

const scenarioPath = fileURLToPath(
  new URL('../app/async-origin-apis-scenario.ts', import.meta.url),
);

interface CaseResult {
  name: string;
  mode: 'always' | 'armed';
  settled: string;
  reasonName?: string;
  hasOwnStack?: boolean;
}
interface Crash {
  exception: { name: string; frames: Array<{ trace: string; origin?: string }> };
}
interface Request {
  source?: { mechanism?: string };
}

const ENGINES = [
  { name: 'Chromium', launch: () => chromium.launch({ headless: true }) },
  { name: 'Firefox', launch: () => firefox.launch({ headless: true }) },
  { name: 'WebKit', launch: () => webkit.launch() },
] as const;

describe.each(ENGINES)('async origin across platform APIs - real $name', (engine) => {
  let browser: Browser;
  let bundles: ParsedBundle[];
  let cases: CaseResult[];
  let sdkErrors: string[];
  let collector: MockCollector;

  beforeAll(async () => {
    const script = await bundleEntry(scenarioPath);
    browser = await engine.launch();
    collector = await startMockCollector();
    const pages = await startPageServer(script);
    try {
      const run = await runPage(browser, pages.url, '/', collector.url, async (bridge) => {
        // + the unhandled arming trigger
        const rejected = (bridge.cases ?? []).filter((c) => c.settled === 'rejected').length;
        await waitForUploads(collector, rejected + 1);
      });
      sdkErrors = run.sdkErrors;
      cases = (run.bridge.cases ?? []) as CaseResult[];
    } finally {
      await pages.close();
    }
    bundles = parseBundles(collector);
  }, 180_000);

  afterAll(async () => {
    await collector?.close();
    await browser?.close();
  });

  const crashOf = (bundle: ParsedBundle): Crash => readJson<Crash>(bundle, 'crash.json');
  const bundleOf = (name: string): ParsedBundle | undefined =>
    bundles.find((b) => JSON.stringify(b.request).includes(`case:${name}`));

  it('reports without internal SDK errors', () => {
    expect(sdkErrors).toEqual([]);
  });

  it('the first unlocated stackless rejection (it arms the armed rows) is reported without frames', () => {
    const trigger = bundles.find(
      (b) => (b.request as Request).source?.mechanism === 'unhandledrejection',
    );
    expect(trigger, 'no unhandledrejection report for the arming trigger').toBeDefined();
    expect(crashOf(trigger as ParsedBundle).exception.frames).toEqual([]);
  });

  it('most APIs reject without a usable stack in a real engine (so this test is not vacuous)', () => {
    const rejected = cases.filter((c) => c.settled === 'rejected');
    // Measured on macOS (9 of 9 reject; 6-7 without a usable stack). Looser here because a headless Linux runner can answer
    // clipboard/getUserMedia differently (a permission prompt that never settles lands as 'unsupported'); still far from vacuous.
    expect(rejected.length).toBeGreaterThanOrEqual(6);
    expect(rejected.filter((c) => c.hasOwnStack !== true).length).toBeGreaterThanOrEqual(4);
  });

  it('every rejection is reported with frames that name the application function that started it', () => {
    for (const result of cases.filter((c) => c.settled === 'rejected')) {
      const bundle = bundleOf(result.name);
      expect(bundle, `no report for ${result.name} (${result.reasonName})`).toBeDefined();
      const frames = crashOf(bundle as ParsedBundle).exception.frames;
      expect(frames.length, `${result.name}: no frames`).toBeGreaterThan(0);
      expect(
        frames.some((f) => f.trace.includes(result.name)),
        `${result.name}: ${frames.map((f) => f.trace).join(' | ')}`,
      ).toBe(true);
    }
  });

  it('where the call site is the only evidence, every frame is marked origin: call and the app function is on top', () => {
    const marked = cases
      .filter((c) => c.settled === 'rejected')
      .map((c) => ({ c, frames: crashOf(bundleOf(c.name) as ParsedBundle).exception.frames }))
      .filter(({ frames }) => frames.some((f) => f.origin === 'call'));
    expect(marked.length).toBeGreaterThanOrEqual(4);
    for (const { c, frames } of marked) {
      expect(
        frames.every((f) => f.origin === 'call'),
        c.name,
      ).toBe(true);
      expect(frames[0]?.trace, c.name).toContain(c.name);
    }
  });

  it('a reason with a stack of its own keeps it, without the SDK wrapper on top', () => {
    const own = cases.filter((c) => c.settled === 'rejected' && c.name === 'startPermissionsQuery');
    expect(own).toHaveLength(1);
    const frames = crashOf(bundleOf('startPermissionsQuery') as ParsedBundle).exception.frames;
    expect(frames.some((f) => f.origin === 'call')).toBe(false);
    if (engine.name !== 'WebKit') {
      // WebKit's top frame is the native `query ([native code])`, which is not the SDK's.
      expect(frames[0]?.trace).toContain('startPermissionsQuery');
    }
  });
});
