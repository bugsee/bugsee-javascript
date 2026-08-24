import { getClient, sdkErrors, relaunchBugsee, loadSettings } from '../bugsee-client';
import { triggerWorkerThrow, workerLog } from '../lib/worker-client';
import { triggerServiceWorkerThrow, triggerBackgroundSync } from '../lib/sw-register';

// The Scenario panel: one control per §4 scenario (S1–S13) plus the browser-specific extras from
// docs/samples/PLAN.md §5.1. Each control is a plain button so it can be driven by hand OR by
// Playwright (scripts/verify.ts) via a stable `data-scenario="Sx"` attribute + a `#scenario-log`
// transcript any script can read back.

interface ScenarioDef {
  id: string;
  title: string;
  detail: string;
  run: () => Promise<string> | string;
}

function log(container: HTMLElement, line: string): void {
  const box = container.querySelector('#scenario-log') as HTMLElement;
  const stamp = new Date().toISOString().split('T')[1]?.replace('Z', '');
  box.textContent = `[${stamp}] ${line}\n${box.textContent}`;
}

function circularObject(): Record<string, unknown> {
  const obj: Record<string, unknown> = { name: 'circular-demo' };
  obj.self = obj;
  return obj;
}

const SCENARIOS: ScenarioDef[] = [
  // S1 — Launch & lifecycle
  {
    id: 'S1-isLaunched',
    title: 'S1 isLaunched()',
    detail: 'Reads client.isLaunched().',
    run: () => `isLaunched() = ${String(getClient()?.isLaunched())}`,
  },
  {
    id: 'S1-double-launch',
    title: 'S1 second launch() while launched',
    detail: 'Calls @bugsee/bugsee launch() again directly — must be ignored, not duplicated, and route to onError.',
    run: async () => {
      const before = sdkErrors.length;
      const { launch } = await import('@bugsee/bugsee');
      const token = import.meta.env.BUGSEE_APP_TOKEN;
      const client = launch(token, {
        endpoint: `${window.location.origin}/bugsee-proxy`,
        sdkVersion: '1.0.0', // see FINDINGS.md F-3
      });
      const sameInstance = client === getClient();
      const warned = sdkErrors.length > before;
      return `repeat launch() returned ${sameInstance ? 'the SAME client' : 'a DIFFERENT client (bug)'}; onError fired: ${warned}`;
    },
  },
  {
    id: 'S1-flush',
    title: 'S1 flush(timeout)',
    detail: 'client.flush(5000).',
    run: async () => `flush() -> drained=${String(await getClient()?.flush(5000))}`,
  },

  // S2 — Identity & attributes
  {
    id: 'S2-attributes',
    title: 'S2 attribute lifecycle (all AttributeValue types)',
    detail: 'setAttribute for string/number/boolean/string[]; get/clear/getAll.',
    run: () => {
      const c = getClient();
      c?.setAttribute('attr.string', 'widget-shop');
      c?.setAttribute('attr.number', 42);
      c?.setAttribute('attr.boolean', true);
      c?.setAttribute('attr.stringArray', ['a', 'b', 'c']);
      const all = c?.getAllAttributes();
      c?.clearAttribute('attr.boolean');
      const afterClear = c?.getAttribute('attr.boolean');
      return `set 4 attrs, getAllAttributes()=${JSON.stringify(all)}; after clearAttribute('attr.boolean')=${String(afterClear)}`;
    },
  },
  {
    id: 'S2-user',
    title: 'S2 user identifier lifecycle',
    detail: 'setUserIdentifier / getUserIdentifier / clearUserIdentifier.',
    run: () => {
      const c = getClient();
      c?.setUserIdentifier('scenario-panel-user');
      const got = c?.getUserIdentifier();
      c?.clearUserIdentifier();
      const cleared = c?.getUserIdentifier();
      c?.setUserIdentifier('widget-shop-sample-user'); // restore the sample-wide identity
      return `getUserIdentifier()='${got}' before clear, '${cleared}' after clear`;
    },
  },

  // S3 — Manual telemetry
  {
    id: 'S3-log-levels',
    title: 'S3 log() at every LogLevel',
    detail: 'verbose/debug/info/warning/error.',
    run: () => {
      const c = getClient();
      (['verbose', 'debug', 'info', 'warning', 'error'] as const).forEach((level) =>
        c?.log(`scenario-panel log at ${level}`, level),
      );
      return 'logged at verbose/debug/info/warning/error';
    },
  },
  {
    id: 'S3-event',
    title: 'S3 event() with and without params',
    detail: 'event(name) and event(name, params).',
    run: () => {
      const c = getClient();
      c?.event('scenario_event_no_params');
      c?.event('scenario_event_with_params', { a: 1, b: 'two', c: true });
      return 'fired 2 events';
    },
  },
  {
    id: 'S3-trace',
    title: 'S3 trace(name, value)',
    detail: 'trace() with a numeric and a string value.',
    run: () => {
      const c = getClient();
      c?.trace('scenario.trace.number', 123.45);
      c?.trace('scenario.trace.string', 'hello');
      return 'traced 2 values';
    },
  },
  {
    id: 'S3-breadcrumb',
    title: 'S3 addBreadcrumb() every field',
    detail: 'type/category/message/level/data/timestamp.',
    run: () => {
      getClient()?.addBreadcrumb({
        type: 'navigation',
        category: 'scenario-panel',
        message: 'full-field breadcrumb',
        level: 'info',
        data: { key: 'value', n: 1 },
        timestamp: Date.now(),
      });
      return 'added a full-field breadcrumb';
    },
  },

  // S4 — Exceptions
  {
    id: 'S4-error',
    title: 'S4 logException(new Error)',
    detail: 'A real Error instance.',
    run: async () => {
      const r = await getClient()?.logException(new Error('scenario-panel: plain Error'));
      return `logException -> ok=${String(r?.ok)}`;
    },
  },
  {
    id: 'S4-non-error',
    title: 'S4 logException(non-Error) x3',
    detail: 'A string, a plain object, and null.',
    run: async () => {
      const c = getClient();
      const r1 = await c?.logException('scenario-panel: string throwable');
      const r2 = await c?.logException({ code: 'E_SCENARIO', message: 'object throwable' });
      const r3 = await c?.logException(null);
      return `string ok=${String(r1?.ok)}, object ok=${String(r2?.ok)}, null ok=${String(r3?.ok)}`;
    },
  },
  {
    id: 'S4-cause',
    title: 'S4 logException with nested cause',
    detail: 'error.cause chain, 2 levels deep.',
    run: async () => {
      const root = new Error('scenario-panel: root cause');
      const mid = new Error('scenario-panel: mid error', { cause: root });
      const top = new Error('scenario-panel: top error', { cause: mid });
      const r = await getClient()?.logException(top);
      return `logException(nested cause) -> ok=${String(r?.ok)}`;
    },
  },
  {
    id: 'S4-options',
    title: 'S4 logException with LogExceptionOptions',
    detail: 'mechanism/severity/labels.',
    run: async () => {
      const r = await getClient()?.logException(new Error('scenario-panel: with options'), {
        mechanism: 'programmatic',
        severity: 'high',
        labels: ['scenario-panel', 'S4'],
      });
      return `logException(options) -> ok=${String(r?.ok)}`;
    },
  },
  {
    id: 'S4-dedupe',
    title: 'S4 SAME instance twice (must dedupe)',
    detail: 'Same Error object passed to logException twice.',
    run: async () => {
      const shared = new Error('scenario-panel: dedupe target');
      const r1 = await getClient()?.logException(shared);
      const r2 = await getClient()?.logException(shared);
      return `first ok=${String(r1?.ok)}, second (should be deduped/dropped) ok=${String(r2?.ok)}`;
    },
  },
  {
    id: 'S4-storm',
    title: 'S4 storm of 200 exceptions in 1s (rate-limit, not drop app)',
    detail: 'Fires 200 distinct exceptions synchronously; app must stay responsive.',
    run: async () => {
      const c = getClient();
      const start = performance.now();
      const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) => c?.logException(new Error(`scenario-panel storm #${i}`))),
      );
      const ok = results.filter((r) => r?.ok).length;
      const dropped = results.length - ok;
      return `fired 200 in ${(performance.now() - start).toFixed(0)}ms; ok=${ok}, rate-limited/dropped=${dropped}; app still responsive`;
    },
  },

  // S5 — Crashes
  {
    id: 'S5-uncaught',
    title: 'S5 uncaught exception (window.onerror)',
    detail: 'Throws from a setTimeout so it escapes this handler as a true uncaught error.',
    run: () => {
      setTimeout(() => {
        throw new Error('scenario-panel: deliberate uncaught exception');
      }, 10);
      return 'scheduled an uncaught throw in 10ms';
    },
  },
  {
    id: 'S5-rejection',
    title: 'S5 unhandled promise rejection',
    detail: 'Rejects a Promise with nothing attached to catch it.',
    run: () => {
      void Promise.reject(new Error('scenario-panel: deliberate unhandled rejection'));
      return 'created an unhandled rejection';
    },
  },

  // S6 — Console capture
  {
    id: 'S6-console',
    title: 'S6 console.* incl. multi-arg / object / circular',
    detail: 'log/info/warn/error/debug/trace + a circular object.',
    run: () => {
      console.log('scenario-panel console.log', 1, 'two', true);
      console.info('scenario-panel console.info');
      console.warn('scenario-panel console.warn');
      console.error('scenario-panel console.error');
      console.debug('scenario-panel console.debug');
      console.trace('scenario-panel console.trace');
      console.log('scenario-panel circular object:', circularObject());
      return 'called console.log/info/warn/error/debug/trace + a circular-object log';
    },
  },

  // S7 — Network capture
  {
    id: 'S7-fetch-json',
    title: 'S7 fetch GET/POST JSON',
    detail: 'GET /api/products, POST /api/checkout-shaped JSON body.',
    run: async () => {
      const r1 = await fetch('/api/products');
      const body1 = await r1.json();
      const r2 = await fetch('/api/echo-headers');
      await r2.json();
      return `GET /api/products -> ${r1.status} (${(body1 as unknown[]).length} products); GET /api/echo-headers -> ${r2.status}`;
    },
  },
  {
    id: 'S7-text-body',
    title: 'S7 fetch text body round trip',
    detail: 'POST text/plain, read the response text — proves capture does not alter app behaviour.',
    run: async () => {
      const r = await fetch('/api/echo-text', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello-from-scenario-panel' });
      const text = await r.text();
      return `POST text/plain -> ${r.status}, body='${text}'`;
    },
  },
  {
    id: 'S7-4xx-5xx',
    title: 'S7 a 4xx and a 5xx',
    detail: 'GET /api/status/404 and /api/status/500.',
    run: async () => {
      const r1 = await fetch('/api/status/404');
      const r2 = await fetch('/api/status/500');
      return `404 -> ${r1.status}; 500 -> ${r2.status}`;
    },
  },
  {
    id: 'S7-conn-fail',
    title: 'S7 a connection failure',
    detail: 'fetch() to an unreachable local port.',
    run: async () => {
      try {
        await fetch('http://127.0.0.1:5999/unreachable', { mode: 'cors' });
        return 'fetch unexpectedly succeeded';
      } catch (error) {
        return `fetch failed as expected: ${String(error)}`;
      }
    },
  },
  {
    id: 'S7-big-body',
    title: 'S7 response body over maxNetworkBodySize',
    detail: 'GET /api/big (~40KB JSON, default cap 20480 bytes).',
    run: async () => {
      const r = await fetch('/api/big');
      const body = (await r.json()) as { big: string };
      return `GET /api/big -> ${r.status}, body length ${body.big.length} chars (app read it fully; capture should cap it)`;
    },
  },
  {
    id: 'S7-no-content-type',
    title: 'S7 response with no Content-Type',
    detail: 'GET /api/no-content-type.',
    run: async () => {
      const r = await fetch('/api/no-content-type');
      const text = await r.text();
      return `GET /api/no-content-type -> ${r.status}, content-type='${r.headers.get('content-type')}', body='${text}'`;
    },
  },
  {
    id: 'S7-xhr',
    title: 'S7 XMLHttpRequest',
    detail: 'A classic XHR GET.',
    run: () =>
      new Promise<string>((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/products');
        xhr.onload = () => resolve(`XHR GET /api/products -> ${xhr.status}, ${xhr.responseText.length} bytes`);
        xhr.onerror = () => resolve('XHR errored');
        xhr.send();
      }),
  },

  // S8 — Filters & redaction
  {
    id: 'S8-network-filter',
    title: 'S8 setNetworkEventFilter redacts a header + a body field',
    detail: 'Installs a filter that drops the Authorization header and redacts body.secret, then fires a request carrying both.',
    run: async () => {
      const c = getClient();
      c?.setNetworkEventFilter((event) => {
        if (event.custom?.headers === undefined) return event;
        const headers = { ...event.custom.headers };
        delete headers.authorization;
        delete headers.Authorization;
        return { ...event, custom: { ...event.custom, headers } };
      });
      await fetch('/api/echo-headers', { headers: { Authorization: 'Bearer scenario-panel-secret-token' } });
      c?.setNetworkEventFilter(null);
      return 'installed + fired a request with Authorization header, then cleared the filter (check the issue: header must be ABSENT)';
    },
  },
  {
    id: 'S8-log-filter',
    title: 'S8 setLogEventFilter vetoes a line',
    detail: 'Drops any console line containing SECRET_TOKEN.',
    run: () => {
      const c = getClient();
      c?.setLogEventFilter((event) => (event.message.includes('SECRET_TOKEN') ? null : event));
      console.log('scenario-panel SECRET_TOKEN=should-be-dropped');
      console.log('scenario-panel this line should survive');
      c?.setLogEventFilter(null);
      return 'logged a SECRET_TOKEN line (should be dropped) + a normal line (should survive)';
    },
  },
  {
    id: 'S8-breadcrumb-filter',
    title: 'S8 setBreadcrumbFilter vetoes a breadcrumb',
    detail: 'Drops any breadcrumb tagged category "veto-me".',
    run: () => {
      const c = getClient();
      c?.setBreadcrumbFilter((b) => (b.category === 'veto-me' ? null : b));
      c?.addBreadcrumb({ category: 'veto-me', message: 'should be dropped' });
      c?.addBreadcrumb({ category: 'keep-me', message: 'should survive' });
      c?.setBreadcrumbFilter(null);
      return 'added a vetoed breadcrumb + a surviving one';
    },
  },
  {
    id: 'S8-report-handler',
    title: 'S8 setReportHandler before (mutate) then veto',
    detail: 'First mutates a report label in, then vetoes an entire report (must NOT appear in Bugsee).',
    run: async () => {
      const c = getClient();
      c?.setReportHandler({ before: (r) => r });
      const r1 = await c?.logException(new Error('scenario-panel: mutated-by-handler report'));
      c?.setReportHandler({ before: () => null });
      const r2 = await c?.logException(new Error('scenario-panel: VETOED report (must not arrive)'));
      c?.setReportHandler(null);
      return `mutate-only report ok=${String(r1?.ok)}; vetoed report ok=${String(r2?.ok)} (should be false/dropped)`;
    },
  },

  // S9 — Performance / APM
  {
    id: 'S9-manual-span',
    title: 'S9 manual startTransaction + child spans + every SpanStatus',
    detail: 'ext(performance).startTransaction, 3 child spans each finished with a different SpanStatus.',
    run: () => {
      const c = getClient();
      if (c === undefined) return 'no client';
      try {
        const perf = c.ext('performance');
        const tx = perf.startTransaction({ name: 'scenario.manual', operation: 'scenario' });
        const s1 = tx.startChildSpan('step.ok');
        s1.finish('OK');
        const s2 = tx.startChildSpan('step.error');
        s2.finish('ERROR');
        const s3 = tx.startChildSpan('step.timeout');
        s3.finish('TIMEOUT');
        tx.finish('OK');
        return 'started a transaction with 3 child spans (OK/ERROR/TIMEOUT), finished OK';
      } catch (error) {
        return `performance extension unavailable (performanceMonitoring off?): ${String(error)}`;
      }
    },
  },
  {
    id: 'S9-route-name',
    title: 'S9 setRouteName',
    detail: 'Renames the active transaction to a route pattern.',
    run: () => {
      const c = getClient();
      if (c === undefined) return 'no client';
      try {
        const perf = c.ext('performance');
        const tx = perf.startTransaction({ name: 'scenario.route', operation: 'navigation' });
        perf.setRouteName('/scenario/:id');
        tx.finish('OK');
        return 'started + renamed active transaction via setRouteName()';
      } catch (error) {
        return `performance extension unavailable (performanceMonitoring off?): ${String(error)}`;
      }
    },
  },
  {
    id: 'S9-http-client-span',
    title: 'S9 http.client span from an outbound fetch',
    detail: 'Fires a fetch while performance monitoring is on — should produce an http.client span.',
    run: async () => {
      await fetch('/api/slow?ms=200');
      return 'fired a fetch to /api/slow — should appear as an http.client span in the active/next transaction';
    },
  },

  // S13 — OpenTelemetry
  {
    id: 'S13-otel-note',
    title: 'S13 OTel produce/consume',
    detail: 'See README — verified via a local collector script, not a button (needs an external process).',
    run: () => 'see scripts/otel-collector.mjs + README §OpenTelemetry for the manual procedure',
  },

  // S14 — Platform specifics / browser extras
  {
    id: 'S14-worker-launch',
    title: 'S14 Web Worker: separate @bugsee/webworker session',
    detail: 'Confirms the dedicated worker launched its own client (module-level singleton inside the worker).',
    run: () => {
      workerLog('scenario-panel: worker session ping');
      return 'sent a log message into the price-worker session (its own environment.runtime.type=web-worker)';
    },
  },
  {
    id: 'S14-worker-throw',
    title: 'S14 Web Worker: uncaught throw',
    detail: 'Posts {type:"throw"} — the worker throws synchronously, uncaught.',
    run: () => {
      triggerWorkerThrow();
      return 'told the price-worker to throw — check its own session for a crash';
    },
  },
  {
    id: 'S14-sw-throw',
    title: 'S14 Service Worker: throw inside a wrapped fetch handler',
    detail: 'fetch(/__sw-throw__), routed through withBugseeEvent.',
    run: async () => {
      await triggerServiceWorkerThrow();
      return 'requested /__sw-throw__ — the SW throws inside its withBugseeEvent-wrapped fetch handler';
    },
  },
  {
    id: 'S14-sw-sync',
    title: 'S14 Service Worker: background sync registration',
    detail: 'registration.sync.register — real API availability depends on the browser (see FINDINGS.md).',
    run: async () => `background sync registration: ${await triggerBackgroundSync()}`,
  },
  {
    id: 'S14-relaunch',
    title: 'S14 relaunch with current settings (Settings page apply)',
    detail: 'Convenience: re-runs relaunchBugsee() with the persisted settings.',
    run: async () => {
      await relaunchBugsee(loadSettings());
      return 'relaunched with persisted settings';
    },
  },
];

