// The REAL-BROWSER e2e for `client.startBlackout()` / `endBlackout()` / `isBlackout()`.
//
// The unit suites prove each provider drops its data. What only a real Chromium + the REAL rrweb can
// prove is the property that matters: a DOM change made during a blackout is NOT in the replay.bin the
// report ships — neither as a mutation event, nor in a snapshot, nor leaked by the recorder resuming.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  assertBundleIntegrity,
  assertNoContractViolations,
  type MockCollector,
  type ParsedBundle,
  parseBundles,
  readJson,
  startMockCollector,
} from '@bugsee/e2e-kit';
import { build } from 'esbuild';
import { gunzipSync, strFromU8 } from 'fflate';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The report-dialog scenario is exactly "launch the real browser SDK and expose it on window".
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

const PAGE = `<!doctype html><html><head><title>blackout e2e</title></head><body>
<main id="app"><p id="pre">PRE_MARKER_ALPHA</p><button id="btn">press</button><input id="field" type="text"></main>
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

interface RrwebEvent {
  type: number;
  timestamp: number;
}

const replayOf = (bundle: ParsedBundle): { text: string; events: RrwebEvent[] } => {
  const bytes = bundle.files['replay.bin'];
  if (bytes === undefined) throw new Error('bundle has no replay.bin');
  const text = strFromU8(gunzipSync(bytes));
  return { text, events: JSON.parse(text) as RrwebEvent[] };
};

const FULL_SNAPSHOT = 2;

type BlackoutWindow = Window & {
  __bugsee: {
    startBlackout(): void;
    endBlackout(): void;
    isBlackout(): boolean;
    log(message: string): void;
    upload(options: { summary: string }): Promise<unknown>;
  };
};

describe('blackout — REAL Chromium + REAL rrweb end to end', () => {
  let browser: Browser;
  let script: string;

  beforeAll(async () => {
    script = await bundleScenario();
    browser = await chromium.launch({ headless: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function openPage(
    collector: MockCollector,
    serverUrl: string,
    extraOptions: Record<string, unknown> = {},
  ): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
    const page = await context.newPage();
    await page.addInitScript(
      ([collectorUrl, opts]) => {
        const w = window as unknown as Record<string, unknown>;
        w.__E2E_COLLECTOR__ = collectorUrl;
        w.__E2E_OPTIONS__ = opts;
      },
      // maskAllText off so the markers are readable in the replay (the default is fail-closed masking,
      // under which this test could not tell "blacked out" from "masked").
      [collector.url, { replay: { maskAllText: false }, ...extraOptions }] as const,
    );
    await page.goto(serverUrl);
    await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
    // The replay chunk is lazy-loaded, so launch() resolving does not mean the recorder is running yet.
    if (extraOptions.startInBlackout === true) {
      // A dark launch never records, so there is no snapshot to wait for; drain the event loop instead (two
      // rendered frames: every queued import/microtask has run). The "lit" report of the test is what proves
      // this page CAN record, i.e. that its silence was the blackout and not a recorder that never loaded.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    } else {
      await waitForRecorder(page, collector);
    }
    return page;
  }

  /** CONDITION wait, not a sleep: report until a report's replay.bin carries the recorder's opening snapshot. */
  async function waitForRecorder(page: Page, collector: MockCollector): Promise<void> {
    const deadline = Date.now() + 20_000;
    let probes = 0;
    while (Date.now() < deadline) {
      const probe = await sendReport(page, collector, `recorder-probe-${probes++}`);
      const hasSnapshot =
        probe.files['replay.bin'] !== undefined &&
        replayOf(probe).events.some((e) => e.type === FULL_SNAPSHOT);
      if (hasSnapshot) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('the replay recorder never produced its opening snapshot');
  }

  async function sendReport(
    page: Page,
    collector: MockCollector,
    summary: string,
  ): Promise<ParsedBundle> {
    const before = collector.uploads.length;
    await page.evaluate(
      (s) => (window as unknown as BlackoutWindow).__bugsee.upload({ summary: s }),
      summary,
    );
    const deadline = Date.now() + 20_000;
    while (collector.uploads.length <= before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const bundle = parseBundles(collector)[before];
    if (bundle === undefined) throw new Error(`no bundle uploaded for "${summary}"`);
    assertBundleIntegrity(bundle);
    return bundle;
  }

  it('keeps everything done during a blackout out of the report, and resumes with a fresh snapshot', async () => {
    const collector = await startMockCollector();
    const server = await startPageServer(script);
    try {
      const page = await openPage(collector, server.url);
      const call = <K extends keyof BlackoutWindow['__bugsee']>(name: K) =>
        page.evaluate(
          (n) => (window as unknown as BlackoutWindow).__bugsee[n as 'startBlackout'](),
          name,
        );

      // --- control: BEFORE the blackout everything is captured --------------------------------------
      await page.click('#btn');
      await page.focus('#field');
      await page.waitForTimeout(150);

      // --- the blackout ----------------------------------------------------------------------------
      await call('startBlackout');
      expect(
        await page.evaluate(() => (window as unknown as BlackoutWindow).__bugsee.isBlackout()),
      ).toBe(true);
      await page.evaluate(() => {
        const w = window as unknown as BlackoutWindow;
        w.__bugsee.log('LOG_DURING_BLACKOUT');
        const pre = document.getElementById('pre') as HTMLElement;
        pre.textContent = 'BLACKOUT_MUTATED_TEXT';
        const persistent = document.createElement('p');
        persistent.textContent = 'BLACKOUT_PERSISTENT_TEXT';
        document.getElementById('app')?.appendChild(persistent);
        const transient = document.createElement('p');
        transient.id = 'BLACKOUT_TRANSIENT_NODE';
        transient.textContent = 'BLACKOUT_TRANSIENT_TEXT';
        document.getElementById('app')?.appendChild(transient);
      });
      await page.click('#btn');
      await page.focus('#field');
      await page.keyboard.type('x');
      await page.waitForTimeout(400); // let any (wrongly) running recorder flush its mutation batch

      // A report built DURING the blackout.
      const during = await sendReport(page, collector, 'during');
      const duringReplay = replayOf(during);
      expect(duringReplay.text).toContain('PRE_MARKER_ALPHA'); // pre-blackout replay is intact
      for (const secret of [
        'BLACKOUT_MUTATED_TEXT',
        'BLACKOUT_PERSISTENT_TEXT',
        'BLACKOUT_TRANSIENT',
      ]) {
        expect(duringReplay.text).not.toContain(secret);
      }
      expect(during.files['viewtree.json']).toBeUndefined();
      const duringInput =
        during.files['input.json'] === undefined
          ? []
          : readJson<{ events: unknown[] }>(during, 'input.json').events;
      const duringCrumbs = readJson<Array<{ category: string }>>(during, 'breadcrumbs');
      // Non-visual capture carries on...
      expect(
        readJson<Array<{ message: string }>>(during, 'logs.json').map((l) => l.message),
      ).toContain('LOG_DURING_BLACKOUT');

      // --- end of the blackout: the transient node is gone, the mutated text restored -------------
      await page.evaluate(() => {
        document.getElementById('BLACKOUT_TRANSIENT_NODE')?.remove();
        (document.getElementById('pre') as HTMLElement).textContent = 'PRE_MARKER_ALPHA';
      });
      await call('endBlackout');
      expect(
        await page.evaluate(() => (window as unknown as BlackoutWindow).__bugsee.isBlackout()),
      ).toBe(false);
      await page.evaluate(() => {
        const post = document.createElement('p');
        post.textContent = 'POST_MARKER_OMEGA';
        document.getElementById('app')?.appendChild(post);
      });
      await page.click('#btn');
      await page.waitForTimeout(400);

      const after = await sendReport(page, collector, 'after');
      const afterReplay = replayOf(after);
      // Resumed recording is visible...
      expect(afterReplay.text).toContain('POST_MARKER_OMEGA');
      // ...but nothing that existed only DURING the blackout is: not the intermediate text, not the node
      // that was added and removed inside the window.
      expect(afterReplay.text).not.toContain('BLACKOUT_MUTATED_TEXT');
      expect(afterReplay.text).not.toContain('BLACKOUT_TRANSIENT');
      // The resumed stream opens with a fresh full snapshot (a restarted recorder), so the player never
      // applies post-blackout mutations onto a DOM it did not see.
      const snapshots = afterReplay.events.filter((e) => e.type === FULL_SNAPSHOT);
      expect(snapshots.length).toBeGreaterThanOrEqual(2);
      // KNOWN, DOCUMENTED behaviour (same as mobile video after endBlackout): DOM state that PERSISTS past
      // the end of the window is, by definition, on screen afterwards, so the fresh snapshot shows it.
      expect(afterReplay.text).toContain('BLACKOUT_PERSISTENT_TEXT');

      // The replay brackets the span with rrweb custom events, so a player can show "blacked out" instead
      // of a frozen pre-blackout screen: start (active:true) strictly before end (active:false).
      const markers = (
        afterReplay.events as Array<{
          type: number;
          data?: { tag?: string; payload?: { active?: boolean } };
        }>
      )
        .filter((e) => e.type === 5 && e.data?.tag === 'bugsee.blackout')
        .map((e) => e.data?.payload?.active);
      expect(markers).toEqual([true, false]);

      // The viewtree is back, and the interaction streams record again.
      expect(after.files['viewtree.json']).toBeDefined();
      const afterInput = readJson<{ events: unknown[] }>(after, 'input.json').events;
      const afterCrumbs = readJson<Array<{ category: string }>>(after, 'breadcrumbs');
      // Control: the pre-blackout press + the post-blackout press are there; the blackout one is not, so
      // the DURING report holds exactly the pre-blackout count and the AFTER report strictly more.
      expect(duringInput.length).toBeGreaterThan(0);
      expect(afterInput.length).toBeGreaterThan(duringInput.length);
      const focusCount = (crumbs: Array<{ category: string }>): number =>
        crumbs.filter((c) => c.category === 'ui.focus').length;
      expect(focusCount(duringCrumbs)).toBe(2); // pre-blackout: #btn then #field; none from inside
      expect(focusCount(afterCrumbs)).toBe(3); // + the post-blackout #btn focus; the blackout ones never landed
      assertNoContractViolations(collector);
      await page.context().close();
    } finally {
      await server.close();
      await collector.close();
    }
  }, 90_000);

  it('startInBlackout: a page that loads already blacked out captures NOTHING visual until endBlackout()', async () => {
    const collector = await startMockCollector();
    const server = await startPageServer(script);
    try {
      const page = await openPage(collector, server.url, { startInBlackout: true });
      expect(
        await page.evaluate(() => (window as unknown as BlackoutWindow).__bugsee.isBlackout()),
      ).toBe(true);
      // The page already rendered PRE_MARKER_ALPHA before anyone could call startBlackout(): none of it,
      // and none of what the user does, may be in the report.
      await page.click('#btn');
      await page.focus('#field');
      await page.keyboard.type('x');
      await page.waitForTimeout(400);
      const dark = await sendReport(page, collector, 'dark');
      const darkReplay = dark.files['replay.bin'] === undefined ? undefined : replayOf(dark);
      expect(darkReplay?.text ?? '').not.toContain('PRE_MARKER_ALPHA');
      expect(darkReplay?.events.filter((e) => e.type === FULL_SNAPSHOT) ?? []).toHaveLength(0);
      expect(dark.files['viewtree.json']).toBeUndefined();
      expect(dark.files['input.json']).toBeUndefined();
      const darkCrumbs =
        dark.files.breadcrumbs === undefined
          ? []
          : readJson<Array<{ category: string }>>(dark, 'breadcrumbs');
      expect(darkCrumbs.filter((c) => c.category.startsWith('ui.'))).toHaveLength(0);

      // Releasing it starts recording (a fresh snapshot of the then-current page).
      await page.evaluate(() => (window as unknown as BlackoutWindow).__bugsee.endBlackout());
      await page.waitForTimeout(400);
      await page.click('#btn');
      await page.focus('#field');
      await page.waitForTimeout(300);
      const lit = await sendReport(page, collector, 'lit');
      expect(replayOf(lit).text).toContain('PRE_MARKER_ALPHA');
      expect(lit.files['viewtree.json']).toBeDefined();
      // The "lit" CONTROLS for every negative above: the same page, once released, DOES record input and
      // interaction breadcrumbs, so their absence while dark was the blackout and not a dead source. Only
      // what happened AFTER endBlackout() is there (the dark presses and the typed "x" are not).
      expect(readJson<{ events: unknown[] }>(lit, 'input.json').events.length).toBeGreaterThan(0);
      const litCrumbs = readJson<Array<{ category: string }>>(lit, 'breadcrumbs');
      expect(litCrumbs.filter((c) => c.category === 'ui.focus')).toHaveLength(2); // #btn, #field after the release
      // The replay brackets. A dark launch emits at most the end of its blackout and NEVER leaves the stream
      // saying a blackout is still active after endBlackout(). TIGHTEN to `[[], [true, false]]` once the orphan
      // `[false]` (an end with no start) is gone: review round 2, R2V-12.
      const markers = (
        replayOf(lit).events as Array<{
          type: number;
          data?: { tag?: string; payload?: { active?: boolean } };
        }>
      )
        .filter((e) => e.type === 5 && e.data?.tag === 'bugsee.blackout')
        .map((e) => e.data?.payload?.active);
      expect(markers.length).toBeLessThanOrEqual(2);
      expect(markers.at(-1) ?? false).toBe(false);
      assertNoContractViolations(collector);
      await page.context().close();
    } finally {
      await server.close();
      await collector.close();
    }
  }, 90_000);
});
