// @vitest-environment jsdom
//
// RP6 — the real-rrweb session-replay integration e2e. Unlike the fake-`record` unit tests, this boots the
// REAL @bugsee/browser launch with `replay: true` (which lazy-loads the REAL @bugsee/replay → the REAL rrweb
// `record` against a REAL — jsdom — DOM), drives a masked page, fires a report, and asserts the actual
// uploaded bundle: its `replay.bin` ungzips to a valid rrweb stream (with a full snapshot) and masked text is
// masked. This is the end-to-end proof the injected-fake units couldn't give.
//
// NOTE: jsdom is a real DOM but NOT a real browser engine; a cross-browser Playwright run (+ the Bugsee rrweb
// fork wired) is a documented follow-up — this validates the real rrweb integration + the full launch path.
import { type BrowserProbe, type BugseeLaunchOptions, launchCore } from '@bugsee/browser';
import { createMemoryCaptureStore } from '@bugsee/core';
import { strFromU8, unzipSync } from '@bugsee/util';
import { gunzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';

const SECRET = 'super-secret-password-text';

/** A transport that satisfies the upload control plane (session → issue → signed PUT) + captures the PUT
 *  bundle bytes for assertion. */
function captureTransport() {
  let bundle: Uint8Array | undefined;
  const json = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  const transport = async (url: string, options: { body?: Uint8Array | string } = {}) => {
    if (url.endsWith('/v2/sessions'))
      return { status: 200, headers: {}, body: json({ access_token: 'a' }) };
    if (url.endsWith('/v2/issues'))
      return {
        status: 200,
        headers: {},
        body: json({ endpoint: 'https://s3.test/put', issueId: 'i1', recordingId: 'r1' }),
      };
    if (url.includes('/put')) {
      bundle =
        options.body instanceof Uint8Array
          ? options.body
          : new TextEncoder().encode(String(options.body));
      return { status: 200, headers: {}, body: new Uint8Array() };
    }
    return { status: 200, headers: {}, body: new Uint8Array() };
  };
  return { transport: transport as BugseeLaunchOptions['transport'], getBundle: () => bundle };
}

// Typed as the REAL BrowserProbe, and passed WITHOUT a cast. It used to be `as never` at the call
// site, which silenced the compiler at exactly the point it was protecting this: when BrowserProbe
// gained a reader, this fixture kept typechecking and threw at runtime instead — inside report
// assembly, so the whole suite saw only "no bundle arrived".
const fakeProbe: BrowserProbe = {
  userAgent: () => 'Mozilla/5.0 (jsdom) Test',
  locale: () => 'en-US',
  utcOffsetMinutes: () => 0,
  screenWidth: () => 1280,
  screenHeight: () => 720,
  pixelRatio: () => 1,
  deviceMemoryBytes: () => undefined,
  cpuCount: () => undefined,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(20);
  }
  return pred();
}

describe('@bugsee/replay — real rrweb integration (jsdom)', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
    document.body.innerHTML = '';
  });

  it('records a real rrweb replay.bin end-to-end, with text masked', async () => {
    document.body.innerHTML = `<div id="app"><p>${SECRET}</p><input value="${SECRET}" /></div>`;
    const cap = captureTransport();

    const client = launchCore('tok', {
      replay: true, // → lazy-load the REAL @bugsee/replay → REAL rrweb record on the jsdom DOM
      transport: cap.transport,
      systemProbe: fakeProbe,
      systemMetricsSampler: () => [],
      captureNetwork: false,
      detectCrashes: false,
      captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
    }).client;
    stop = async () => {
      await client.stop();
    };

    // Let the lazy import resolve + rrweb emit its initial full snapshot, then mutate to force an incremental.
    await sleep(150);
    document.getElementById('app')?.appendChild(document.createElement('span'));
    await sleep(50);

    await client.logException(new Error('boom'));
    const got = await waitFor(() => cap.getBundle() !== undefined);
    expect(got).toBe(true);

    const files = unzipSync(cap.getBundle() as Uint8Array);
    expect(files['replay.bin']).toBeDefined(); // the gzipped rrweb stream shipped
    const events = JSON.parse(strFromU8(gunzipSync(files['replay.bin'] as Uint8Array))) as Array<{
      type: number;
    }>;
    expect(events.some((e) => e.type === 2)).toBe(true); // a FullSnapshot event is present

    // Masking (fail-closed maskAllText/Inputs): the secret text/input value must NOT appear in the replay
    // stream (verified to DISCRIMINATE — with masking off, it does appear), and the captured text is present
    // as a run of mask characters (proving it was recorded-then-masked, not merely absent).
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(SECRET);
    expect(dump).toMatch(/\*{5,}/);
  });
});
