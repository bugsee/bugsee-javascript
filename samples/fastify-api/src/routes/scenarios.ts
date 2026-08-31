// Every /scenarios/* route from docs/samples/PLAN.md §4 (the shared catalog) + §5.14-5.20 (the
// framework-backend extras) + fastify-specific hook/plugin surfaces. Each route is deliberately small
// and does ONE thing so scripts/verify.ts and scenarios.md can point at it 1:1. Routes read a `marker`
// (query or body) that verify.ts sets to a per-run-unique string, embedded in every message/summary
// this scenario produces — that's how verify.ts (and get_issue afterwards) correlates a scenario run to
// the Bugsee issue(s) it created.
//
// Registered as a Fastify plugin at prefix /scenarios, INSIDE the primary scope (src/server.ts) — so it
// shares the primary client's setupFastify hooks and the process-wide node:http auto-instrument. It is
// NOT under the metrics plugin's bearer-auth hook (a sibling registration, not nested under it).
import { launch } from '@bugsee/fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPrimaryClient, requestContextStoreOf } from '../bugsee';
import { getCapturedBundles, getCapturedCalls, getCapturedTransactions } from '../bugsee-transport';

const THIRD_PARTY_PORT = process.env.THIRD_PARTY_PORT ?? '5405';
const thirdPartyUrl = (path: string): string => `http://127.0.0.1:${THIRD_PARTY_PORT}${path}`;

const markerOf = (req: FastifyRequest): string => {
  const q = req.query as Record<string, unknown> | undefined;
  const b = req.body as { marker?: string } | undefined;
  return (q?.marker as string | undefined) ?? b?.marker ?? `no-marker-${Date.now()}`;
};

