// Durable Object RPC on REAL workerd (docs/review/cloudflare.md SEV1 #1).
//
// `instrumentRpcMethods: true | [names]` is a documented, advertised opt-in. On real workerd it did not
// merely fail to instrument — it DELETED the user's RPC surface: every instrumented method threw
// "The RPC receiver does not implement the method". That is breaking the customer's Worker, which the
// repo's own binding principle ("interceptors must not alter app behavior") forbids outright.
//
// Cloudflare's RPC dispatch exposes methods found on the PROTOTYPE. The instrumentation assigned its
// wrapper as an OWN property of the instance, which shadows the prototype method out of the RPC surface
// entirely. No test caught it because no test in the repo had ever run on workerd — @edge-runtime/vm has
// no RPC and no Durable Objects at all.
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type MockCollector, startMockCollector } from './collector';
import { bundleWorkerEntry } from './edge-bundle';

const entry = fileURLToPath(new URL('../app/do-rpc-worker.ts', import.meta.url));

describe('instrumented Durable Object methods stay callable over RPC', () => {
  let mf: Miniflare;
  let collector: MockCollector;

  beforeAll(async () => {
    collector = await startMockCollector();
    const script = await bundleWorkerEntry(entry);
    mf = new Miniflare({
      modules: true,
      script,
      // Required by @bugsee/cloudflare: AsyncLocalStorage is reachable only through node:async_hooks on
      // workerd (Wave 0.1 S0).
      compatibilityFlags: ['nodejs_compat'],
      compatibilityDate: '2026-07-01',
      durableObjects: { COUNTER: 'Counter' },
      bindings: { BUGSEE_ENDPOINT: collector.url },
    });
    await mf.ready;
  }, 120_000);

  afterAll(async () => {
    await mf?.dispose();
    await collector?.close();
  });

  it('an INSTRUMENTED method is callable over RPC and returns its real value', async () => {
    const res = await mf.dispatchFetch('http://x/increment');
    const body = await res.text();
    expect(body, `instrumented RPC call failed: ${body}`).toBe('2,5');
  });

  it('an UNINSTRUMENTED method on the same instance still works — the control', () => {
    // Distinguishes "instrumentation broke RPC" from "RPC is broken in this harness". Without it a failing
    // first assertion could mean either.
    return mf
      .dispatchFetch('http://x/untouched')
      .then((r) => r.text())
      .then((body) => expect(body).toBe('control-ok'));
  });
});
