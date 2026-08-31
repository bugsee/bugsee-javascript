// The Scenario panel — one control per scenario in docs/samples/PLAN.md §4, driven from plain DOM
// (no framework here; the package under test is the webpack build/source-map pipeline). Every control
// calls the REAL SDK API; see scenarios.md for what should appear in Bugsee for each.
import type { SpanStatus } from '@bugsee/performance';
import {
  attemptDuplicateLaunch,
  FULL_LAUNCH_OPTIONS,
  getClient,
  MINIMAL_LAUNCH_OPTIONS,
  onInternalError,
  relaunch,
} from './bugsee';

let container: HTMLElement | undefined;
let filtersInstalled = false;
const filterLog: string[] = [];
const internalErrors: string[] = [];

function setStatus(testid: string, text: string, ok = true): void {
  const el = container?.querySelector<HTMLElement>(`[data-status-for="${testid}"]`);
  if (!el) return;
  el.textContent = text;
  el.className = `status-line ${ok ? 'ok' : 'err'}`;
}

function logLine(list: string[], line: string, testid: string): void {
  list.unshift(line);
  list.splice(10);
  const el = container?.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  if (el) el.innerHTML = list.map((l) => `<div>${l}</div>`).join('');
}

function installFilters(): void {
  const c = getClient();
  if (!c) return;
  c.setNetworkEventFilter((event) => {
    const headers = (event as { custom?: { headers?: Record<string, string>; body?: unknown } }).custom
      ?.headers;
    const hadSecretHeader = headers ? 'x-secret-token' in headers : false;
    let body = (event as { custom?: { body?: unknown } }).custom?.body ?? null;
    const hadSsn = typeof body === 'string' && body.includes('123-45-6789');
    if (hadSsn && typeof body === 'string') body = body.replace(/123-45-6789/g, '[REDACTED]');
    logLine(
      filterLog,
      `network: ${event.url} — droppedSecretHeader=${hadSecretHeader} redactedSsn=${hadSsn}`,
      's8-filter-log',
    );
    if (event.url.includes('veto-me')) {
      logLine(filterLog, `network: VETOED ${event.url}`, 's8-filter-log');
      return null;
    }
    return {
      ...event,
      custom: {
        ...(event as { custom?: Record<string, unknown> }).custom,
        headers: headers
          ? Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'x-secret-token'))
          : headers,
        body,
      },
    } as typeof event;
  });
  c.setLogEventFilter((event) => {
    if (event.message.includes('SECRET_TOKEN')) {
      logLine(filterLog, `log: redacted "${event.message}"`, 's8-filter-log');
      return { ...event, message: event.message.replace(/SECRET_TOKEN=\S+/, 'SECRET_TOKEN=[REDACTED]') };
    }
    return event;
  });
  c.setBreadcrumbFilter((crumb) => {
    if (crumb.data && 'secret' in crumb.data) {
      logLine(filterLog, 'breadcrumb: redacted data.secret', 's8-filter-log');
      return { ...crumb, data: { ...crumb.data, secret: '[REDACTED]' } };
    }
    return crumb;
  });
  c.setReportHandler({
    before: (request) => {
      if (request.report.labels.includes('VETO_REPORT')) {
        logLine(filterLog, `report: VETOED ${request.id}`, 's8-filter-log');
        return null;
      }
      if (request.report.labels.includes('MUTATE_ME')) {
        logLine(filterLog, `report: mutated ${request.id}`, 's8-filter-log');
        return { ...request, report: { ...request.report, labels: [...request.report.labels, 'redacted-before'] } };
      }
      return request;
    },
  });
  filtersInstalled = true;
}

function uninstallFilters(): void {
  const c = getClient();
  c?.setNetworkEventFilter(null);
  c?.setLogEventFilter(null);
  c?.setBreadcrumbFilter(null);
  c?.setReportHandler(null);
  filtersInstalled = false;
}

const sharedError = new Error('shared instance — logException twice must dedupe');

