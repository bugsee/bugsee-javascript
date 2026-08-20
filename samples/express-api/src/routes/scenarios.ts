// Every /scenarios/* route from docs/samples/PLAN.md §4 (the shared catalog) + §5.14-5.20 (the
// framework-backend extras). Each route is deliberately small and does ONE thing so scripts/verify.ts
// and scenarios.md can point at it 1:1. Routes read a `marker` (query or body) that verify.ts sets to a
// per-run-unique string, embedded in every message/summary this scenario produces — that's how
// verify.ts (and get_issue afterwards) correlates a scenario run to the Bugsee issue(s) it created.
import { launch } from '@bugsee/express';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { getCapturedBundles, getCapturedCalls, getCapturedTransactions } from '../bugsee-transport';
import { getPrimaryClient, requestContextStoreOf } from '../bugsee';
import { buildAltRouter, launchSecondary } from '../secondary';

const THIRD_PARTY_PORT = process.env.THIRD_PARTY_PORT ?? '5305';
const thirdPartyUrl = (path: string): string => `http://127.0.0.1:${THIRD_PARTY_PORT}${path}`;

const markerOf = (req: Request): string =>
  (req.query.marker as string | undefined) ??
  (req.body as { marker?: string } | undefined)?.marker ??
  `no-marker-${Date.now()}`;

