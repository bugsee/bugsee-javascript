import type { BrowserProbe } from '@bugsee/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launchRenderer } from './launch-renderer';
import type { BugseeElectronBridge } from './preload-bridge';
import { encodeControl } from './protocol';

// a renderer's report path is an INJECTED trigger pipeline (it forwards the incident to main), so
// core's assembly step — where `ReportHandler.after` used to run — never executes there. The application's
// `after` handler must still run, on the renderer's REAL browser client, before the incident is forwarded.

const probe: BrowserProbe = {
  userAgent: () => 'Mozilla/5.0 (Macintosh) Chrome/119.0.0.0 Safari/537.36',
  uaDataPlatform: () => 'macOS',
  locale: () => 'en-US',
  utcOffsetMinutes: () => 0,
  screenWidth: () => 1280,
  screenHeight: () => 720,
  pixelRatio: () => 1,
  deviceMemoryBytes: () => undefined,
  cpuCount: () => undefined,
};

const fakeWindow = (): Window =>
  ({ addEventListener() {}, removeEventListener() {} }) as unknown as Window;

afterEach(() => {
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('launchRenderer — ReportHandler.after on the injected renderer pipeline', () => {
  const launchReal = async () => {
    const posted: string[] = [];
    let control: ((raw: string) => void) | undefined;
    const bridge: BugseeElectronBridge = {
      post: (raw) => posted.push(raw),
      sendHello: () => {},
      onControl: (handler) => {
        control = handler;
      },
    };
    const client = await launchRenderer('tok', {
      bridge,
      carrier: {},
      window: fakeWindow(),
      transport: vi.fn(async () => ({ status: 200, headers: {}, body: new Uint8Array() })),
      systemProbe: probe,
      systemMetricsSampler: () => [],
      captureNetwork: false,
      replay: false,
      deviceIdEnv: {
        localStorage: { getItem: () => 'dev', setItem: () => {}, removeItem: () => {} },
        randomUUID: () => 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
      },
    } as never);
    const handshake = (): void =>
      control?.(encodeControl({ command: 'session', sessionId: 'main-session', blackout: false }));
    return { client, posted, handshake };
  };

  it('runs once, BEFORE the incident is forwarded to main, and the forwarded incident carries its edits', async () => {
    const { client, posted, handshake } = await launchReal();
    handshake(); // the pipeline only delivers once main has assigned the session
    const seenAtAfter: number[] = [];
    client.setReportHandler({
      after: (request) => {
        seenAtAfter.push(posted.filter((raw) => raw.includes('renderer boom')).length);
        request.report.labels = ['edited-by-after'];
      },
    });
    await client.logException(new Error('renderer boom'));
    expect(seenAtAfter).toEqual([0]); // called once, and nothing of the incident had crossed yet
    const forwarded = posted.filter((raw) => raw.includes('renderer boom'));
    expect(forwarded.length).toBeGreaterThan(0);
    expect(forwarded.join('')).toContain('edited-by-after');
    await client.stop();
  });

  it('is also called when the pipeline cannot deliver yet (before the handshake): the report exists either way', async () => {
    const { client } = await launchReal();
    const after = vi.fn();
    client.setReportHandler({ after });
    await client.logException(new Error('early boom'));
    expect(after).toHaveBeenCalledTimes(1);
    await client.stop();
  });
});
