// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { createMemoryCaptureStore, type HttpResponse, type HttpTransport } from '@bugsee/core';
import { BugseeOption } from '@bugsee/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserProbe } from './environment';
import { type Bugsee, type BugseeLaunchOptions, launch } from './launch';

// R2P-4 / R2P-5. Every browser-owned boolean launch option, every kind of invalid value. Read by plain
// truthiness these used to be wrong in BOTH directions: `persistUserIdentifier: 'false'` persisted PII,
// `captureInteractions: 0` kept capturing input. The rules, per option:
//   captureInteractions, captureViewHierarchy (default ON, capture)  -> invalid = OFF (fail-closed) + onError
//   startInBlackout, persistUserIdentifier, report* UI flags (default OFF) -> only boolean true turns on

const probe: BrowserProbe = {
  userAgent: () => 'Mozilla/5.0 Chrome/119.0.0.0 Safari/537.36',
  uaDataPlatform: () => 'macOS',
  locale: () => 'en-US',
  utcOffsetMinutes: () => 0,
  screenWidth: () => 1280,
  screenHeight: () => 720,
  pixelRatio: () => 1,
  deviceMemoryBytes: () => undefined,
  cpuCount: () => undefined,
};

const clients: Bugsee[] = [];
const start = async (over: Record<string, unknown>) => {
  // One live client per page: a second launch() would hand back the first.
  for (const previous of clients.splice(0)) {
    await previous.stop(50);
  }
  const onError = vi.fn();
  const transport = vi.fn<HttpTransport>(
    async (): Promise<HttpResponse> => ({ status: 200, headers: {}, body: new Uint8Array() }),
  );
  const client = await launch('tok', {
    window,
    document,
    transport,
    systemProbe: probe,
    systemMetricsSampler: () => [],
    captureNetwork: false,
    replay: false,
    onError,
    captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
    ...over,
  } as BugseeLaunchOptions);
  clients.push(client);
  return { client, onError };
};

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.stop(50);
  }
});

const INVALID: unknown[] = [null, 0, '', 'false', 'true', 1];

const failClosed: Array<[string, string]> = [
  ['captureInteractions', BugseeOption.CaptureInteractions],
  ['captureViewHierarchy', BugseeOption.CaptureViewHierarchy],
];
const defaultOff: Array<[string, string]> = [
  ['startInBlackout', BugseeOption.CaptureStartInBlackout],
  ['persistUserIdentifier', BugseeOption.PersistUserIdentifier],
  ['reportSummaryRequired', BugseeOption.ReportingUiSummaryRequired],
  ['reportDescriptionRequired', BugseeOption.ReportingUiDescriptionRequired],
  ['reportEmailRequired', BugseeOption.ReportingUiEmailRequired],
  ['reportLabelsEnabled', BugseeOption.ReportingUiLabelsEnabled],
  ['reportLabelsRequired', BugseeOption.ReportingUiLabelsRequired],
  ['reportPrioritySelectorEnabled', BugseeOption.ReportingUiPrioritySelectorEnabled],
];

describe('browser boolean launch options: invalid values (R2P-4 / R2P-5)', () => {
  it.each(failClosed)('%s (default ON): invalid => OFF + onError', async (friendly, key) => {
    const { client: base } = await start({});
    expect(base.getLaunchOptions()[key]).toBe(true);
    for (const bad of INVALID) {
      const { client, onError } = await start({ [friendly]: bad });
      expect(client.getLaunchOptions()[key], `${friendly}=${String(bad)}`).toBe(false);
      const messages = onError.mock.calls.map((c) => String((c[0] as Error).message));
      expect(
        messages.filter((m) => m.startsWith(`${friendly} must be a boolean`)),
        `${friendly}=${String(bad)}`,
      ).toHaveLength(1);
    }
  });

  it.each(defaultOff)('%s (default OFF): only boolean true turns it on', async (friendly, key) => {
    const { client: base } = await start({});
    expect(base.getLaunchOptions()[key]).toBe(false);
    for (const bad of INVALID) {
      const { client, onError } = await start({ [friendly]: bad });
      expect(client.getLaunchOptions()[key], `${friendly}=${String(bad)}`).toBe(false);
      expect(
        onError.mock.calls.filter((c) =>
          String((c[0] as Error).message).startsWith(`${friendly} must be a boolean`),
        ),
        `${friendly}=${String(bad)}`,
      ).toHaveLength(1);
    }
  });

  it('startInBlackout: "false" does NOT start the page dark; boolean true does', async () => {
    const { client: off } = await start({ startInBlackout: 'false' });
    expect(off.isBlackout()).toBe(false);
    const { client: on } = await start({ startInBlackout: true });
    expect(on.isBlackout()).toBe(true);
  });
});