function template(): string {
  return `
  <div class="scenario-panel">
    <h2>Scenario panel</h2>
    <p class="desc">One control per scenario in docs/samples/PLAN.md §4. Every control calls the real
    SDK API — see scenarios.md for what should appear in Bugsee for each.</p>

    <section class="scenario-section">
      <h3>S1 — Launch &amp; lifecycle</h3>
      <div class="control-row"><span class="label">isLaunched()</span><span data-testid="is-launched">${String(getClient()?.isLaunched())}</span></div>
      <div class="control-row"><button data-testid="s1-flush">Flush</button><span class="status-line" data-status-for="s1-flush"></span></div>
      <div class="control-row"><button data-testid="s1-duplicate-launch">Call launch() again</button><span class="status-line" data-status-for="s1-duplicate-launch"></span></div>
      <div class="control-row"><button data-testid="s1-relaunch-minimal">Relaunch minimal</button><span class="status-line" data-status-for="s1-relaunch-minimal"></span></div>
      <div class="control-row"><button data-testid="s1-relaunch-full">Relaunch full</button><span class="status-line" data-status-for="s1-relaunch-full"></span></div>
      <div class="control-row"><button data-testid="s1-stop">stop(timeout) directly</button><span class="status-line" data-status-for="s1-stop"></span></div>
    </section>

    <section class="scenario-section">
      <h3>S2 — Identity &amp; attributes</h3>
      <div class="control-row"><button data-testid="s2-set-user">setUserIdentifier</button><span class="status-line" data-status-for="s2-set-user"></span></div>
      <div class="control-row"><button data-testid="s2-clear-user">clearUserIdentifier</button><span class="status-line" data-status-for="s2-clear-user"></span></div>
      <div class="control-row"><button data-testid="s2-attributes">Set every AttributeValue type</button><span class="status-line" data-status-for="s2-attributes"></span></div>
      <div class="control-row"><button data-testid="s2-clear-attributes">clearAllAttributes</button><span class="status-line" data-status-for="s2-clear-attributes"></span></div>
      <div class="control-row"><button data-testid="s2-get-clear-attribute">getAttribute / clearAttribute (singular)</button><span class="status-line" data-status-for="s2-get-clear-attribute"></span></div>
      <div class="control-row"><button data-testid="s2-attr-before-after">attribute set before AND after a report</button><span class="status-line" data-status-for="s2-attr-before-after"></span></div>
    </section>

    <section class="scenario-section">
      <h3>S3 — Manual telemetry</h3>
      <div class="control-row"><button data-testid="s3-log">log() x5 levels</button><span class="status-line" data-status-for="s3-log"></span></div>
      <div class="control-row"><button data-testid="s3-event">event() with/without params</button><span class="status-line" data-status-for="s3-event"></span></div>
      <div class="control-row"><button data-testid="s3-trace">trace(name, value)</button><span class="status-line" data-status-for="s3-trace"></span></div>
      <div class="control-row"><button data-testid="s3-breadcrumb">addBreadcrumb() every field</button><span class="status-line" data-status-for="s3-breadcrumb"></span></div>
    </section>

    <section class="scenario-section">
      <h3>S4 — Exceptions</h3>
      <div class="control-row"><button data-testid="s4-error">logException(new Error)</button><span class="status-line" data-status-for="s4-error"></span></div>
      <div class="control-row"><button data-testid="s4-string">logException(string)</button><span class="status-line" data-status-for="s4-string"></span></div>
      <div class="control-row"><button data-testid="s4-object">logException(object)</button><span class="status-line" data-status-for="s4-object"></span></div>
      <div class="control-row"><button data-testid="s4-null">logException(null)</button><span class="status-line" data-status-for="s4-null"></span></div>
      <div class="control-row"><button data-testid="s4-cause">nested cause</button><span class="status-line" data-status-for="s4-cause"></span></div>
      <div class="control-row"><button data-testid="s4-options">LogExceptionOptions</button><span class="status-line" data-status-for="s4-options"></span></div>
      <div class="control-row"><button data-testid="s4-dedupe">same instance twice</button><span class="status-line" data-status-for="s4-dedupe"></span></div>
      <div class="control-row"><button data-testid="s4-storm">storm: 200 in ~1s</button><span class="status-line" data-status-for="s4-storm"></span></div>
    </section>

    <section class="scenario-section">
      <h3>S5 — Crashes</h3>
      <div class="control-row"><button data-testid="s5-uncaught">throw uncaught</button><span class="status-line" data-status-for="s5-uncaught"></span></div>
      <div class="control-row"><button data-testid="s5-rejection">unhandled rejection</button><span class="status-line" data-status-for="s5-rejection"></span></div>
    </section>

    <section class="scenario-section">
      <h3>S6 — Console capture</h3>
      <div class="control-row"><button data-testid="s6-console">console.* x6</button><span class="status-line" data-status-for="s6-console"></span></div>
      <div class="control-row"><button data-testid="s6-circular">circular object</button><span class="status-line" data-status-for="s6-circular"></span></div>
    </section>

    <section class="scenario-section">
      <h3>S7 — Network capture</h3>
      <div class="control-row"><button data-testid="s7-get">fetch GET</button><span class="status-line" data-status-for="s7-get"></span></div>
      <div class="control-row"><button data-testid="s7-post-json">fetch POST json</button><span class="status-line" data-status-for="s7-post-json"></span></div>
      <div class="control-row"><button data-testid="s7-4xx">4xx</button><span class="status-line" data-status-for="s7-4xx"></span></div>
      <div class="control-row"><button data-testid="s7-5xx">5xx</button><span class="status-line" data-status-for="s7-5xx"></span></div>
      <div class="control-row"><button data-testid="s7-connfail">connection failure</button><span class="status-line" data-status-for="s7-connfail"></span></div>
      <div class="control-row"><button data-testid="s7-large-body">body over maxNetworkBodySize</button><span class="status-line" data-status-for="s7-large-body"></span></div>
      <div class="control-row"><button data-testid="s7-no-content-type">no Content-Type</button><span class="status-line" data-status-for="s7-no-content-type"></span></div>
      <div class="control-row"><button data-testid="s7-xhr">XHR</button><span class="status-line" data-status-for="s7-xhr"></span></div>
      <div class="control-row"><button data-testid="s7-sse">SSE (EventSource)</button><span class="status-line" data-status-for="s7-sse"></span></div>
      <div class="control-row"><button data-testid="s7-ws">WebSocket send</button><span class="status-line" data-status-for="s7-ws"></span></div>
    </section>

    <section class="scenario-section">
      <h3>S8 — Filters &amp; redaction</h3>
      <div class="control-row">
        <button data-testid="s8-install">Install filters</button>
        <button data-testid="s8-uninstall" class="secondary">Uninstall</button>
      </div>
      <div class="control-row"><button data-testid="s8-network">trigger network (secret header + SSN body)</button><span class="status-line" data-status-for="s8-network"></span></div>
      <div class="control-row"><button data-testid="s8-veto-network">trigger network (veto-me)</button><span class="status-line" data-status-for="s8-veto-network"></span></div>
      <div class="control-row"><button data-testid="s8-log">log() with SECRET_TOKEN</button><span class="status-line" data-status-for="s8-log"></span></div>
      <div class="control-row"><button data-testid="s8-breadcrumb">breadcrumb with data.secret</button><span class="status-line" data-status-for="s8-breadcrumb"></span></div>
      <div class="control-row"><button data-testid="s8-report-mutate">report handler: mutate</button><span class="status-line" data-status-for="s8-report-mutate"></span></div>
      <div class="control-row"><button data-testid="s8-report-veto">report handler: veto</button><span class="status-line" data-status-for="s8-report-veto"></span></div>
      <div class="filter-log" data-testid="s8-filter-log"></div>
    </section>

    <section class="scenario-section">
      <h3>S9 — Performance / APM</h3>
      <div class="control-row"><button data-testid="s9-manual-transaction">manual transaction + every SpanStatus</button><span class="status-line" data-status-for="s9-manual-transaction"></span></div>
      <div class="control-row"><button data-testid="s9-set-route-name">setRouteName</button><span class="status-line" data-status-for="s9-set-route-name"></span></div>
      <div class="control-row"><button data-testid="s9-sample-rate-0">relaunch performanceSampleRate: 0</button><span class="status-line" data-status-for="s9-sample-rate-0"></span></div>
      <div class="control-row"><button data-testid="s9-sample-rate-1">relaunch performanceSampleRate: 1 (restore)</button><span class="status-line" data-status-for="s9-sample-rate-1"></span></div>
    </section>

    <section class="scenario-section">
      <h3>S10 — Distributed tracing</h3>
      <p class="na">N/A — see scenarios.md (no natural second-hop Bugsee-instrumented service in this
      sample's scope; the local API is a plain fixture server).</p>
    </section>

    <section class="scenario-section">
      <h3>S11 — Session replay</h3>
      <p class="na">N/A — see scenarios.md (out of scope: this sample's packages under test are the
      bundler plugins, not @bugsee/replay; browser-vanilla/react-spa already cover S11 exhaustively).</p>
    </section>

    <section class="scenario-section">
      <h3>S12 — Persistence &amp; recovery</h3>
      <div class="control-row"><button data-testid="s12-crash-and-reload">logException then hard reload</button><span class="status-line" data-status-for="s12-crash-and-reload"></span></div>
    </section>

    <section class="scenario-section">
      <h3>S13 — OpenTelemetry</h3>
      <p class="na">N/A — @bugsee/opentelemetry is wired on-by-default via the umbrella launch(), but
      no local OTel collector was stood up for this pass (matches react-spa's own reasoning).</p>
    </section>

    <section class="scenario-section">
      <h3>Internal errors</h3>
      <div class="filter-log" data-testid="internal-errors"></div>
    </section>
  </div>`;
}

