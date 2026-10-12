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
import { USER_IDENTIFIER_KEY_PREFIX } from './user-identifier-store';

// The user identifier survives a page load (iOS parity): launch -> set -> "reload" (stop + relaunch on the
// same storage) -> the first report already carries it. Real browser composition root, fake localStorage.

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

function fakeStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
}

const clients: Bugsee[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  resetBrowserDeviceIdCache();
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

type Storage = ReturnType<typeof fakeStorage>;

// Persistence is OPT-IN (the identifier is often an email, i.e. PII), so the persistence tests opt in here;
// `optIn: false` launches with the option left at its default.
const start = async (storage: Storage, over: Partial<BugseeLaunchOptions> = {}, optIn = true) => {
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
      localStorage: storage,
      randomUUID: () => 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
    },
    ...(optIn ? { persistUserIdentifier: true } : {}),
    ...over,
  });
  clients.push(client);
  return { client, http };
};

const emailOfFirstReport = async (client: Bugsee, http: ReturnType<typeof transport>) => {
  await client.upload({ summary: 'x' });
  const call = http.mock.calls.find(([url]) => url === 'https://s3.test/put');
  const files = unzipSync((call?.[1] as HttpRequestOptions).body as Uint8Array);
  return (JSON.parse(strFromU8(files['request.json'] as Uint8Array)) as { email?: string }).email;
};

const reload = async (client: Bugsee): Promise<void> => {
  await client.stop();
  clients.splice(0);
  resetBrowserDeviceIdCache();
};

