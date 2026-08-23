import type { Clock, HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
import type { Bugsee, NodeRuntime } from '@bugsee/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launch as launchBun } from './bun';
import { launch as launchDeno } from './deno';
import { launch as launchNode } from './node';

// WAVE 3b.1 / 4.1 — the umbrella's three SERVER entries.
//
// The umbrella had only `browser` / `node` / `default` conditions, so Bun and Deno — which set `node` too —
// resolved to `@bugsee/node`. A customer on the documented single-install path silently lost every
// runtime-specific default: `@bugsee/bun` supplies the `Bun.serve` interceptor (idiomatic
// `Bun.serve({fetch})` apps bypass node:http entirely, so they were NOT instrumented at all), a guarded
// perf_hooks metrics sampler, and the runtime identity. Measured through the real e2e harness before the
// fix: Bun 1.3.14 reported as `node` 24.3.0, Deno 2.8.3 as `node` 24.15.0.
//
// These run under Node — which is exactly the point of a condition-selected entry: only the runtime that
// resolves it ever executes it, so nothing else in the suite would ever load these two files. They assert
// the BINDING (which composition root each entry runs), while the cross-runtime e2e asserts the
// RESOLUTION (which entry each runtime actually gets).

function fakeProcess(): NodeRuntime {
  const proc: NodeRuntime = {
    on: () => proc,
    off: () => proc,
    exit: () => {},
  };
  return proc;
}

const fixedClock: Clock = { wallNow: () => 5000, monotonicNow: () => 0 };
const jsonBody = (obj: unknown): Uint8Array => new Uint8Array(Buffer.from(JSON.stringify(obj)));

/** A transport that keeps the `environment` the session-create POST carried — the runtime identity. */
function recordingTransport() {
  const sessions: Array<{ runtime: { type: string; version: string } }> = [];
  const fn = vi.fn<HttpTransport>(async (url: string, opts: HttpRequestOptions = {}) => {
    if (url.endsWith('/v2/sessions')) {
      const body = JSON.parse(String(opts.body)) as {
        environment: { runtime: { type: string; version: string } };
      };
      sessions.push(body.environment);
      return { status: 200, headers: {}, body: jsonBody({ access_token: 'tok' }) };
    }
    if (url.endsWith('/v2/issues')) {
      return {
        status: 200,
        headers: {},
        body: jsonBody({ endpoint: 'https://put.test/1', issueId: 'i1', recordingId: 'r1' }),
      };
    }
    return { status: 200, headers: {}, body: new Uint8Array() } satisfies HttpResponse;
  });
  return { fn, sessions };
}

const launched: Bugsee[] = [];
const track = (c: Bugsee): Bugsee => {
  launched.push(c);
  return c;
};
afterEach(async () => {
  await Promise.all(launched.splice(0).map((c) => c.stop()));
  delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
});

const base = (transport: HttpTransport) => ({
  process: fakeProcess(),
  captureNetwork: false,
  capturedDataStore: 'memory' as const,
  clock: fixedClock,
  transport,
  monitoring: false, // the extension wiring is covered by node.test.ts; these assert the composition root
  carrier: {},
  detectHangs: false,
  profiling: false,
  recover: false,
});

/**
 * The runtime identity the SDK reports on the wire, which is what names the composition root that ran.
 * Read from the session-create POST rather than from the client object, because that is where it actually
 * reaches the collector — and therefore what a customer sees.
 */
const runtimeFromWire = async (
  launch: (token: string, options: ReturnType<typeof base>) => Bugsee,
): Promise<{ type: string; version: string }> => {
  const { fn, sessions } = recordingTransport();
  const client = track(launch('tok', base(fn)));
  client.logException(new Error('x'));
  await client.flush(5000);
  return sessions[0]?.runtime ?? { type: '', version: '' };
};

describe('the umbrella server entries bind their OWN runtime', () => {
  it('the bun entry runs @bugsee/bun’s composition root', async () => {
    // `@bugsee/bun` differs from `@bugsee/node` in its DEFAULTS — the identity probe among them — so the
    // reported runtime type is what distinguishes which launchCore actually ran.
    expect((await runtimeFromWire(launchBun)).type).toBe('bun');
  });

  it('the deno entry runs @bugsee/deno’s composition root', async () => {
    expect((await runtimeFromWire(launchDeno)).type).toBe('deno');
  });

  it('the node entry still runs @bugsee/node’s — the canary', async () => {
    // Without this, "each entry binds its own" would also be satisfied by all three binding to bun.
    expect((await runtimeFromWire(launchNode)).type).toBe('node');
  });

  it('every entry returns a usable client', () => {
    for (const launch of [launchBun, launchDeno, launchNode]) {
      const client = track(launch('tok', base(recordingTransport().fn)));
      expect(typeof client.logException).toBe('function');
      expect(typeof client.stop).toBe('function');
    }
  });
});
