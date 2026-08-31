// A disposable child process proving `@bugsee/fastify`'s `setupFastify` works COMPLETELY ON ITS OWN,
// with `instrumentIncomingRequests: false` (the node:http auto-instrument patch never installed) —
// docs/samples/PLAN.md §5.14-20's "adapter alone, exactly one context + one transaction" contract.
//
// Run as a SEPARATE PROCESS (not a route inside the long-running server) because
// `instrumentIncomingRequests` patches `http.Server.prototype.emit` PROCESS-WIDE: if this ran inside
// the primary server's process, the primary client's own (already-installed) node:http patch would
// still intercept every request here too, since the patch is shared across ALL http.Server instances
// in the process regardless of which Bugsee client's options asked for it. A separate process is the
// only way to observe "the adapter, and only the adapter" (see FINDINGS.md).
//
// Usage: tsx scripts/adapter-alone-child.ts <port>
// Prints one JSON line to stdout: { status, routePattern, httpServerTransactionCount,
// transactionNames, contextIdCount }. `transactionNames` is the load-bearing one — it is the name
// BUGSEE put on its own `http.server` transaction. `routePattern` is FASTIFY's own
// `req.routeOptions.url` (which `@bugsee/fastify` only reads, never writes), so it is a precondition
// on the sample's route registration, NOT evidence about the SDK; verify.ts labels the two that way.
import 'dotenv/config';
import Fastify from 'fastify';
import { launch, setupFastify } from '@bugsee/fastify';
import { RequestContextStoreToken } from '@bugsee/node';
import { createTeeTransport, getCapturedTransactions } from '../src/bugsee-transport';

const port = Number(process.argv[2] ?? '5407');
const appToken = process.env.BUGSEE_APP_TOKEN as string;

async function main(): Promise<void> {
  // LINKAGE (see scripts/sample-rate-child.ts's own comment): this config is the `performanceSampleRate:
  // 1` HALF of that script's rate-0/rate-1 A/B control. It is deliberately IDENTICAL to
  // sample-rate-child.ts's launch options (same `capturedDataStore`/`detectHangs`/
  // `performanceMonitoring`/`instrumentIncomingRequests`), differing in the sample rate and in
  // `performanceFlushIntervalMs` (500 here, 300 there — a deliberate timing-only knob, not part of
  // what the A/B proves). This
  // script recording exactly 1 `http.server` transaction here is what proves the rate-0 script's "zero
  // transactions" result means "rate 0 suppressed it", not "this config never produces one regardless of
  // rate". If you change this launch config, mirror the change in sample-rate-child.ts (aside from the
  // sample-rate knob itself) or the two scripts stop forming a real control.
  const client = launch(appToken, {
    endpoint: process.env.BUGSEE_ENDPOINT,
    appVersion: '1.0.0',
    appBuild: 'adapter-alone-child',
    capturedDataStore: 'memory',
    detectHangs: false,
    performanceMonitoring: true,
    performanceSampleRate: 1,
    performanceFlushIntervalMs: 500,
    // THE point of this process: prove the adapter works with node:http's own auto-instrument OFF.
    instrumentIncomingRequests: false,
    transport: createTeeTransport() as never,
  });

  const app = Fastify();
  setupFastify(app, { getClient: () => client });

  // "Exactly ONE context" (PLAN §5.14-20's first-owner-wins contract, the adapter-alone half): record
  // every DISTINCT RequestContext.contextId observed inside the route handler's async chain. With the
  // node:http patch OFF, setupFastify's own onRequest hook is the ONLY thing opening a context — a
  // regression that opened a second context per request (e.g. a double-instrumentation bug) would show
  // up here as contextIdCount > 1 for this single request.
  const contextIds = new Set<string>();
  const store = client.getServiceProvider(RequestContextStoreToken).getImmediate({ optional: true });

  app.register(
    async (nested) => {
      nested.get('/items/:id/sub/:subId', async (req, reply) => {
        const current = store?.getCurrent();
        if (current !== undefined) contextIds.add(current.contextId);
        await reply.send({ pattern: req.routeOptions.url, url: req.url });
      });
    },
    { prefix: '/nested' },
  );

  await app.listen({ port, host: '127.0.0.1' });
  const res = await fetch(`http://127.0.0.1:${port}/nested/items/abc/sub/def`);
  const body = (await res.json()) as { pattern?: string };

  await client.flush(3000);
  // client.flush() drains the CAPTURE/report pipeline; the performance extension's transaction batch
  // has its own independent timer (performanceFlushIntervalMs), so poll for evidence instead of a fixed
  // sleep — a fixed window fails in both directions (docs/samples/PLAN.md §"Timing" instruction).
  // Poll until the first sighting, THEN wait out one more flush interval and re-read (see below).
  const collectHttpTxns = (): Array<{ name: string; op?: string }> =>
    getCapturedTransactions()
      .flatMap((c) => c.transactions ?? [])
      .filter((t) => t.op === 'http.server');
  const deadline = Date.now() + 10_000;
  let httpTxns = collectHttpTxns();
  while (Date.now() < deadline && httpTxns.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    httpTxns = collectHttpTxns();
  }
  // GRACE WINDOW, then RE-COLLECT — the same treatment scripts/sample-rate-child.ts:81-83 gives its
  // absence claim, for the same reason. What verify.ts asserts on this output is a COUNT ("exactly ONE
  // http.server transaction, no double-instrumentation"), and a count is at least as timing-sensitive
  // as an absence: the loop above stops at the FIRST sighting, and transactions reach the tee in
  // batches on the performance extension's own timer (performanceFlushIntervalMs: 500 above, entirely
  // independent of client.flush()). A second, leaked transaction landing in a LATER batch would have
  // been invisible, so "exactly one" rested on both would-be owners finishing inside one batch — an
  // assumption about this run's timing, not about the SDK. 800 ms is > 1 flush interval, so a leak has
  // a full extra batch to surface in before the count is reported.
  await new Promise((resolve) => setTimeout(resolve, 800));
  httpTxns = collectHttpTxns();

  console.log(
    JSON.stringify({
      status: res.status,
      routePattern: body.pattern,
      httpServerTransactionCount: httpTxns.length,
      transactionNames: httpTxns.map((t) => t.name),
      contextIdCount: contextIds.size,
    }),
  );

  await app.close();
  await client.stop(2000);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