export function buildScenariosPlugin() {
  return async function scenariosPlugin(fastify: FastifyInstance): Promise<void> {
    const client = () => {
      const c = getPrimaryClient();
      if (c === undefined) throw new Error('bugsee client not launched');
      return c;
    };

    // ---------------------------------------------------------------- S1 · Launch & lifecycle
    fastify.get('/s1/status', async (_req, reply) => {
      await reply.send({ isLaunched: client().isLaunched() });
    });

    fastify.post('/s1/flush', async (req: FastifyRequest, reply: FastifyReply) => {
      const t0 = Date.now();
      const flushed = await client().flush((req.body as { timeoutMs?: number })?.timeoutMs ?? 5000);
      await reply.send({ flushed, flushMs: Date.now() - t0 });
    });

    fastify.post('/s1/relaunch-noop', async (_req, reply) => {
      // A second launch() while launched must be ignored, not duplicated — the umbrella returns the
      // SAME client for the SAME carrier (globalThis, the default here).
      const before = client();
      const after = launch(process.env.BUGSEE_APP_TOKEN as string, {
        endpoint: process.env.BUGSEE_ENDPOINT,
      });
      await reply.send({ sameInstance: before === after });
    });

    // ---------------------------------------------------------------- S2 · Identity & attributes
    fastify.post('/s2/identity-attributes', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const c = client();
      c.clearAllAttributes();
      c.setAttribute('str_attr', `hello-${marker}`);
      c.setAttribute('num_attr', 42);
      c.setAttribute('bool_attr', true);
      c.setAttribute('arr_attr', ['a', 'b', 'c']);
      const beforeSnapshot = c.getAllAttributes();
      void c.logException(new Error(`s2-before-${marker}`), { mechanism: 'programmatic' });

      c.setAttribute('after_attr', `set-after-event-${marker}`);
      const afterSnapshot = c.getAllAttributes();
      void c.logException(new Error(`s2-after-${marker}`), { mechanism: 'programmatic' });

      await reply.send({
        userIdentifier: c.getUserIdentifier(),
        beforeSnapshot,
        afterSnapshot,
        getAttribute_num_attr: c.getAttribute('num_attr'),
      });
      // NOTE: deliberately NOT clearing `after_attr` here — see samples/express-api's twin scenario for
      // why (a race with the fire-and-forget async bundle assembly).
    });

    fastify.post('/s2/clear-attributes', async (_req, reply) => {
      const c = client();
      c.setAttribute('to_clear', 'x');
      c.clearAttribute('to_clear');
      // c.getAttribute() correctly returns `undefined` here, but JSON.stringify DROPS keys whose value is
      // `undefined` — the raw shape would silently vanish from the response body and scripts/verify.ts
      // could never assert on it. Represent "cleared" as `null` on the wire instead (a real JSON value);
      // the SDK API itself still returns `undefined`, this substitution is response-shaping only.
      const afterClearOneRaw = c.getAttribute('to_clear');
      c.setAttribute('another', 'y');
      c.clearAllAttributes();
      await reply.send({
        afterClearOne: afterClearOneRaw === undefined ? null : afterClearOneRaw,
        afterClearAll: c.getAllAttributes(),
      });
    });

    // ---------------------------------------------------------------- S3 · Manual telemetry
    fastify.post('/s3/telemetry', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const c = client();
      c.log(`s3-debug-${marker}`, 'debug');
      c.log(`s3-verbose-${marker}`, 'verbose');
      c.log(`s3-info-${marker}`, 'info');
      c.log(`s3-warning-${marker}`, 'warning');
      c.log(`s3-error-${marker}`, 'error');
      c.event('metric.scenario', { marker, count: 3 });
      c.event('metric.ping');
      c.trace('scenario-trace', { marker, value: 123 });
      c.addBreadcrumb({
        type: 'navigation',
        category: 'scenario',
        message: `s3-breadcrumb-${marker}`,
        level: 'info',
        data: { marker, step: 1 },
      });
      void c.logException(new Error(`s3-${marker}`), { mechanism: 'programmatic' });
      await reply.send({ ok: true, marker });
    });

    // ---------------------------------------------------------------- S4 · Exceptions
    fastify.post('/s4/error-instance', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      void client().logException(new Error(`s4-error-instance-${marker}`));
      await reply.send({ ok: true, marker });
    });

    fastify.post('/s4/non-error', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const c = client();
      void c.logException(`s4-string-${marker}`);
      void c.logException({ code: 'X', marker: `s4-object-${marker}` });
      void c.logException(null);
      await reply.send({ ok: true, marker });
    });

    fastify.post('/s4/cause', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const inner = new Error(`s4-cause-inner-${marker}`);
      const outer = new Error(`s4-cause-outer-${marker}`, { cause: inner });
      void client().logException(outer);
      await reply.send({ ok: true, marker });
    });

    fastify.post('/s4/options', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      void client().logException(new Error(`s4-options-${marker}`), {
        mechanism: 'programmatic',
        severity: 'critical',
        labels: ['sample-fastify-api', 's4-options', marker],
      });
      await reply.send({ ok: true, marker });
    });

    fastify.post('/s4/dedupe', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const err = new Error(`s4-dedupe-${marker}`);
      const r1 = await client().logException(err);
      const r2 = await client().logException(err); // SAME instance — must dedupe
      await reply.send({ ok: true, marker, r1, r2 });
    });

    fastify.post('/s4/storm', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const c = client();
      const started = Date.now();
      for (let i = 0; i < 200; i += 1) {
        void c.logException(new Error(`s4-storm-${marker}-${i}`));
      }
      // Measure responsiveness for real instead of asserting it: time a trivial event-loop round trip
      // AFTER the storm loop. If the 200 logException calls had blocked/starved the event loop (a
      // synchronous storm, a busy-looping rate limiter, ...) this would take far longer than a few
      // milliseconds; `setImmediate` only runs once the loop is free to process its next phase.
      const respStart = Date.now();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const responsivenessMs = Date.now() - respStart;
      await reply.send({
        ok: true,
        marker,
        tookMs: Date.now() - started,
        responsivenessMs,
        stillResponsive: responsivenessMs < 1000,
      });
    });

    // ---------------------------------------------------------------- S5 · Crashes
    fastify.get('/s5/route-throw', async (req: FastifyRequest) => {
      const marker = markerOf(req);
      throw new Error(`s5-route-throw-${marker}`);
    });

    fastify.get(
      '/s5/hook-throw',
      {
        preHandler: async (req: FastifyRequest) => {
          const marker = markerOf(req);
          throw new Error(`s5-hook-throw-${marker}`); // thrown BEFORE the route handler below runs
        },
      },
      async (_req, reply) => {
        await reply.send({ unreachable: true }); // never reached
      },
    );

    fastify.get('/s5/async-throw', async (req: FastifyRequest) => {
      const marker = markerOf(req);
      await Promise.resolve();
      // Fastify awaits an async handler and forwards a rejection to onError automatically — no manual
      // try/catch/done(err) needed.
      throw new Error(`s5-async-throw-${marker}`);
    });

    // A throw from an async handler registered inside a NESTED plugin (its own encapsulated scope) —
    // proves errors propagate correctly through Fastify's plugin/hook chain even when the throwing
    // route is not declared directly on this plugin.
    await fastify.register(
      async (nested: FastifyInstance) => {
        nested.get('/s5/async-plugin-throw', async (req: FastifyRequest) => {
          const marker = markerOf(req);
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error(`s5-async-plugin-throw-${marker}`);
        });
      },
      { prefix: '/nested' },
    );

    fastify.post('/s5/timeout-throw', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      // OUTSIDE the request/response cycle and outside any Fastify hook — this becomes a process-level
      // uncaughtException, caught only by @bugsee/node's detectCrashes.
      setTimeout(() => {
        throw new Error(`s5-timeout-throw-${marker}`);
      }, 10);
      await reply.status(202).send({ accepted: true, marker });
    });

    fastify.post('/s5/unhandled-rejection', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      // Fire-and-forget — deliberately not awaited/caught.
      void Promise.reject(new Error(`s5-unhandled-rejection-${marker}`));
      await reply.status(202).send({ accepted: true, marker });
    });

    // ---------------------------------------------------------------- S6 · Console capture
    fastify.post('/s6/console', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      // eslint-disable-next-line no-console
      console.log(`s6-log-${marker}`, 'multi-arg', 3, { nested: true });
      // eslint-disable-next-line no-console
      console.info(`s6-info-${marker}`);
      // eslint-disable-next-line no-console
      console.warn(`s6-warn-${marker}`);
      // eslint-disable-next-line no-console
      console.error(`s6-error-${marker}`);
      // eslint-disable-next-line no-console
      console.debug(`s6-debug-${marker}`);
      // eslint-disable-next-line no-console
      console.trace(`s6-trace-${marker}`);
      const circular: Record<string, unknown> = { marker };
      circular.self = circular;
      // eslint-disable-next-line no-console
      console.log('s6-circular', circular);
      void client().logException(new Error(`s6-${marker}`));
      await reply.send({ ok: true, marker });
    });

    // ---------------------------------------------------------------- S7 · Network capture
    fastify.get('/s7/fetch-get', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const r = await fetch(thirdPartyUrl('/ok'));
      const body = (await r.json()) as unknown;
      await reply.send({ marker, thirdPartyStatus: r.status, thirdPartyBody: body });
    });

    fastify.post('/s7/fetch-post-json', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const r = await fetch(thirdPartyUrl('/ok'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ marker }),
      });
      await reply.send({ marker, thirdPartyStatus: r.status, thirdPartyBody: await r.json() });
    });

    fastify.post('/s7/fetch-post-text', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const r = await fetch(thirdPartyUrl('/ok'), {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: `text-body-${marker}`,
      });
      await reply.send({ marker, thirdPartyStatus: r.status });
    });

    fastify.get('/s7/4xx', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const r = await fetch(thirdPartyUrl('/not-found'));
      await reply.send({ marker, thirdPartyStatus: r.status, ok: r.ok });
    });

    fastify.get('/s7/5xx', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const r = await fetch(thirdPartyUrl('/boom'));
      await reply.send({ marker, thirdPartyStatus: r.status, ok: r.ok });
    });

    fastify.get('/s7/connection-failure', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      try {
        await fetch('http://127.0.0.1:1/unreachable', { signal: AbortSignal.timeout(1000) });
        await reply.send({ marker, failed: false });
      } catch (err) {
        // The app's own error handling still works — capture doesn't swallow the failure.
        await reply.send({ marker, failed: true, error: err instanceof Error ? err.message : String(err) });
      }
    });

    fastify.get('/s7/large-body', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const r = await fetch(thirdPartyUrl('/large')); // body > maxNetworkBodySize (4096)
      const text = await r.text();
      await reply.send({ marker, thirdPartyStatus: r.status, bodyLength: text.length });
    });

    fastify.get('/s7/no-content-type', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const r = await fetch(thirdPartyUrl('/no-content-type'));
      const text = await r.text();
      await reply.send({
        marker,
        thirdPartyStatus: r.status,
        contentType: r.headers.get('content-type'),
        text,
      });
    });

    // ---------------------------------------------------------------- S8 · Filters & redaction
    const SECRET_LOG_MARKER = 'SECRET_LOG_VALUE';
    const VETO_MARKER = 'VETO_ME';
    let filtersInstalled = false;
    function installFiltersOnce(): void {
      if (filtersInstalled) return;
      filtersInstalled = true;
      const c = client();
      c.setLogEventFilter((event) => {
        if (event.message.includes(SECRET_LOG_MARKER)) {
          return { ...event, message: event.message.replace(SECRET_LOG_MARKER, '[redacted]') };
        }
        return event;
      });
      c.setBreadcrumbFilter((crumb) => (crumb.category === 'secret' ? null : crumb));
      c.setReportHandler({
        before: (request) => {
          if (request.report.summary?.includes(VETO_MARKER) === true) return null; // veto
          return {
            ...request,
            report: { ...request.report, labels: [...request.report.labels, 'mutated-by-report-handler'] },
          };
        },
      });
    }

    fastify.post('/s8/log-redaction', async (req: FastifyRequest, reply: FastifyReply) => {
      installFiltersOnce();
      const marker = markerOf(req);
      const c = client();
      c.log(`s8-contains-${SECRET_LOG_MARKER}-${marker}`, 'info');
      void c.logException(new Error(`s8-log-redaction-${marker}`));
      await reply.send({ ok: true, marker });
    });

    fastify.post('/s8/breadcrumb-drop', async (req: FastifyRequest, reply: FastifyReply) => {
      installFiltersOnce();
      const marker = markerOf(req);
      const c = client();
      c.addBreadcrumb({ category: 'secret', message: `dropped-${marker}`, level: 'info' });
      c.addBreadcrumb({ category: 'kept', message: `kept-${marker}`, level: 'info' });
      void c.logException(new Error(`s8-breadcrumb-drop-${marker}`));
      await reply.send({ ok: true, marker });
    });

    fastify.post('/s8/report-mutate', async (req: FastifyRequest, reply: FastifyReply) => {
      installFiltersOnce();
      const marker = markerOf(req);
      void client().logException(new Error(`s8-report-mutate-${marker}`));
      await reply.send({ ok: true, marker });
    });

    fastify.post('/s8/report-veto', async (req: FastifyRequest, reply: FastifyReply) => {
      installFiltersOnce();
      const marker = markerOf(req);
      void client().logException(new Error(`${VETO_MARKER}-s8-report-veto-${marker}`));
      await reply.send({ ok: true, marker });
    });

    fastify.post('/s8/network-filter', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const c = client();
      let installed = false;
      c.setNetworkEventFilter((event) => {
        installed = true;
        if (event.custom?.headers?.['x-secret-header'] !== undefined) {
          const headers = { ...event.custom.headers };
          delete headers['x-secret-header'];
          return { ...event, custom: { ...event.custom, headers } };
        }
        return event;
      });
      // `x-call-id` makes each of the two calls SELF-IDENTIFYING in the captured network trail. The
      // filter never touches it, so it survives into `custom.headers` on both. Without it the only
      // thing telling the filtered call apart from the control below is their ORDER in the captured
      // array — and "no x-secret-header, traceparent present" is true of the CONTROL entry too, so a
      // positional check would pass while looking at the wrong call (network capture is a ROLLING
      // trail shared with earlier scenarios, so position is not something this sample controls).
      await fetch(thirdPartyUrl('/echo-headers'), {
        headers: { 'x-secret-header': `s8-secret-${marker}`, 'x-call-id': `filtered-${marker}` },
      });
      c.setNetworkEventFilter(null); // don't leak this filter into other scenarios
      // Control call, filter REMOVED: same endpoint, a DIFFERENT header (content-type) that the filter
      // never touched. Proves the strip above was scoped to the one filtered call, not a global redact —
      // scripts/verify.ts compares the two captured entries' `custom.headers`.
      await fetch(thirdPartyUrl('/echo-headers'), {
        headers: { 'content-type': 'application/json', 'x-call-id': `control-${marker}` },
      });
      void c.logException(new Error(`s8-network-filter-${marker}`));
      await reply.send({ ok: true, marker, filterInvoked: installed });
    });

    // ---------------------------------------------------------------- S9 · Performance / APM
    fastify.post('/s9/manual-span', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const perf = client().ext('performance');
      const txn = perf.startTransaction({ name: `scenario.manual.${marker}`, operation: 'scenario' });
      const child = txn.startChildSpan('child.work', `child-${marker}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      child.setStatus('OK').finish();
      const child2 = txn.startChildSpan('child.other');
      child2.setStatus('ERROR').finish();
      const child3 = txn.startChildSpan('child.timeout');
      child3.setStatus('TIMEOUT').finish();
      const child4 = txn.startChildSpan('child.cancelled');
      child4.setStatus('CANCELLED').finish();
      const child5 = txn.startChildSpan('child.deadline');
      child5.setStatus('DEADLINE_EXCEEDED').finish();
      const child6 = txn.startChildSpan('child.unknown');
      child6.setStatus('UNKNOWN').finish();
      txn.finish('OK');
      await reply.send({ ok: true, marker, transactionName: txn.getName(), traceId: txn.getTraceId() });
    });

    fastify.post('/s9/route-name', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      client().ext('performance').setRouteName(`/scenarios/s9/named/${marker}`);
      await reply.send({ ok: true, marker });
    });

    // ---------------------------------------------------------------- S10 · Distributed tracing
    fastify.get('/s10/outbound-trace', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      const r = await fetch(thirdPartyUrl('/alert'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `trace-${marker}` }),
      });
      const body = (await r.json()) as { traceparentSeen?: string | null };
      await reply.send({ marker, traceparentReceivedByThirdParty: body.traceparentSeen });
    });

    // ---------------------------------------------------------------- S12 · Persistence & recovery
    fastify.get('/s12/info', async (_req, reply) => {
      await reply.send({
        capturedDataStore: 'disk',
        dataDir: process.env.BUGSEE_DATA_DIR ?? '(default os.tmpdir()/bugsee)',
        note: 'see scenarios.md S12 for the manual SIGKILL-recovery reproduction (needs a process restart).',
      });
    });

    // ---------------------------------------------------------------- concurrency (S2 + §5.14-20)
    fastify.get('/concurrency/hit', async (req: FastifyRequest) => {
      const marker = markerOf(req);
      const query = req.query as Record<string, unknown>;
      const idx = query.idx as string;
      const delayMs = Number(query.delayMs ?? 0);
      const c = client();
      const store = requestContextStoreOf(c);
      store?.setAttribute('scenario.req_index', idx);
      c.log(`concurrency-log-${marker}-${idx}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      throw new Error(`concurrency-${marker}-${idx}`);
    });

    // ---------------------------------------------------------------- route naming (nested plugin)
    await fastify.register(
      async (level1: FastifyInstance) => {
        await level1.register(
          async (level2: FastifyInstance) => {
            level2.get(
              '/:id/items/:itemId',
              async (req: FastifyRequest<{ Params: { id: string; itemId: string } }>, reply) => {
                await reply.send({ pattern: req.routeOptions.url, url: req.url });
              },
            );
          },
          { prefix: '/deep' },
        );
      },
      { prefix: '/route-naming' },
    );

    // ---------------------------------------------------------------- first-owner-wins single-hit probe
    fastify.get('/s14/single-hit', async (req: FastifyRequest, reply: FastifyReply) => {
      const marker = markerOf(req);
      await reply.send({ ok: true, marker });
    });

    // A custom fastify.setErrorHandler on a NESTED plugin — proves onError (Bugsee's hook) fires
    // independently of a framework-level error handler that rewrites the response.
    await fastify.register(
      async (custom: FastifyInstance) => {
        custom.setErrorHandler(async (err, _req, reply) => {
          await reply.status(200).send({ handledByCustomErrorHandler: true, message: (err as Error).message });
        });
        custom.get('/throw', async (req: FastifyRequest) => {
          const marker = markerOf(req);
          throw new Error(`s14-custom-handler-throw-${marker}`);
        });
      },
      { prefix: '/s14/custom-handler' },
    );

    // ---------------------------------------------------------------- 4xx must NOT report / 5xx MUST
    fastify.get('/status/4xx', async (_req, reply) => {
      await reply.status(400).send({ error: 'a normal validation-style 4xx — never thrown' });
    });
    fastify.get('/status/5xx-thrown', async (req: FastifyRequest) => {
      const marker = markerOf(req);
      const err = new Error(`s-5xx-thrown-${marker}`) as Error & { statusCode?: number };
      err.statusCode = 500;
      throw err;
    });

    // ---------------------------------------------------------------- wire-level debug surface
    fastify.get('/_debug/bundles', async (_req, reply) => {
      await reply.send(getCapturedBundles());
    });
    fastify.get('/_debug/transactions', async (_req, reply) => {
      await reply.send(getCapturedTransactions());
    });
    fastify.get('/_debug/calls', async (_req, reply) => {
      await reply.send(getCapturedCalls());
    });

    // ------------------------------------------------- S2 (continued) · clearUserIdentifier
    // PLACED AT THE VERY END OF THIS FILE ON PURPOSE, far from the S2 block it belongs to. See
    // scenarios.md's fingerprinting note: Bugsee fingerprints an issue on `file:line`, so every
    // throw/`logException` call site above mints its issue at the line it currently occupies, and
    // inserting a route anywhere earlier shifts those lines and re-mints the whole `SFASTIFY` set.
    // The last fingerprint-sensitive line in this file is the `throw err` in `/status/5xx-thrown`;
    // everything below it (the `_debug` surface and this route) never reaches the reporter, so
    // appending here shifts nothing and mints nothing. Anyone moving this route back up beside its
    // siblings pays for it with a fresh set of issue keys.
    //
    // PLAN §4 S2 asks for `setUserIdentifier`/`getUserIdentifier`/`clearUserIdentifier`. The first two
    // are covered by `/s2/identity-attributes` and by the launch-time call in `src/bugsee.ts`; the
    // third was neither exercised nor recorded N/A until this fix round.
    //
    // The identity is PROCESS-GLOBAL, so the route restores what it found before replying — leaving it
    // cleared would strip the user off every report the rest of the sweep produces. Every statement
    // between the clear and the restore is synchronous: nothing can submit a report inside that window
    // and snapshot the temporary value.
    fastify.post('/s2/user-identifier', async (_req, reply) => {
      const c = client();
      const initial = c.getUserIdentifier();
      c.setUserIdentifier('temp-identity@bugsee.dev');
      const afterSet = c.getUserIdentifier();
      c.clearUserIdentifier();
      // Same `undefined`-is-dropped-by-JSON.stringify hazard the `/s2/clear-attributes` route documents:
      // represent "cleared" as a real JSON `null` so verify.ts can assert on it. The API's own contract
      // is `string | null` (packages/core/src/client.ts:155), so this is a no-op for a correct SDK and
      // only guards against a regression that returns `undefined`.
      const afterClear = c.getUserIdentifier();
      if (initial !== null) c.setUserIdentifier(initial);
      await reply.send({
        initial,
        afterSet,
        afterClear: afterClear === undefined ? null : afterClear,
        restored: c.getUserIdentifier(),
      });
    });
  };
}
