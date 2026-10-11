// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import {
  createMemoryCaptureStore,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
} from '@bugsee/core';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetBrowserDeviceIdCache } from './device-id';
import type { BrowserProbe } from './environment';
import { type Bugsee, type BugseeLaunchOptions, launch } from './launch';

// The whole path, with a real DOM: launch() → client.showReportDialog() → the form → client.upload() →
// the bundle the collector receives. Nothing in the dialog is faked here except the network.

const probe: BrowserProbe = {
  userAgent: () =>
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  uaDataPlatform: () => 'macOS',
  locale: () => 'en-US',
  utcOffsetMinutes: () => 0,
  screenWidth: () => 1280,
  screenHeight: () => 720,
  pixelRatio: () => 1,
  deviceMemoryBytes: () => undefined,
  cpuCount: () => undefined,
};

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const transport = (): ReturnType<typeof vi.fn<HttpTransport>> =>
  vi.fn<HttpTransport>(async (url: string): Promise<HttpResponse> => {
    if (url.endsWith('/v2/sessions')) {
      return { status: 200, headers: {}, body: json({ access_token: 'access' }) };
    }
    if (url.endsWith('/v2/issues')) {
      return {
        status: 200,
        headers: {},
        body: json({ endpoint: 'https://s3.test/put', issueId: 'i1', recordingId: 'r1' }),
      };
    }
    return { status: 200, headers: {}, body: new Uint8Array() };
  });

const clients: Bugsee[] = [];
const start = async (over: Partial<BugseeLaunchOptions> = {}) => {
  const http = transport();
  const client = await launch('tok', {
    window,
    document,
    transport: http,
    systemProbe: probe,
    systemMetricsSampler: () => [],
    captureNetwork: false,
    replay: false,
    captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
    deviceIdEnv: {
      localStorage: {
        getItem: () => 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
        setItem() {},
        removeItem() {},
      },
      randomUUID: () => 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
    },
    ...over,
  });
  clients.push(client);
  return { client, http };
};

const dialog = (): ShadowRoot | null =>
  document.querySelector('[data-bugsee-report-dialog]')?.shadowRoot ?? null;
