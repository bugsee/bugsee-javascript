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
import { denoSystemProbe } from './environment';
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
  detectHangs: false, // no real watchdog worker in unit tests
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

describe('@bugsee/deno launch', () => {
  it('reports the Deno RUNTIME identity in the environment envelope', () => {
    const { client, internals } = launchCore('tok', base());
    track(client);
    expect(internals).toBeDefined();
    const env = internals?.getEnvironment();
    expect(env?.runtime.type).toBe('deno');
    expect(env?.runtime.version).toBe(process.versions.node); // Deno global absent under vitest → fallback
  });

  it('defaults the system probe to the Deno probe but lets the caller override it', () => {
    const nodeProbe: SystemProbe = {
      ...denoSystemProbe,
      platformType: () => 'node',
      runtimeVersion: () => '20.0.0',
    };
    const { client, internals } = launchCore('tok', base({ systemProbe: nodeProbe }));
    track(client);
    // The caller-supplied probe wins over the Deno default (it spreads after it).
    expect(internals?.getEnvironment().runtime.type).toBe('node');
    expect(internals?.getEnvironment().runtime.version).toBe('20.0.0');
  });

  it('uploads a report carrying the Deno environment on the wire (end-to-end via the node composition)', async () => {
    const transport = uploadTransport();
    const client = track(launch('tok', base({ transport })));
    await client.logException(new Error('boom'));
    // The session create carries the environment …
    expect(transport.mock.calls[0]?.[0]).toMatch(/\/v2\/sessions$/);
    const session = JSON.parse(
      String((transport.mock.calls[0]?.[1] as HttpRequestOptions).body),
    ) as { environment: { runtime: { type: string } } };
    expect(session.environment.runtime.type).toBe('deno');
    // … and the actual report BUNDLE (the signed PUT zip) embeds the Deno environment in request.json.
    const put = transport.mock.calls.find(([url]) => url === 'https://s3.test/put');
    expect(put).toBeDefined();
    const files = unzipSync((put?.[1] as HttpRequestOptions).body as Uint8Array);
    const requestJson = JSON.parse(strFromU8(files['request.json'] as Uint8Array)) as {
      environment: { runtime: { type: string; version: string } };
    };
    expect(requestJson.environment.runtime.type).toBe('deno');
    expect(requestJson.environment.runtime.version).toBe(process.versions.node); // node-compat fallback under vitest
  });

  it('launch() returns the working public client launchCore() builds', () => {
    const client = track(launch('tok', base()));
    expect(typeof client.logException).toBe('function');
    expect(typeof client.stop).toBe('function');
  });

  it('wires the Deno.serve native wrap (patch + restore) and a wrapped request resolves the carrier client', async () => {
    type G = { Deno?: { serve: (...a: unknown[]) => unknown } };
    const calls: unknown[][] = [];
    const realServe = vi.fn((...args: unknown[]) => {
      calls.push(args);
      return { shutdown: async () => {}, addr: { port: 0 } };
    });
    (globalThis as G).Deno = { serve: realServe };
    const client = launch('tok', base({ instrumentIncomingRequests: true })); // untracked — stopped below
    try {
      expect((globalThis as G).Deno?.serve).not.toBe(realServe); // patched
      (globalThis as G).Deno?.serve(async () => ({ status: 200 })); // Deno.serve(handler)
      const wrapped = calls[0]?.[0] as (req: unknown) => Promise<{ status: number }>;
      const res = await wrapped({ method: 'GET', url: '/x', headers: { get: () => null } });
      expect(res).toEqual({ status: 200 }); // wrap ran getClient -> the launched carrier client -> handler
      // a throwing handler re-throws through the FULL launch composition (error path, real carrier client)
      (globalThis as G).Deno?.serve(async () => {
        throw new Error('handler-boom');
      });
      const throwing = calls[1]?.[0] as (req: unknown) => Promise<unknown>;
      await expect(
        throwing({ method: 'GET', url: '/boom', headers: { get: () => null } }),
      ).rejects.toThrow('handler-boom');
      await client.stop();
      expect((globalThis as G).Deno?.serve).toBe(realServe); // restored on stop
    } finally {
      await client.stop(); // idempotent — guarantees teardown of the node:http + native patches
      delete (globalThis as G).Deno;
    }
  });

  it('forwards traceResponse → a wrapped Deno.serve response carries the return headers (X4)', async () => {
    type G = { Deno?: { serve: (...a: unknown[]) => unknown } };
    const calls: unknown[][] = [];
    const realServe = vi.fn((...args: unknown[]) => {
      calls.push(args);
      return { shutdown: async () => {}, addr: { port: 0 } };
    });
    (globalThis as G).Deno = { serve: realServe };
    const client = launch(
      'tok',
      base({ traceResponse: { traceresponse: true, serverTiming: true } }),
    );
    const txn = {
      getTraceId: () => 'trace-1',
      getSpanId: () => 'span-1',
      isSampled: () => true,
      isFinished: () => false,
      setName() {},
      setAttribute() {},
      finish() {},
    };
    (client as unknown as { registerExt: (n: string, api: unknown) => void }).registerExt(
      'performance',
      { startTransaction: () => txn },
    );
    try {
      const set: Record<string, string> = {};
      (globalThis as G).Deno?.serve(async () => ({
        status: 200,
        headers: {
          set: (n: string, v: string) => {
            set[n] = v;
          },
        },
      }));
      const wrapped = calls[0]?.[0] as (req: unknown) => Promise<unknown>;
      await wrapped({ method: 'GET', url: '/x', headers: { get: () => null } });
      expect(set).toEqual({
        traceresponse: '00-trace-1-span-1-01',
        'Server-Timing': 'traceparent;desc="00-trace-1-span-1-01"',
      });
    } finally {
      await client.stop();
      delete (globalThis as G).Deno;
    }
  });

  it('patches Deno.serve BY DEFAULT (no flag)', async () => {
    type G = { Deno?: { serve: unknown } };
    const realServe = vi.fn();
    (globalThis as G).Deno = { serve: realServe };
    const client = launch('tok', base());
    try {
      expect((globalThis as G).Deno?.serve).not.toBe(realServe); // patched without any flag (default-on)
    } finally {
      await client.stop();
      expect((globalThis as G).Deno?.serve).toBe(realServe); // restored on stop
      delete (globalThis as G).Deno;
    }
  });

  it('does NOT patch Deno.serve when instrumentIncomingRequests is false (escape hatch)', async () => {
    type G = { Deno?: { serve: unknown } };
    const realServe = vi.fn();
    (globalThis as G).Deno = { serve: realServe };
    const client = launch('tok', base({ instrumentIncomingRequests: false }));
    try {
      expect((globalThis as G).Deno?.serve).toBe(realServe); // untouched (opted out)
    } finally {
      await client.stop();
      delete (globalThis as G).Deno;
    }
  });
});
