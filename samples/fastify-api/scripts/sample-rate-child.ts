// A disposable child process proving `performanceSampleRate: 0` genuinely suppresses EVERY performance
// transaction on the wire — docs/samples/PLAN.md §4 S9's "performanceSampleRate at 0 AND 1" contract.
// The primary server (src/bugsee.ts) only ever exercises rate 1 (to keep every S9 scenario's evidence
// flowing); this script is the rate-0 half, run in its own process so it never affects the primary
// server's own sampling.
//
// Run as a SEPARATE PROCESS for the same reason as scripts/adapter-alone-child.ts: launching a second
// Bugsee client in-process would be a weaker test of the real customer configuration path, and keeps
// this script self-contained/disposable like its siblings.
//
// Usage: tsx scripts/sample-rate-child.ts <port>
// Prints one JSON line to stdout: { httpServerTransactionCount, bundleArrived }.
import 'dotenv/config';
import Fastify from 'fastify';
import { launch, setupFastify } from '@bugsee/fastify';
import { createTeeTransport, getCapturedBundles, getCapturedTransactions } from '../src/bugsee-transport';

const port = Number(process.argv[2] ?? '5408');
const appToken = process.env.BUGSEE_APP_TOKEN as string;
const marker = process.argv[3] ?? `rate0-${Date.now()}`;

async function main(): Promise<void> {
  const client = launch(appToken, {
    endpoint: process.env.BUGSEE_ENDPOINT,
    appVersion: '1.0.0',
    appBuild: 'sample-rate-child',
    capturedDataStore: 'memory',
    detectHangs: false,
    performanceMonitoring: true,
    // THE point of this process: at rate 0, NO transaction (auto http.server included) may ever reach
    // the wire — packages/performance/src/controller.ts's onFinish only calls `store.add`/`onFinished`
    // when `finished.isSampled()` is true, and the sampler is built from this rate.
    performanceSampleRate: 0,
    performanceFlushIntervalMs: 300,
    instrumentIncomingRequests: false,
    transport: createTeeTransport() as never,
  });

  const app = Fastify();
  setupFastify(app, { getClient: () => client });
  app.get('/rate-zero/hit', async (_req, reply) => {
    await reply.send({ ok: true });
  });

  await app.listen({ port, host: '127.0.0.1' });
  // Several requests, not one — if even a single one leaked through despite rate 0 that is the defect.
  for (let i = 0; i < 5; i += 1) {
    await fetch(`http://127.0.0.1:${port}/rate-zero/hit`);
  }

  // Control: prove the client/transport pipeline is genuinely alive (so "zero transactions" below means
  // "rate 0 suppressed them", not "the pipeline is broken and nothing gets through at all") by sending a
  // real report through the SAME client and confirming its bundle arrives.
  //
  // IMPORTANT — what this control does and does NOT prove: `logException` travels the bundle-PUT path
  // (`/v2/issues` + a zip upload), never `/v2/performance/transactions`. A bundle arriving proves the
  // CLIENT/TRANSPORT is alive; it does NOT by itself prove this exact config (performanceMonitoring:true,
  // instrumentIncomingRequests:false, etc.) would have emitted a transaction at rate 1 — a separately
  // broken performance pipeline would leave this control green while ALSO leaving
  // `httpServerTransactionCount === 0` for the wrong reason. That second half of the argument is only
  // closed by `scripts/adapter-alone-child.ts`, which runs the IDENTICAL config (same
  // `capturedDataStore`/`detectHangs`/`performanceMonitoring`/`instrumentIncomingRequests`, differing
  // ONLY in `performanceSampleRate: 1` vs this script's `0`) and records exactly 1 `http.server`
  // transaction there. Together the two scripts form one control: "the pipeline produces a transaction
  // at rate 1, and produces none at rate 0" — a genuine A/B, not two independent unconnected asserts. If
  // you edit either script's launch options, keep them in lockstep. TWO differences are deliberate
  // and must stay: the sample-rate knob itself, and `performanceFlushIntervalMs` (300 here, 500 in
  // adapter-alone-child.ts) which only affects how fast each child settles. Anything else diverging
  // silently breaks the A/B this pair exists to be, and the linkage stops holding.
  void client.logException(new Error(`sample-rate-child-pipeline-alive-${marker}`));

  const deadline = Date.now() + 10_000;
  let bundleArrived = false;
  while (Date.now() < deadline) {
    bundleArrived = getCapturedBundles().some((b) =>
      String(b.bundle?.request?.summary ?? '').includes(`sample-rate-child-pipeline-alive-${marker}`),
    );
    if (bundleArrived) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  // One more short window past the flush interval to give a (would-be) leaked transaction every chance
  // to show up before we declare it absent.
  await new Promise((resolve) => setTimeout(resolve, 800));

  const httpTxns = getCapturedTransactions()
    .flatMap((c) => c.transactions ?? [])
    .filter((t) => t.op === 'http.server');

  console.log(
    JSON.stringify({
      bundleArrived,
      httpServerTransactionCount: httpTxns.length,
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