function wire(): void {
  if (container === undefined) return;
  const q = <T extends HTMLElement = HTMLElement>(testid: string): T | null =>
    container!.querySelector<T>(`[data-testid="${testid}"]`);

  // ---- S1 -----------------------------------------------------------------------------------
  q('s1-flush')?.addEventListener('click', async () => {
    const ok = await getClient()?.flush(5000);
    setStatus('s1-flush', `flush -> ${String(ok)}`, ok === true);
  });
  q('s1-duplicate-launch')?.addEventListener('click', () => {
    const { sameInstance } = attemptDuplicateLaunch();
    setStatus('s1-duplicate-launch', `same instance returned: ${sameInstance}`, sameInstance);
  });
  q('s1-relaunch-minimal')?.addEventListener('click', async () => {
    await relaunch(MINIMAL_LAUNCH_OPTIONS);
    setStatus('s1-relaunch-minimal', `relaunched with minimal options, isLaunched: ${String(getClient()?.isLaunched() === true)}`, getClient()?.isLaunched() === true);
    rerenderIsLaunched();
  });
  q('s1-relaunch-full')?.addEventListener('click', async () => {
    await relaunch(FULL_LAUNCH_OPTIONS);
    setStatus('s1-relaunch-full', `relaunched with the full option set, isLaunched: ${String(getClient()?.isLaunched() === true)}`, getClient()?.isLaunched() === true);
    rerenderIsLaunched();
  });
  q('s1-stop')?.addEventListener('click', async () => {
    // S1 requires stop(timeout) exercised DIRECTLY, not only indirectly inside relaunch() (which calls
    // it as an implementation detail of switching option sets).
    const stopped = await getClient()?.stop(2000);
    const launchedAfterStop = getClient()?.isLaunched();
    setStatus(
      's1-stop',
      `stop(2000) -> ${String(stopped)}; isLaunched() after stop -> ${String(launchedAfterStop)}`,
      stopped === true && launchedAfterStop === false,
    );
    rerenderIsLaunched();
    // Restore full launch so the rest of the sweep runs against a normally-configured client.
    await relaunch(FULL_LAUNCH_OPTIONS);
    rerenderIsLaunched();
  });

  // ---- S2 -----------------------------------------------------------------------------------
  q('s2-set-user')?.addEventListener('click', () => {
    getClient()?.setUserIdentifier('scenario-panel-user@bugsee.dev');
    setStatus('s2-set-user', `getUserIdentifier() -> ${getClient()?.getUserIdentifier()}`);
  });
  q('s2-clear-user')?.addEventListener('click', () => {
    getClient()?.clearUserIdentifier();
    setStatus('s2-clear-user', `getUserIdentifier() -> ${getClient()?.getUserIdentifier()}`);
  });
  q('s2-attributes')?.addEventListener('click', () => {
    const c = getClient();
    c?.setAttribute('str_attr', 'a string');
    c?.setAttribute('num_attr', 42);
    c?.setAttribute('bool_attr', true);
    c?.setAttribute('list_attr', ['alpha', 'beta', 'gamma']);
    setStatus('s2-attributes', JSON.stringify(c?.getAllAttributes()));
  });
  q('s2-clear-attributes')?.addEventListener('click', () => {
    getClient()?.clearAllAttributes();
    setStatus('s2-clear-attributes', JSON.stringify(getClient()?.getAllAttributes()));
  });
  q('s2-get-clear-attribute')?.addEventListener('click', () => {
    const c = getClient();
    c?.setAttribute('singular_attr', 'present');
    const before = c?.getAttribute('singular_attr');
    c?.clearAttribute('singular_attr');
    const after = c?.getAttribute('singular_attr');
    setStatus(
      's2-get-clear-attribute',
      `getAttribute before clearAttribute: ${JSON.stringify(before)}; after: ${JSON.stringify(after)}`,
      before === 'present' && after === undefined,
    );
  });
  q('s2-attr-before-after')?.addEventListener('click', () => {
    const c = getClient();
    c?.setAttribute('before_report_attr', 'set-before');
    const report1 = c
      ?.logException(new Error('S2: attribute set BEFORE this report (before_report_attr only)'), {
        labels: ['s2-before-after', 'before-only'],
      });
    c?.setAttribute('after_report_attr', 'set-after'); // SYNCHRONOUS, before report 1 settles (R5-2)
    void report1?.then(() => {
        void c
          ?.logException(
            new Error('S2: attribute set AFTER the first report too (both attrs now present)'),
            { labels: ['s2-before-after', 'before-and-after'] },
          )
          .then(() =>
            setStatus(
              's2-attr-before-after',
              'reported once with only before_report_attr, then again with both attrs present',
            ),
          );
      });
  });

  // ---- S3 -----------------------------------------------------------------------------------
  // Every S3 status line below reports whether `getClient()` actually resolved to a live client
  // (`clientPresent`) and folds it into the pass/fail `ok` flag. Previously these just set a static
  // string and verify.mjs recorded `true` unconditionally — a real defect (`getClient()` returning
  // undefined, e.g. after a bad relaunch) would have every `c?.foo()` call silently no-op and the
  // table would still read green. See FINDINGS.md.
  q('s3-log')?.addEventListener('click', () => {
    const c = getClient();
    const clientPresent = c !== undefined;
    c?.log('S3: error level', 'error');
    c?.log('S3: warning level', 'warning');
    c?.log('S3: info level', 'info');
    c?.log('S3: debug level', 'debug');
    c?.log('S3: verbose level', 'verbose');
    setStatus('s3-log', `client present: ${clientPresent}; logged at 5 levels`, clientPresent);
  });
  q('s3-event')?.addEventListener('click', () => {
    const c = getClient();
    const clientPresent = c !== undefined;
    c?.event('scenario_panel_opened');
    c?.event('note_created', { via: 'scenario-panel', count: 3 });
    setStatus('s3-event', `client present: ${clientPresent}; event() with and without params`, clientPresent);
  });
  q('s3-trace')?.addEventListener('click', () => {
    const c = getClient();
    const clientPresent = c !== undefined;
    c?.trace('render_ms', 12.5);
    setStatus('s3-trace', `client present: ${clientPresent}; trace("render_ms", 12.5)`, clientPresent);
  });
  q('s3-breadcrumb')?.addEventListener('click', () => {
    const c = getClient();
    const clientPresent = c !== undefined;
    c?.addBreadcrumb({
      type: 'user',
      category: 'scenario',
      message: 'S3: every field set',
      level: 'info',
      data: { field: 'value', n: 1 },
    });
    setStatus(
      's3-breadcrumb',
      `client present: ${clientPresent}; addBreadcrumb() with every field`,
      clientPresent,
    );
  });

  // ---- S4 -----------------------------------------------------------------------------------
  q('s4-error')?.addEventListener('click', () => {
    void getClient()
      ?.logException(new Error('S4: logException(new Error(...))'))
      .then(() => setStatus('s4-error', 'reported'));
  });
  q('s4-string')?.addEventListener('click', () => {
    void getClient()
      ?.logException('S4: a bare string throwable')
      .then(() => setStatus('s4-string', 'reported'));
  });
  q('s4-object')?.addEventListener('click', () => {
    void getClient()
      ?.logException({ code: 'S4_OBJECT', detail: 'a non-Error object throwable' })
      .then(() => setStatus('s4-object', 'reported'));
  });
  q('s4-null')?.addEventListener('click', () => {
    void getClient()
      ?.logException(null)
      .then(() => setStatus('s4-null', 'reported'));
  });
  q('s4-cause')?.addEventListener('click', () => {
    const root = new Error('S4: root cause');
    const wrapped = new Error('S4: wrapped with cause', { cause: root });
    void getClient()
      ?.logException(wrapped)
      .then(() => setStatus('s4-cause', 'reported with cause chain'));
  });
  q('s4-options')?.addEventListener('click', () => {
    void getClient()
      ?.logException(new Error('S4: with LogExceptionOptions'), {
        mechanism: 'programmatic',
        severity: 'high',
        labels: ['scenario-panel', 's4-options'],
      })
      .then(() => setStatus('s4-options', 'reported with mechanism/severity/labels'));
  });
  q('s4-dedupe')?.addEventListener('click', () => {
    const c = getClient();
    void Promise.all([c?.logException(sharedError), c?.logException(sharedError)]).then(() =>
      setStatus('s4-dedupe', 'reported same instance twice (should dedupe)'),
    );
  });
  q('s4-storm')?.addEventListener('click', () => {
    void (async () => {
      // The rate limiter is a HARD CAP (packages/core/src/rate-limiter.ts): 100 admissions per rolling
      // 60s window, refused beyond that (client.ts:640 resolves refused calls with {ok:false}
      // immediately — NOT a pacing/minimum-interval scheme, see FINDINGS.md's corrected note). To
      // measure the cap EXACTLY (100 admitted / 100 refused out of 200), relaunch immediately before
      // firing so the window starts empty — a shared client would already have consumed some of its
      // quota from earlier S2/S4/S8/S12 logException calls in this same sweep.
      await relaunch(FULL_LAUNCH_OPTIONS);
      rerenderIsLaunched();
      const c = getClient();
      let refused = 0;
      let delivered = 0;
      // `delivered` is measured, NOT derived as `200 - refused` (that arithmetic identity is
      // tautological — it cannot distinguish "delivered" from "admitted but silently dropped"). Each
      // `logException` promise for a REFUSED call resolves synchronously with {ok:false}; for an
      // ADMITTED call it resolves ONLY once the durable pipeline's tracked upload promise settles
      // (client.ts's `track`/`submitReport` — the same completion the upload queue itself waits on),
      // seconds to (measured) ~90s later. So `r.ok === true` observed here is real wire-delivery
      // evidence, not an assumption.
      const attempts: Array<Promise<void> | undefined> = [];
      for (let i = 0; i < 200; i += 1) {
        attempts.push(
          c?.logException(new Error(`S4 storm #${i}`)).then((r) => {
            if (r.ok === false) refused += 1;
            else delivered += 1;
          }),
        );
      }
      setStatus('s4-storm', 'fired 200 logException calls against a freshly-relaunched client, draining…');
      // No fixed sleep: wait for every one of the 200 promises to actually settle (which, for the 100
      // admitted, means their uploads actually completed), however long that takes.
      await Promise.all(attempts);
      setStatus(
        's4-storm',
        `drained: refused=${refused} delivered=${delivered} (of 200 attempted)`,
        refused === 100 && delivered === 100,
      );
    })();
  });

  // ---- S5 -----------------------------------------------------------------------------------
  q('s5-uncaught')?.addEventListener('click', () => {
    setStatus('s5-uncaught', 'throwing outside any try/catch…');
    setTimeout(() => {
      throw new Error('S5: uncaught exception outside any try/catch');
    }, 10);
  });
  q('s5-rejection')?.addEventListener('click', () => {
    setStatus('s5-rejection', 'rejecting an unhandled promise…');
    void Promise.reject(new Error('S5: unhandled promise rejection'));
  });

  // ---- S6 -----------------------------------------------------------------------------------
  q('s6-console')?.addEventListener('click', () => {
    console.log('S6: console.log', { a: 1 });
    console.info('S6: console.info');
    console.warn('S6: console.warn');
    console.error('S6: console.error');
    console.debug('S6: console.debug');
    console.trace('S6: console.trace');
    setStatus('s6-console', 'called 6 console methods');
  });
  q('s6-circular')?.addEventListener('click', () => {
    const obj: Record<string, unknown> = { name: 'circular' };
    obj.self = obj;
    let threw = false;
    try {
      console.log('S6: circular object', obj);
    } catch {
      threw = true;
    }
    setStatus('s6-circular', `console.log(circular) threw: ${threw}`, !threw);
  });

  // ---- S7 -----------------------------------------------------------------------------------
  q('s7-get')?.addEventListener('click', async () => {
    const res = await fetch('/api/scenario/text');
    const text = await res.text();
    setStatus('s7-get', `GET -> ${res.status} "${text.slice(0, 40)}…"`);
  });
  q('s7-post-json')?.addEventListener('click', async () => {
    const res = await fetch('/api/scenario/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world', n: 42 }),
    });
    const body = (await res.json()) as unknown;
    setStatus('s7-post-json', `POST JSON -> ${JSON.stringify(body)}`);
  });
  q('s7-4xx')?.addEventListener('click', async () => {
    const res = await fetch('/api/scenario/4xx');
    setStatus('s7-4xx', `status ${res.status}`);
  });
  q('s7-5xx')?.addEventListener('click', async () => {
    const res = await fetch('/api/scenario/5xx');
    setStatus('s7-5xx', `status ${res.status}`);
  });
  q('s7-connfail')?.addEventListener('click', async () => {
    try {
      await fetch('http://127.0.0.1:1');
      setStatus('s7-connfail', 'unexpectedly succeeded', false);
    } catch (err) {
      setStatus('s7-connfail', `caught: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  q('s7-large-body')?.addEventListener('click', async () => {
    const res = await fetch('/api/scenario/large-body');
    const body = (await res.json()) as { big: string };
    // Corrected wording (F-E): a body over `maxNetworkBodySize` is DROPPED from the captured copy
    // (no_body_reason: 'size_too_large'), never truncated to 2048 bytes — see
    // packages/capture/src/fetch-interceptor.ts's readBoundedBody. The app's own read is unaffected
    // either way (that's the "interceptors must not alter app behaviour" contract, not this control).
    setStatus('s7-large-body', `read ${body.big.length} bytes client-side (capture drops the over-cap body entirely)`);
  });
  q('s7-no-content-type')?.addEventListener('click', async () => {
    const res = await fetch('/api/scenario/no-content-type');
    const text = await res.text();
    setStatus('s7-no-content-type', `GET (no Content-Type) -> "${text.slice(0, 40)}…"`);
  });
  q('s7-xhr')?.addEventListener('click', () => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/scenario/text');
    xhr.onload = () => setStatus('s7-xhr', `XHR -> ${xhr.status} "${xhr.responseText.slice(0, 40)}…"`);
    xhr.onerror = () => setStatus('s7-xhr', 'XHR errored', false);
    xhr.send();
  });
  q('s7-sse')?.addEventListener('click', () => {
    let n = 0;
    const es = new EventSource('/api/scenario/sse');
    es.onmessage = () => {
      n += 1;
      setStatus('s7-sse', `received ${n} SSE events`);
      if (n >= 5) es.close();
    };
    es.onerror = () => es.close();
  });
  q('s7-ws')?.addEventListener('click', () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/presence`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'scenario-ping' }));
    ws.onmessage = (ev) => setStatus('s7-ws', `WS message: ${String(ev.data).slice(0, 60)}`);
  });

  // ---- S8 -----------------------------------------------------------------------------------
  q('s8-install')?.addEventListener('click', () => {
    installFilters();
    setStatus('s8-network', 'filters installed');
  });
  q('s8-uninstall')?.addEventListener('click', () => {
    uninstallFilters();
    setStatus('s8-network', 'filters uninstalled');
  });
  q('s8-network')?.addEventListener('click', async () => {
    await fetch('/api/scenario/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-secret-token': 'shh' },
      body: JSON.stringify({ ssn: '123-45-6789' }),
    });
    setStatus('s8-network', `sent (filters installed: ${filtersInstalled})`);
  });
  q('s8-veto-network')?.addEventListener('click', async () => {
    await fetch('/api/scenario/text?veto-me=1');
    setStatus('s8-veto-network', `sent (filters installed: ${filtersInstalled})`);
  });
  q('s8-log')?.addEventListener('click', () => {
    getClient()?.log('leaking SECRET_TOKEN=abc123 in a log line', 'info');
    setStatus('s8-log', `logged (filters installed: ${filtersInstalled})`);
  });
  q('s8-breadcrumb')?.addEventListener('click', () => {
    getClient()?.addBreadcrumb({ type: 'user', category: 'scenario', message: 'has secret data', data: { secret: 'shh' } });
    setStatus('s8-breadcrumb', `added (filters installed: ${filtersInstalled})`);
  });
  q('s8-report-mutate')?.addEventListener('click', () => {
    void getClient()
      ?.logException(new Error('S8: report handler should mutate this'), { labels: ['MUTATE_ME'] })
      .then(() => setStatus('s8-report-mutate', 'reported'));
  });
  q('s8-report-veto')?.addEventListener('click', () => {
    void getClient()
      ?.logException(new Error('S8: report handler should VETO this'), { labels: ['VETO_REPORT'] })
      .then(() => setStatus('s8-report-veto', 'call returned (issue should NOT appear)'));
  });

  // ---- S9 -----------------------------------------------------------------------------------
  q('s9-manual-transaction')?.addEventListener('click', () => {
    // Every SDK call below is optional-chained (ext('performance') CAN legitimately be undefined —
    // e.g. if the extension failed to register), so the status must be derived from what the SDK
    // actually returned, not from a hard-coded literal — a hard-coded `${statuses.length} child
    // spans` would keep reading "finished with 6 child spans" even if `perf`/`txn` were undefined and
    // every call below had silently no-op'd (this was the actual bug this fix pass found).
    const perf = getClient()?.ext('performance');
    const txn = perf?.startTransaction({ name: 's9-manual-transaction', operation: 'scenario' });
    const statuses: SpanStatus[] = ['OK', 'ERROR', 'TIMEOUT', 'CANCELLED', 'DEADLINE_EXCEEDED', 'UNKNOWN'];
    let finishedChildren = 0;
    for (const status of statuses) {
      const child = txn?.startChildSpan('scenario.child', status);
      child?.setStatus(status);
      child?.finish(status);
      // Count only children the SDK actually created AND actually finished with the requested
      // status — real evidence, not an assumption that the optional-chained calls above succeeded.
      if (child !== undefined && child.isFinished() && child.getStatus() === status) {
        finishedChildren += 1;
      }
    }
    txn?.finish('OK');
    const ok = perf !== undefined && txn !== undefined && txn.isFinished() && finishedChildren === statuses.length;
    setStatus('s9-manual-transaction', `finished with ${finishedChildren} child spans`, ok);
  });
  q('s9-set-route-name')?.addEventListener('click', () => {
    const perf = getClient()?.ext('performance');
    // NB: previously `getClient()?.ext('performance').setRouteName(...)` — missing the `?.` before
    // `setRouteName`, which would THROW (uncaught TypeError) rather than degrade, if `ext` ever
    // returned undefined. Optional-chain it too, and fold `perf`'s presence into `ok` so this can
    // actually fail instead of always reporting success.
    perf?.setRouteName('/scenarios/manual');
    setStatus(
      's9-set-route-name',
      `setRouteName("/scenarios/manual") (perf present: ${perf !== undefined})`,
      perf !== undefined,
    );
  });
  q('s9-sample-rate-0')?.addEventListener('click', async () => {
    await relaunch({ ...FULL_LAUNCH_OPTIONS, performanceSampleRate: 0 });
    rerenderIsLaunched();
    setStatus('s9-sample-rate-0', `relaunched, isLaunched: ${String(getClient()?.isLaunched())}`, getClient()?.isLaunched() === true);
  });
  q('s9-sample-rate-1')?.addEventListener('click', async () => {
    await relaunch({ ...FULL_LAUNCH_OPTIONS, performanceSampleRate: 1 });
    rerenderIsLaunched();
    setStatus('s9-sample-rate-1', `relaunched, isLaunched: ${String(getClient()?.isLaunched())}`, getClient()?.isLaunched() === true);
  });

  // ---- S12 ----------------------------------------------------------------------------------
  q('s12-crash-and-reload')?.addEventListener('click', () => {
    // Real persist+recover (§4 S12: "data captured before a hard termination still arrives on the
    // NEXT start"), not the previous version of this control, which AWAITED logException() (whose
    // promise resolves only after the full assemble->enqueue->upload round trip completes,
    // packages/core/src/client.ts submitReport) before reloading — by then the report had already been
    // delivered in the ORIGINAL session, so recovery had nothing to do and the check only proved a
    // normal report round-trips. Firing without awaiting and reloading almost immediately gives the
    // durable marker (persist:true) a chance to be written before the upload completes, so it is
    // `recover:true` on the NEXT launch that actually delivers this report — see FINDINGS.md for
    // whether that lands as exactly one issue or (per a known cross-sample SDK finding) two.
    void getClient()?.logException(new Error('S12: persist+recover across a hard reload'));
    setStatus('s12-crash-and-reload', 'reloading in 100ms (NOT awaiting the upload)…');
    setTimeout(() => location.reload(), 100);
  });
}

function rerenderIsLaunched(): void {
  const el = container?.querySelector<HTMLElement>('[data-testid="is-launched"]');
  if (el) el.textContent = String(getClient()?.isLaunched());
}

export function mountScenarioPanel(el: HTMLElement): void {
  container = el;
  container.innerHTML = template();
  wire();
  onInternalError((e) => {
    logLine(internalErrors, String(e instanceof Error ? e.message : e), 'internal-errors');
  });
}