const input = (name: string): HTMLInputElement | HTMLTextAreaElement => {
  const found = dialog()?.querySelector<HTMLInputElement>(`[data-field="${name}"]`);
  if (!found) throw new Error(`no ${name} field`);
  return found;
};
const fill = (name: string, value: string): void => {
  const el = input(name);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const sentRequest = (http: ReturnType<typeof transport>): Record<string, unknown> => {
  const put = http.mock.calls.find(([url]) => url === 'https://s3.test/put');
  const files = unzipSync((put?.[1] as HttpRequestOptions).body as Uint8Array);
  return JSON.parse(strFromU8(files['request.json'] as Uint8Array));
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  document.querySelector('[data-bugsee-report-dialog]')?.remove();
  resetBrowserDeviceIdCache();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

describe('client.showReportDialog (launched browser client)', () => {
  it('is part of the public client', async () => {
    const { client } = await start();

    expect(typeof client.showReportDialog).toBe('function');
  });

  it('sends a dialog report that reaches the collector as code_dialog', async () => {
    const { client, http } = await start();
    const pending = client.showReportDialog();

    fill('summary', 'Checkout broke');
    fill('description', 'The spinner never stops');
    dialog()?.querySelector<HTMLButtonElement>('[data-action="send"]')?.click();
    const result = await pending;

    expect(result?.ok).toBe(true);
    const request = sentRequest(http);
    expect(request.summary).toBe('Checkout broke');
    expect(request.description).toBe('The spinner never stops');
    expect((request.source as { type: string }).type).toBe('code_dialog');
    expect(request.severity).toBe(3); // the default bug priority, high
    expect(request.type).toBe('bug');
  });

  it('honours the reporting-UI launch options', async () => {
    const { client, http } = await start({
      reportSummaryRequired: true,
      reportLabelsEnabled: true,
      reportPrioritySelectorEnabled: true,
      reportDefaultBugPriority: 'critical',
    });
    const pending = client.showReportDialog();

    expect(dialog()?.querySelector('[data-field="labels"]')).not.toBeNull();
    expect(dialog()?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe(
      'critical',
    );
    dialog()?.querySelector<HTMLButtonElement>('[data-action="send"]')?.click();
    expect(dialog()?.querySelector('[data-error-for="summary"]')?.textContent).toBe(
      'Summary is required',
    );

    fill('summary', 's');
    fill('labels', 'ui, checkout');
    dialog()?.querySelector<HTMLButtonElement>('[data-action="send"]')?.click();
    await pending;

    const request = sentRequest(http);
    expect(request.severity).toBe(4);
    expect(request.labels).toEqual(['ui', 'checkout']);
  });

  it('remembers the reporter email as the user identifier, and pre-fills it next time', async () => {
    const { client } = await start();
    const first = client.showReportDialog();
    fill('email', 'jane@example.com');
    dialog()?.querySelector<HTMLButtonElement>('[data-action="send"]')?.click();
    await first;

    expect(client.getUserIdentifier()).toBe('jane@example.com');
    void client.showReportDialog();
    expect(input('email').value).toBe('jane@example.com');
  });

  it('clears the stored identifier when the user erases the email, and the report carries none', async () => {
    const { client, http } = await start();
    client.setUserIdentifier('jane@example.com');
    const pending = client.showReportDialog();
    expect(input('email').value).toBe('jane@example.com');
    fill('email', '');

    dialog()?.querySelector<HTMLButtonElement>('[data-action="send"]')?.click();
    await pending;

    expect(client.getUserIdentifier()).toBeNull();
    expect(sentRequest(http).email).toBeUndefined(); // not smuggled back in through the identifier fallback
  });

  it('does nothing after the client is stopped', async () => {
    const { client } = await start();
    await client.stop();

    expect(await client.showReportDialog()).toBeNull();
    expect(dialog()).toBeNull();
  });

  it('resolves null without a DOM instead of throwing', async () => {
    const noDomWindow = {
      addEventListener() {},
      removeEventListener() {},
    } as unknown as Window; // a worker-like global: events, but no `document`
    const { client } = await start({ document: undefined, window: noDomWindow });

    expect(await client.showReportDialog()).toBeNull();
  });
});

describe('reportDefaultBugPriority', () => {
  it('applies to client.upload() too, as on Android, unless the call names a severity', async () => {
    const { client, http } = await start({ reportDefaultBugPriority: 'critical' });

    await client.upload({ summary: 'default' });
    expect(sentRequest(http).severity).toBe(4);
  });

  it('lets a call override it', async () => {
    const { client, http } = await start({ reportDefaultBugPriority: 'critical' });

    await client.upload({ summary: 'explicit', severity: 'medium' });

    expect(sentRequest(http).severity).toBe(2);
  });

  it('falls back to high, and says so, when the option is not a severity name', async () => {
    const onError = vi.fn();
    const { client, http } = await start({
      reportDefaultBugPriority: 'urgent' as unknown as 'high',
      onError,
    });

    await client.upload({ summary: 'bad option' });

    expect(sentRequest(http).severity).toBe(3);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('reportDefaultBugPriority') }),
    );
  });

  it('calls upload() with no arguments as a default-priority bug report', async () => {
    const { client, http } = await start({ reportDefaultBugPriority: 'blocker' });

    await client.upload();

    expect(sentRequest(http).severity).toBe(5);
  });
});

describe('the dialog report is frozen when the dialog opens', () => {
  it('does not carry what happened while the user was typing', async () => {
    const { client, http } = await start();
    client.log('before the dialog opened');
    const pending = client.showReportDialog();
    client.log('while the user was typing');

    dialog()?.querySelector<HTMLButtonElement>('[data-action="send"]')?.click();
    await pending;

    const put = http.mock.calls.find(([url]) => url === 'https://s3.test/put');
    const files = unzipSync((put?.[1] as HttpRequestOptions).body as Uint8Array);
    const logs = JSON.parse(strFromU8(files['logs.json'] as Uint8Array)) as Array<{
      message: string;
    }>;
    expect(logs.map((l) => l.message)).toContain('before the dialog opened');
    expect(logs.map((l) => l.message)).not.toContain('while the user was typing');
  });
});