export function buildScenariosRouter(): Router {
  const router = Router();
  const client = () => {
    const c = getPrimaryClient();
    if (c === undefined) throw new Error('bugsee client not launched');
    return c;
  };

  // ---------------------------------------------------------------- S1 · Launch & lifecycle
  router.get('/s1/status', (_req: Request, res: Response) => {
    res.json({ isLaunched: client().isLaunched() });
  });

  router.post('/s1/flush', async (req: Request, res: Response) => {
    const flushed = await client().flush(Number(req.body?.timeoutMs ?? 5000));
    res.json({ flushed });
  });

  router.post('/s1/relaunch-noop', (_req: Request, res: Response) => {
    // A second launch() while launched must be ignored, not duplicated — the umbrella returns the SAME
    // client for the SAME carrier (globalThis, the default here).
    const before = client();
    const after = launch(process.env.BUGSEE_APP_TOKEN as string, {
      endpoint: process.env.BUGSEE_ENDPOINT,
    });
    res.json({ sameInstance: before === after });
  });

  // ---------------------------------------------------------------- S2 · Identity & attributes
  router.post('/s2/identity-attributes', (req: Request, res: Response) => {
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

    res.json({
      userIdentifier: c.getUserIdentifier(),
      beforeSnapshot,
      afterSnapshot,
      getAttribute_num_attr: c.getAttribute('num_attr'),
    });
    // NOTE: deliberately NOT clearing `after_attr` here. Both logException calls above are
    // fire-and-forget (never awaited) and the bundle is assembled asynchronously — clearing the
    // attribute immediately after `res.json()` raced the assembly of the "s2-after" report and won,
    // so the manifest.attrs snapshot never saw it. /scenarios/s2/clear-attributes is the dedicated
    // scenario for clearAttribute/clearAllAttributes instead.
  });

  router.post('/s2/clear-attributes', (_req: Request, res: Response) => {
    const c = client();
    c.setAttribute('to_clear', 'x');
    c.clearAttribute('to_clear');
    const afterClearOne = c.getAttribute('to_clear');
    c.setAttribute('another', 'y');
    c.clearAllAttributes();
    res.json({ afterClearOne, afterClearAll: c.getAllAttributes() });
  });

  // ---------------------------------------------------------------- S3 · Manual telemetry
  router.post('/s3/telemetry', (req: Request, res: Response) => {
    const marker = markerOf(req);
    const c = client();
    c.log(`s3-debug-${marker}`, 'debug');
    c.log(`s3-verbose-${marker}`, 'verbose');
    c.log(`s3-info-${marker}`, 'info');
    c.log(`s3-warning-${marker}`, 'warning');
    c.log(`s3-error-${marker}`, 'error');
    c.event('task.scenario', { marker, count: 3 });
    c.event('task.ping');
    c.trace('scenario-trace', { marker, value: 123 });
    c.addBreadcrumb({
      type: 'navigation',
      category: 'scenario',
      message: `s3-breadcrumb-${marker}`,
      level: 'info',
      data: { marker, step: 1 },
    });
    void c.logException(new Error(`s3-${marker}`), { mechanism: 'programmatic' });
    res.json({ ok: true, marker });
  });

  // ---------------------------------------------------------------- S4 · Exceptions
  router.post('/s4/error-instance', (req: Request, res: Response) => {
    const marker = markerOf(req);
    void client().logException(new Error(`s4-error-instance-${marker}`));
    res.json({ ok: true, marker });
  });

  router.post('/s4/non-error', (req: Request, res: Response) => {
    const marker = markerOf(req);
    const c = client();
    void c.logException(`s4-string-${marker}`);
    void c.logException({ code: 'X', marker: `s4-object-${marker}` });
    void c.logException(null);
    res.json({ ok: true, marker });
  });

  router.post('/s4/cause', (req: Request, res: Response) => {
    const marker = markerOf(req);
    const inner = new Error(`s4-cause-inner-${marker}`);
    const outer = new Error(`s4-cause-outer-${marker}`, { cause: inner });
    void client().logException(outer);
    res.json({ ok: true, marker });
  });

  router.post('/s4/options', (req: Request, res: Response) => {
    const marker = markerOf(req);
    void client().logException(new Error(`s4-options-${marker}`), {
      mechanism: 'programmatic',
      severity: 'critical',
      labels: ['sample-express-api', 's4-options', marker],
    });
    res.json({ ok: true, marker });
  });

  router.post('/s4/dedupe', async (req: Request, res: Response) => {
    const marker = markerOf(req);
    const err = new Error(`s4-dedupe-${marker}`);
    const r1 = await client().logException(err);
    const r2 = await client().logException(err); // SAME instance — must dedupe
    res.json({ ok: true, marker, r1, r2 });
  });

  router.post('/s4/storm', async (req: Request, res: Response) => {
    const marker = markerOf(req);
    const c = client();
    const started = Date.now();
    for (let i = 0; i < 200; i += 1) {
      void c.logException(new Error(`s4-storm-${marker}-${i}`));
    }
    res.json({ ok: true, marker, tookMs: Date.now() - started, stillResponsive: true });
  });

  // ---------------------------------------------------------------- S5 · Crashes
  router.get('/s5/route-throw', (req: Request) => {
    const marker = markerOf(req);
    throw new Error(`s5-route-throw-${marker}`);
  });

  router.get(
    '/s5/middleware-throw',
    (req: Request, _res: Response, _next: NextFunction) => {
      const marker = markerOf(req);
      throw new Error(`s5-middleware-throw-${marker}`); // thrown BEFORE the route handler below runs
    },
    (_req: Request, res: Response) => {
      res.json({ unreachable: true }); // never reached
    },
  );

  router.get('/s5/async-throw', async (req: Request) => {
    const marker = markerOf(req);
    await Promise.resolve();
    // Express 5 forwards a rejected handler promise to the error middleware automatically — no
    // try/catch/next(err) needed, unlike Express 4.
    throw new Error(`s5-async-throw-${marker}`);
  });

  router.post('/s5/timeout-throw', (req: Request, res: Response) => {
    const marker = markerOf(req);
    // OUTSIDE the request/response cycle and outside any Express error middleware — this becomes a
    // process-level uncaughtException, caught only by @bugsee/node's detectCrashes.
    setTimeout(() => {
      throw new Error(`s5-timeout-throw-${marker}`);
    }, 10);
    res.status(202).json({ accepted: true, marker });
  });

  router.post('/s5/unhandled-rejection', (req: Request, res: Response) => {
    const marker = markerOf(req);
    // Fire-and-forget — deliberately not awaited/caught.
    void Promise.reject(new Error(`s5-unhandled-rejection-${marker}`));
    res.status(202).json({ accepted: true, marker });
  });

  // ---------------------------------------------------------------- S6 · Console capture
  router.post('/s6/console', (req: Request, res: Response) => {
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
    res.json({ ok: true, marker });
  });

  // ---------------------------------------------------------------- S7 · Network capture
  router.get('/s7/fetch-get', async (req: Request, res: Response) => {
    const marker = markerOf(req);
    const r = await fetch(thirdPartyUrl('/ok'));
    const body = (await r.json()) as unknown;
    res.json({ marker, thirdPartyStatus: r.status, thirdPartyBody: body });
  });

  router.post('/s7/fetch-post-json', async (req: Request, res: Response) => {
    const marker = markerOf(req);
    const r = await fetch(thirdPartyUrl('/ok'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marker }),
    });
    res.json({ marker, thirdPartyStatus: r.status, thirdPartyBody: await r.json() });
  });

  router.post('/s7/fetch-post-text', async (req: Request, res: Response) => {
    const marker = markerOf(req);
    const r = await fetch(thirdPartyUrl('/ok'), {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: `text-body-${marker}`,
    });
    res.json({ marker, thirdPartyStatus: r.status });
  });

  router.get('/s7/4xx', async (req: Request, res: Response) => {
    const marker = markerOf(req);
    const r = await fetch(thirdPartyUrl('/not-found'));
    res.json({ marker, thirdPartyStatus: r.status, ok: r.ok });
  });

  router.get('/s7/5xx', async (req: Request, res: Response) => {
    const marker = markerOf(req);
    const r = await fetch(thirdPartyUrl('/boom'));
    res.json({ marker, thirdPartyStatus: r.status, ok: r.ok });
  });

  router.get('/s7/connection-failure', async (req: Request, res: Response) => {
    const marker = markerOf(req);
    try {
      await fetch('http://127.0.0.1:1/unreachable', { signal: AbortSignal.timeout(1000) });
      res.json({ marker, failed: false });
    } catch (err) {
      // The app's own error handling still works — capture doesn't swallow the failure.
      res.json({ marker, failed: true, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/s7/large-body', async (req: Request, res: Response) => {
    const marker = markerOf(req);
    const r = await fetch(thirdPartyUrl('/large')); // body > maxNetworkBodySize (4096)
    const text = await r.text();
    res.json({ marker, thirdPartyStatus: r.status, bodyLength: text.length });
  });

  router.get('/s7/no-content-type', async (req: Request, res: Response) => {
    const marker = markerOf(req);
    const r = await fetch(thirdPartyUrl('/no-content-type'));
    const text = await r.text();
    res.json({ marker, thirdPartyStatus: r.status, contentType: r.headers.get('content-type'), text });
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
        return { ...request, report: { ...request.report, labels: [...request.report.labels, 'mutated-by-report-handler'] } };
      },
    });
  }

  router.post('/s8/log-redaction', (req: Request, res: Response) => {
    installFiltersOnce();
    const marker = markerOf(req);
    const c = client();
    c.log(`s8-contains-${SECRET_LOG_MARKER}-${marker}`, 'info');
    void c.logException(new Error(`s8-log-redaction-${marker}`));
    res.json({ ok: true, marker });
  });

  router.post('/s8/breadcrumb-drop', (req: Request, res: Response) => {
    installFiltersOnce();
    const marker = markerOf(req);
    const c = client();
    c.addBreadcrumb({ category: 'secret', message: `dropped-${marker}`, level: 'info' });
    c.addBreadcrumb({ category: 'kept', message: `kept-${marker}`, level: 'info' });
    void c.logException(new Error(`s8-breadcrumb-drop-${marker}`));
    res.json({ ok: true, marker });
  });

  router.post('/s8/report-mutate', (req: Request, res: Response) => {
    installFiltersOnce();
    const marker = markerOf(req);
    void client().logException(new Error(`s8-report-mutate-${marker}`));
    res.json({ ok: true, marker });
  });

  router.post('/s8/report-veto', (req: Request, res: Response) => {
    installFiltersOnce();
    const marker = markerOf(req);
    // logException derives `summary` from the error message, so embedding VETO_MARKER in the message
    // vetoes this report — it must NEVER reach the backend.
    void client().logException(new Error(`${VETO_MARKER}-s8-report-veto-${marker}`));
    res.json({ ok: true, marker });
  });

  router.post('/s8/network-filter', async (req: Request, res: Response) => {
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
    await fetch(thirdPartyUrl('/echo-headers'), { headers: { 'x-secret-header': `s8-secret-${marker}` } });
    c.setNetworkEventFilter(null); // don't leak this filter into other scenarios
    void c.logException(new Error(`s8-network-filter-${marker}`));
    res.json({ ok: true, marker, filterInvoked: installed });
  });

  // ---------------------------------------------------------------- S9 · Performance / APM
  router.post('/s9/manual-span', async (req: Request, res: Response) => {
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
    res.json({ ok: true, marker, transactionName: txn.getName(), traceId: txn.getTraceId() });
  });

  router.post('/s9/route-name', (req: Request, res: Response) => {
    const marker = markerOf(req);
    client().ext('performance').setRouteName(`/scenarios/s9/named/${marker}`);
    res.json({ ok: true, marker });
  });

  // ---------------------------------------------------------------- S10 · Distributed tracing
  router.get('/s10/outbound-trace', async (req: Request, res: Response) => {
    const marker = markerOf(req);
    const r = await fetch(thirdPartyUrl('/score'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `trace-${marker}` }),
    });
    const body = (await r.json()) as { traceparentSeen?: string | null };
    res.json({ marker, traceparentReceivedByThirdParty: body.traceparentSeen });
  });

  // ---------------------------------------------------------------- S12 · Persistence & recovery
  router.get('/s12/info', (_req: Request, res: Response) => {
    res.json({
      capturedDataStore: 'disk',
      dataDir: process.env.BUGSEE_DATA_DIR ?? '(default os.tmpdir()/bugsee)',
      note: 'see scenarios.md S12 for the manual SIGKILL-recovery reproduction (needs a process restart).',
    });
  });

  // ---------------------------------------------------------------- concurrency (S2 + §5.14-20)
  router.get('/concurrency/hit', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const marker = markerOf(req);
      const idx = req.query.idx as string;
      const c = client();
      const store = requestContextStoreOf(c);
      store?.setAttribute('scenario.req_index', idx);
      c.log(`concurrency-log-${marker}-${idx}`);
      await new Promise((resolve) => setTimeout(resolve, Number(req.query.delayMs ?? 0)));
      throw new Error(`concurrency-${marker}-${idx}`);
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------- route naming
  router.get('/route-naming/:id/tasks/:taskId', (req: Request, res: Response) => {
    res.json({ pattern: req.route?.path, baseUrl: req.baseUrl, originalUrl: req.originalUrl });
  });

  // ---------------------------------------------------------------- 4xx must NOT report / 5xx MUST
  router.get('/status/4xx', (_req: Request, res: Response) => {
    res.status(400).json({ error: 'a normal validation-style 4xx — never thrown, never reported' });
  });
  router.get('/status/5xx-thrown', (req: Request) => {
    const marker = markerOf(req);
    const err = new Error(`s-5xx-thrown-${marker}`) as Error & { status?: number };
    err.status = 500;
    throw err;
  });

  // ---------------------------------------------------------------- the "adapter alone" secondary app
  router.use('/alt', buildAltRouter());
  router.get('/alt-status', (_req: Request, res: Response) => {
    res.json({ launched: launchSecondary().isLaunched() });
  });

  // ---------------------------------------------------------------- wire-level debug surface
  router.get('/_debug/bundles', (_req: Request, res: Response) => {
    res.json(getCapturedBundles());
  });
  router.get('/_debug/transactions', (_req: Request, res: Response) => {
    res.json(getCapturedTransactions());
  });
  router.get('/_debug/calls', (_req: Request, res: Response) => {
    // Every call the tee transport has seen this process's lifetime, unfiltered — the full picture
    // for diagnosing an upload that never reached bundle-upload status (still queued, retried, or
    // never attempted at all because of the SDK's own rate limiter).
    res.json(getCapturedCalls());
  });

  return router;
}