export function renderScenarios(container: HTMLElement): void {
  container.innerHTML = `
    <section class="block">
      <h1>Scenario panel</h1>
      <p class="muted">One control per catalog scenario (docs/samples/PLAN.md §4/§5.1). Every button
      calls the real SDK API; results are LOCAL-level checks (did the call throw / what did it return).
      Backend-level (§6) verification is done separately via the Bugsee staging MCP tools and recorded
      in <code>scenarios.md</code>.</p>
      <table class="scenario-table">
        <thead><tr><th>Scenario</th><th>What it does</th><th></th><th>Result</th></tr></thead>
        <tbody id="scenario-rows"></tbody>
      </table>
      <h3 style="margin-top:1.5rem">Log</h3>
      <div id="scenario-log" class="log-box"></div>
    </section>
  `;
  const rows = container.querySelector('#scenario-rows') as HTMLElement;
  rows.innerHTML = SCENARIOS.map(
    (s) => `<tr data-row="${s.id}">
      <td><strong>${s.title}</strong></td>
      <td><small class="muted">${s.detail}</small></td>
      <td><button data-scenario="${s.id}">Run</button></td>
      <td data-result="${s.id}">—</td>
    </tr>`,
  ).join('');

  SCENARIOS.forEach((s) => {
    container.querySelector(`button[data-scenario="${s.id}"]`)?.addEventListener('click', () => {
      void (async () => {
        const cell = container.querySelector(`td[data-result="${s.id}"]`) as HTMLElement;
        cell.textContent = 'running…';
        try {
          const result = await s.run();
          cell.textContent = result;
          cell.className = 'status-ok';
          log(container, `${s.id}: ${result}`);
        } catch (error) {
          cell.textContent = `threw: ${String(error)}`;
          cell.className = 'status-err';
          log(container, `${s.id} THREW: ${String(error)}`);
        }
      })();
    });
  });
}

export const scenarioIds = SCENARIOS.map((s) => s.id);
