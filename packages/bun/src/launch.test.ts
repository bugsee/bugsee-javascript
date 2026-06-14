import process from 'node:process';
import {
  type Clock,
  createMemoryCaptureStore,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  type Scheduler,
} from '@bugsee/core';
import type { NodeRuntime, SystemProbe } from '@bugsee/node';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bunSystemProbe } from './environment';
import { launch, launchCore } from './launch';

// --- fakes: no real process / network / timers --------------------------------------------------

function fakeProcess(): NodeRuntime {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  const proc: NodeRuntime = {
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return proc;
    },
    off(event, listener) {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((l) => l !== listener),
      );
      return proc;
    },
    exit: vi.fn(),
  };
  return proc;
}

const jsonBody = (o: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(o)));

// A transport that satisfies the full upload path (session → issue → signed PUT) and records calls.
function uploadTransport() {
  return vi.fn<HttpTransport>(async (url: string, _o: HttpRequestOptions = {}) => {
    if (url.endsWith('/v2/sessions')) {
      return {
        status: 200,
        headers: {},
        body: jsonBody({ access_token: 'a' }),
      } satisfies HttpResponse;
    }
    if (url.endsWith('/v2/issues')) {
      return {
        status: 200,
        headers: {},
        body: jsonBody({ endpoint: 'https://s3.test/put', issueId: 'i1', recordingId: 'r1' }),
      } satisfies HttpResponse;
    }
    return { status: 200, headers: {}, body: new Uint8Array() } satisfies HttpResponse;
  });
}

const fixedClock: Clock = { wallNow: () => 1000, monotonicNow: () => 0 };
const fakeScheduler: Scheduler = { setInterval: () => 'h', clearInterval: () => {} };
const memStore = () => createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });

const base = (over: Partial<Parameters<typeof launch>[1]> = {}): Parameters<typeof launch>[1] => ({
  process: fakeProcess(),
  transport: uploadTransport(),
  clock: fixedClock,
  scheduler: fakeScheduler,
  captureNetwork: false,
  captureSystemTraces: false,
  captureStore: memStore(),
  carrier: {}, // fresh per launch → the per-process singleton guard never collides across tests
  ...over,
});

const clients: Array<{ stop: (t?: number) => Promise<boolean> }> = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});
const track = <T extends { stop: (t?: number) => Promise<boolean> }>(c: T): T => {
  clients.push(c);
  return c;
};

describe('@bugsee/bun launch', () => {
  it('reports the Bun platform identity in the environment envelope', () => {
    const { client, internals } = launchCore('tok', base());
    track(client);
    expect(internals).toBeDefined();
    const env = internals?.getEnvironment();
    expect(env?.platform.type).toBe('bun');
    expect(env?.platform.version).toBe(process.versions.bun ?? process.versions.node);
  });

  it('defaults the system probe to the Bun probe but lets the caller override it', () => {
    const nodeProbe: SystemProbe = {
      ...bunSystemProbe,
      platformType: () => 'node',
      runtimeVersion: () => '20.0.0',
    };
    const { client, internals } = launchCore('tok', base({ systemProbe: nodeProbe }));
    track(client);
    // The caller-supplied probe wins over the Bun default (it spreads after it).
    expect(internals?.getEnvironment().platform.type).toBe('node');
    expect(internals?.getEnvironment().platform.version).toBe('20.0.0');
  });

  it('uploads a report carrying the Bun environment on the wire (end-to-end via the node composition)', async () => {
    const transport = uploadTransport();
    const client = track(launch('tok', base({ transport })));
    await client.logException(new Error('boom'));
    // The session create carries the environment …
    expect(transport.mock.calls[0]?.[0]).toMatch(/\/v2\/sessions$/);
    const session = JSON.parse(
      String((transport.mock.calls[0]?.[1] as HttpRequestOptions).body),
    ) as { environment: { platform: { type: string } } };
    expect(session.environment.platform.type).toBe('bun');
    // … and the actual report BUNDLE (the signed PUT zip) embeds the Bun environment in request.json.
    const put = transport.mock.calls.find(([url]) => url === 'https://s3.test/put');
    expect(put).toBeDefined();
    const files = unzipSync((put?.[1] as HttpRequestOptions).body as Uint8Array);
    const requestJson = JSON.parse(strFromU8(files['request.json'] as Uint8Array)) as {
      environment: { platform: { type: string; version: string } };
    };
    expect(requestJson.environment.platform.type).toBe('bun');
    expect(requestJson.environment.platform.version).toBe(
      process.versions.bun ?? process.versions.node,
    );
  });

  it('launch() returns the working public client launchCore() builds', () => {
    const client = track(launch('tok', base()));
    expect(typeof client.logException).toBe('function');
    expect(typeof client.stop).toBe('function');
  });
});
