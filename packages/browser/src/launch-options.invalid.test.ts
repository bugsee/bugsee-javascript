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
//   startInBlackout (default OFF, but ON is the safe side)             -> invalid = ON (fail-on) + onError (R3V-2)
//   persistUserIdentifier, report* UI flags (default OFF)              -> only boolean true turns on

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
    previous.endBlackout(); // the blackout flag is process-wide: do not leak it into the next launch
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
    client.endBlackout();
    await client.stop(50);
  }
});

const INVALID: unknown[] = [null, 0, '', 'false', 'true', 1];

const failClosed: Array<[string, string]> = [
  ['captureInteractions', BugseeOption.CaptureInteractions],
  ['captureViewHierarchy', BugseeOption.CaptureViewHierarchy],
];
const defaultOff: Array<[string, string]> = [
  ['persistUserIdentifier', BugseeOption.PersistUserIdentifier],
  ['reportSummaryRequired', BugseeOption.ReportingUiSummaryRequired],
  ['reportDescriptionRequired', BugseeOption.ReportingUiDescriptionRequired],
  ['reportEmailRequired', BugseeOption.ReportingUiEmailRequired],
  ['reportLabelsEnabled', BugseeOption.ReportingUiLabelsEnabled],
  ['reportLabelsRequired', BugseeOption.ReportingUiLabelsRequired],
  ['reportPrioritySelectorEnabled', BugseeOption.ReportingUiPrioritySelectorEnabled],
];

describe('browser boolean launch options: invalid values', () => {
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

  it.each([
    null,
    0,
    '',
    'false',
    'true',
    1,
    {},
  ])('startInBlackout=%j (invalid) starts the page DARK and reports (R3V-2, fail-on)', async (bad) => {
    const { client, onError } = await start({ startInBlackout: bad });
    expect(client.isBlackout()).toBe(true);
    expect(client.getLaunchOptions()[BugseeOption.CaptureStartInBlackout]).toBe(true);
    expect(
      onError.mock.calls.filter((c) =>
        String((c[0] as Error).message).startsWith('startInBlackout must be a boolean'),
      ),
    ).toHaveLength(1);
  });

  it('startInBlackout: boolean false / absent is not dark, boolean true is, none reported', async () => {
    const { client: absent, onError: e0 } = await start({});
    expect(absent.isBlackout()).toBe(false);
    const { client: off, onError: e1 } = await start({ startInBlackout: false });
    expect(off.isBlackout()).toBe(false);
    const { client: on, onError: e2 } = await start({ startInBlackout: true });
    expect(on.isBlackout()).toBe(true);
    for (const e of [e0, e1, e2]) {
      expect(e).not.toHaveBeenCalled();
    }
  });

  // The INTERNAL silent hold (the Electron renderer's launch hold) is protective too: only boolean false/absent
  // is "no hold"; anything else holds the page dark.
  it.each([
    'yes',
    'true',
    1,
    0,
    null,
    '',
  ])('holdBlackout=%j (invalid) holds the page dark', async (bad) => {
    const { client } = await start({ holdBlackout: bad });
    expect(client.isBlackout()).toBe(true);
  });

  it('holdBlackout: false / absent do not hold', async () => {
    const { client: off } = await start({ holdBlackout: false });
    expect(off.isBlackout()).toBe(false);
    const { client: absent } = await start({});
    expect(absent.isBlackout()).toBe(false);
  });

  // R3V-3/R4V-2: `replay` is ON by default and collects data. A scalar that is not a boolean must not THROW
  // (`null` did); it resolves to OFF (fail closed) and is reported.
  it.each([
    null,
    0,
    '',
    'false',
    'true',
    1,
  ])('replay=%j (invalid) does not throw and reports', async (bad) => {
    const { client, onError } = await start({ replay: bad });
    expect(client).toBeDefined();
    expect(
      onError.mock.calls.filter((c) =>
        String((c[0] as Error).message).startsWith('replay must be a boolean or an options object'),
      ),
    ).toHaveLength(1);
  });
});