describe('persistUserIdentifier', () => {
  it('restores the identifier on the next launch, before the first report', async () => {
    const storage = fakeStorage();
    const first = await start(storage);
    first.client.setUserIdentifier('ann@example.com');
    expect(storage.data.get(`${USER_IDENTIFIER_KEY_PREFIX}tok`)).toBe('ann@example.com');
    await reload(first.client);

    const second = await start(storage);
    expect(second.client.getUserIdentifier()).toBe('ann@example.com');
    expect(await emailOfFirstReport(second.client, second.http)).toBe('ann@example.com');
  });

  it('forgets a cleared identifier across a reload', async () => {
    const storage = fakeStorage();
    const first = await start(storage);
    first.client.setUserIdentifier('ann@example.com');
    first.client.clearUserIdentifier();
    expect(storage.data.size).toBe(1); // only the device id remains
    await reload(first.client);

    const second = await start(storage);
    expect(second.client.getUserIdentifier()).toBeNull();
    expect(await emailOfFirstReport(second.client, second.http)).toBeUndefined();
  });

  it('keeps the last write when the app overwrites the identifier', async () => {
    const storage = fakeStorage();
    const first = await start(storage);
    first.client.setUserIdentifier('one');
    first.client.setUserIdentifier('two');
    await reload(first.client);
    expect((await start(storage)).client.getUserIdentifier()).toBe('two');
  });

  it('persists what the report dialog sets, via the same public setters', async () => {
    const storage = fakeStorage();
    const first = await start(storage);
    // the dialog's deps are the wrapped public setters; exercising the public surface is equivalent
    first.client.setUserIdentifier('dialog@example.com');
    await reload(first.client);
    expect((await start(storage)).client.getUserIdentifier()).toBe('dialog@example.com');
  });

  it('is OFF by default: nothing is written, a stored value is not restored', async () => {
    const storage = fakeStorage();
    storage.data.set(`${USER_IDENTIFIER_KEY_PREFIX}tok`, 'stale@example.com');
    const { client } = await start(storage, {}, false);
    expect(client.getUserIdentifier()).toBeNull();
    client.setUserIdentifier('mem@example.com');
    expect(client.getUserIdentifier()).toBe('mem@example.com');
    expect(storage.data.get(`${USER_IDENTIFIER_KEY_PREFIX}tok`)).toBeUndefined();
  });

  it('removes a value stored by an earlier opted-in launch when persistence is off', async () => {
    const storage = fakeStorage();
    storage.data.set(`${USER_IDENTIFIER_KEY_PREFIX}tok`, 'stale@example.com');
    await start(storage, { persistUserIdentifier: false });
    expect(storage.data.has(`${USER_IDENTIFIER_KEY_PREFIX}tok`)).toBe(false);
  });

  it('clearUserIdentifier() always removes a stored value, even with persistence off', async () => {
    const storage = fakeStorage();
    const { client } = await start(storage, {}, false);
    storage.data.set(`${USER_IDENTIFIER_KEY_PREFIX}tok`, 'late@example.com'); // e.g. another tab
    client.clearUserIdentifier();
    expect(storage.data.has(`${USER_IDENTIFIER_KEY_PREFIX}tok`)).toBe(false);
  });

  it('treats null / undefined / non-string as a clear, never persisting the text "null"', async () => {
    const storage = fakeStorage();
    const { client } = await start(storage);
    client.setUserIdentifier('ann@example.com');
    for (const bad of [null, undefined, 42, {}]) {
      client.setUserIdentifier('ann@example.com');
      (client.setUserIdentifier as (id: unknown) => void)(bad);
      expect(client.getUserIdentifier()).toBeNull();
      expect(storage.data.has(`${USER_IDENTIFIER_KEY_PREFIX}tok`)).toBe(false);
    }
  });

  it('is scoped per app token', async () => {
    const storage = fakeStorage();
    const first = await start(storage);
    first.client.setUserIdentifier('ann');
    await reload(first.client);
    // a different token never sees it
    const other = await launch('other-tok', {
      window,
      document,
      transport: transport(),
      systemProbe: probe,
      systemMetricsSampler: () => [],
      captureNetwork: false,
      replay: false,
      deviceIdEnv: {
        localStorage: storage,
        randomUUID: () => 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
      },
    });
    clients.push(other);
    expect(other.getUserIdentifier()).toBeNull();
  });

  it('degrades to in-memory with onError when storage throws', async () => {
    const onError = vi.fn();
    const throwing = {
      ...fakeStorage(),
      getItem: (k: string): string | null => {
        if (k.startsWith(USER_IDENTIFIER_KEY_PREFIX)) throw new Error('blocked');
        return null;
      },
      setItem: (k: string): void => {
        if (k.startsWith(USER_IDENTIFIER_KEY_PREFIX)) throw new Error('quota');
      },
      removeItem: (k: string): void => {
        if (k.startsWith(USER_IDENTIFIER_KEY_PREFIX)) throw new Error('blocked');
      },
    };
    const { client, http } = await start(throwing as unknown as Storage, { onError });
    client.setUserIdentifier('mem@example.com');
    client.clearUserIdentifier();
    client.setUserIdentifier('mem2@example.com');
    expect(client.getUserIdentifier()).toBe('mem2@example.com');
    expect(onError).toHaveBeenCalledTimes(4); // read + write + remove + write
    expect(await emailOfFirstReport(client, http)).toBe('mem2@example.com');
  });

  describe('through the report dialog', () => {
    const dialogRoot = (): ShadowRoot | null =>
      document.querySelector('[data-bugsee-report-dialog]')?.shadowRoot ?? null;
    const sendWithEmail = async (client: Bugsee, email: string): Promise<void> => {
      const pending = client.showReportDialog();
      const field = dialogRoot()?.querySelector<HTMLInputElement>('[data-field="email"]');
      if (!field) throw new Error('no email field');
      field.value = email;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      dialogRoot()?.querySelector<HTMLButtonElement>('[data-action="send"]')?.click();
      await pending;
    };

    afterEach(() => {
      document.querySelector('[data-bugsee-report-dialog]')?.remove();
    });

    it('persists the email the reporter typed, so the next page load pre-fills it', async () => {
      const storage = fakeStorage();
      const first = await start(storage);
      await sendWithEmail(first.client, 'jane@example.com');
      expect(storage.data.get(`${USER_IDENTIFIER_KEY_PREFIX}tok`)).toBe('jane@example.com');
      await reload(first.client);

      const second = await start(storage);
      void second.client.showReportDialog();
      expect(dialogRoot()?.querySelector<HTMLInputElement>('[data-field="email"]')?.value).toBe(
        'jane@example.com',
      );
    });

    it('removes the persisted email when the reporter erases it', async () => {
      const storage = fakeStorage();
      const first = await start(storage);
      first.client.setUserIdentifier('jane@example.com');
      await sendWithEmail(first.client, '');
      expect(storage.data.has(`${USER_IDENTIFIER_KEY_PREFIX}tok`)).toBe(false);
      await reload(first.client);
      expect((await start(storage)).client.getUserIdentifier()).toBeNull();
    });
  });
});
