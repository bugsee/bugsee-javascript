import { useEffect, useState } from 'react';
import {
  BugseeProfiler,
  createBugseeErrorHandlers,
  instrumentRouterMatches,
  linkComponentStack,
  recordReactRenderSpan,
  reportReactError,
  routePatternFromMatches,
  setRouteName,
  type LogExceptionOptions,
} from '@bugsee/react';
import type { SpanStatus } from '@bugsee/performance';
import {
  attemptDuplicateLaunch,
  FULL_LAUNCH_OPTIONS,
  getClient,
  MINIMAL_LAUNCH_OPTIONS,
  onInternalError,
  relaunch,
} from '../bugsee';
import { scenarioApi } from '../api/client';
import ThrowingWidgetImpl, { GuardedThrowingWidget } from '../components/ThrowingWidget';
import SlowList from '../components/SlowList';

type Status = { text: string; ok: boolean };

function useStatuses(): [Record<string, Status>, (id: string, text: string, ok?: boolean) => void] {
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const set = (id: string, text: string, ok = true): void =>
    setStatuses((prev) => ({ ...prev, [id]: { text, ok } }));
  return [statuses, set];
}

function StatusLine({ status }: { status?: Status }): JSX.Element | null {
  if (!status) return null;
  return <p className={`status-line ${status.ok ? 'ok' : 'err'}`}>{status.text}</p>;
}

export default function ScenarioPage(): JSX.Element {
  const [statuses, setStatus] = useStatuses();
  const client = getClient();

  // ---- S4 exception dedupe fixture -----------------------------------------------------------
  const [sharedError] = useState(() => new Error('shared instance — logException twice must dedupe'));

  // ---- React-specific: ThrowingWidget demo state ---------------------------------------------
  const [armGuarded, setArmGuarded] = useState(false);
  const [armGlobal, setArmGlobal] = useState(false);

  // ---- React-specific: profiled slow list -----------------------------------------------------
  const [showSlowList, setShowSlowList] = useState(false);

  // ---- S8 filters toggle -----------------------------------------------------------------------
  const [filtersInstalled, setFiltersInstalled] = useState(false);
  const [filterLog, setFilterLog] = useState<string[]>([]);

  function installFilters(): void {
    const c = getClient();
    if (!c) return;
    c.setNetworkEventFilter((event) => {
      const headers = event.custom?.headers;
      const hadSecretHeader = headers ? 'x-secret-token' in headers : false;
      let body = event.custom?.body ?? null;
      const hadSsn = typeof body === 'string' && body.includes('123-45-6789');
      if (hadSsn && body) body = body.replace(/123-45-6789/g, '[REDACTED]');
      const next = {
        ...event,
        custom: headers || body !== undefined ? { ...event.custom, headers: headers ? Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'x-secret-token')) : headers, body } : event.custom,
      };
      setFilterLog((prev) => [
        `network: ${event.url} — droppedSecretHeader=${hadSecretHeader} redactedSsn=${hadSsn}`,
        ...prev.slice(0, 9),
      ]);
      if (event.url.includes('veto-me')) {
        setFilterLog((prev) => [`network: VETOED ${event.url}`, ...prev.slice(0, 9)]);
        return null;
      }
      return next;
    });
    c.setLogEventFilter((event) => {
      if (event.message.includes('SECRET_TOKEN')) {
        setFilterLog((prev) => [`log: redacted "${event.message}"`, ...prev.slice(0, 9)]);
        return { ...event, message: event.message.replace(/SECRET_TOKEN=\S+/, 'SECRET_TOKEN=[REDACTED]') };
      }
      return event;
    });
    c.setBreadcrumbFilter((crumb) => {
      if (crumb.data && 'secret' in crumb.data) {
        setFilterLog((prev) => [`breadcrumb: redacted data.secret`, ...prev.slice(0, 9)]);
        return { ...crumb, data: { ...crumb.data, secret: '[REDACTED]' } };
      }
      return crumb;
    });
    c.setReportHandler({
      before: (request) => {
        if (request.report.labels.includes('VETO_REPORT')) {
          setFilterLog((prev) => [`report: VETOED ${request.id}`, ...prev.slice(0, 9)]);
          return null;
        }
        if (request.report.labels.includes('MUTATE_ME')) {
          setFilterLog((prev) => [`report: mutated ${request.id}`, ...prev.slice(0, 9)]);
          return { ...request, report: { ...request.report, labels: [...request.report.labels, 'redacted-before'] } };
        }
        return request;
      },
    });
    setFiltersInstalled(true);
  }

  function uninstallFilters(): void {
    const c = getClient();
    c?.setNetworkEventFilter(null);
    c?.setLogEventFilter(null);
    c?.setBreadcrumbFilter(null);
    c?.setReportHandler(null);
    setFiltersInstalled(false);
  }

  // ---- Internal-error sink display --------------------------------------------------------------
  const [internalErrors, setInternalErrors] = useState<string[]>([]);
  useEffect(
    () =>
      onInternalError((e) =>
        setInternalErrors((prev) => [String(e instanceof Error ? e.message : e), ...prev.slice(0, 9)]),
      ),
    [],
  );

  return (
    <div>
      <h2>Scenario panel</h2>
      <p className="desc">
        One control per scenario in docs/samples/PLAN.md §4. Every control here calls the real SDK API —
        see scenarios.md for what should appear in Bugsee for each.
      </p>

      {/* ---------------------------------------------------------------- S1 launch & lifecycle */}
      <section className="scenario-section">
        <h3>S1 — Launch &amp; lifecycle</h3>
        <div className="control-row">
          <span className="label">isLaunched()</span>
          <span data-testid="is-launched">{String(client?.isLaunched())}</span>
        </div>
        <div className="control-row">
          <span className="label">flush(5000)</span>
          <button
            data-testid="s1-flush"
            onClick={async () => {
              const ok = await client?.flush(5000);
              setStatus('s1-flush', `flush() -> ${ok}`, ok);
            }}
          >
            Flush
          </button>
          <StatusLine status={statuses['s1-flush']} />
        </div>
        <div className="control-row">
          <span className="label">Second launch() on the same carrier (must be ignored)</span>
          <button
            data-testid="s1-duplicate-launch"
            onClick={() => {
              const { sameInstance } = attemptDuplicateLaunch();
              setStatus('s1-dup', `same instance returned: ${sameInstance}`, sameInstance);
            }}
          >
            Call launch() again
          </button>
          <StatusLine status={statuses['s1-dup']} />
        </div>
        <div className="control-row">
          <span className="label">Relaunch with MINIMAL options (fresh carrier)</span>
          <button
            data-testid="s1-relaunch-minimal"
            onClick={async () => {
              await relaunch(MINIMAL_LAUNCH_OPTIONS);
              setStatus('s1-min', 'relaunched with {} (all defaults)');
            }}
          >
            Relaunch minimal
          </button>
          <StatusLine status={statuses['s1-min']} />
        </div>
        <div className="control-row">
          <span className="label">Relaunch with FULL options (fresh carrier)</span>
          <button
            data-testid="s1-relaunch-full"
            onClick={async () => {
              await relaunch(FULL_LAUNCH_OPTIONS);
              setStatus('s1-full', 'relaunched with every option set');
            }}
          >
            Relaunch full
          </button>
          <StatusLine status={statuses['s1-full']} />
        </div>
        {internalErrors.length > 0 && (
          <div>
            <p className="desc">onError sink (relaunch/provider diagnostics):</p>
            <ul className="activity-feed">
              {internalErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- S3 manual telemetry */}
      <section className="scenario-section">
        <h3>S3 — Manual telemetry</h3>
        <div className="control-row">
          <span className="label">log() at every level</span>
          {(['error', 'warning', 'info', 'debug', 'verbose'] as const).map((level) => (
            <button
              key={level}
              className="secondary"
              data-testid={`s3-log-${level}`}
              onClick={() => {
                client?.log(`sample log at level=${level}`, level);
                setStatus('s3-log', `log("...", "${level}")`);
              }}
            >
              {level}
            </button>
          ))}
          <StatusLine status={statuses['s3-log']} />
        </div>
        <div className="control-row">
          <span className="label">event() with / without params</span>
          <button
            className="secondary"
            data-testid="s3-event-params"
            onClick={() => {
              client?.event('card_created', { boardId: 'board-1', source: 'scenario-panel' });
              setStatus('s3-event', 'event("card_created", {...})');
            }}
          >
            With params
          </button>
          <button
            className="secondary"
            data-testid="s3-event-no-params"
            onClick={() => {
              client?.event('scenario_panel_opened');
              setStatus('s3-event', 'event("scenario_panel_opened")');
            }}
          >
            Without params
          </button>
          <StatusLine status={statuses['s3-event']} />
        </div>
        <div className="control-row">
          <span className="label">trace(name, value)</span>
          <button
            className="secondary"
            data-testid="s3-trace"
            onClick={() => {
              client?.trace('render.board', { ms: 12.4, cards: 4 });
              setStatus('s3-trace', 'trace("render.board", {...})');
            }}
          >
            Trace
          </button>
          <StatusLine status={statuses['s3-trace']} />
        </div>
        <div className="control-row">
          <span className="label">addBreadcrumb() — every field</span>
          <button
            className="secondary"
            data-testid="s3-breadcrumb"
            onClick={() => {
              client?.addBreadcrumb({
                type: 'navigation',
                category: 'ui.click',
                message: 'user clicked "Add breadcrumb" in the scenario panel',
                level: 'info',
                data: { control: 's3-breadcrumb', screen: 'scenarios' },
              });
              setStatus('s3-crumb', 'addBreadcrumb({type, category, message, level, data})');
            }}
          >
            Add breadcrumb
          </button>
          <StatusLine status={statuses['s3-crumb']} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- S4 exceptions */}
      <section className="scenario-section">
        <h3>S4 — Exceptions</h3>
        <div className="control-row">
          <button
            data-testid="s4-error"
            onClick={async () => {
              const r = await client?.logException(new Error('S4: logException(new Error(...))'));
              setStatus('s4-error', `logException(Error) -> ok=${r?.ok}`, r?.ok);
            }}
          >
            logException(new Error)
          </button>
          <StatusLine status={statuses['s4-error']} />
        </div>
        <div className="control-row">
          <span className="label">Non-Error throwables</span>
          <button
            className="secondary"
            data-testid="s4-string"
            onClick={async () => {
              await client?.logException('S4: a bare string throwable');
              setStatus('s4-nonerror', 'logException("string")');
            }}
          >
            string
          </button>
          <button
            className="secondary"
            data-testid="s4-object"
            onClick={async () => {
              await client?.logException({ code: 'E_SAMPLE', detail: 'plain object throwable' });
              setStatus('s4-nonerror', 'logException({object})');
            }}
          >
            object
          </button>
          <button
            className="secondary"
            data-testid="s4-null"
            onClick={async () => {
              await client?.logException(null);
              setStatus('s4-nonerror', 'logException(null)');
            }}
          >
            null
          </button>
          <StatusLine status={statuses['s4-nonerror']} />
        </div>
        <div className="control-row">
          <span className="label">Nested cause</span>
          <button
            data-testid="s4-cause"
            onClick={async () => {
              const root = new Error('S4: root cause');
              const mid = new Error('S4: middle', { cause: root });
              const top = new Error('S4: top-level, chained via cause', { cause: mid });
              const r = await client?.logException(top);
              setStatus('s4-cause', `logException(chained cause) -> ok=${r?.ok}`, r?.ok);
            }}
          >
            logException(with cause chain)
          </button>
          <StatusLine status={statuses['s4-cause']} />
        </div>
        <div className="control-row">
          <span className="label">LogExceptionOptions (mechanism/severity/labels)</span>
          <button
            data-testid="s4-options"
            onClick={async () => {
              const options: LogExceptionOptions = {
                mechanism: 'programmatic',
                severity: 'high',
                labels: ['scenario-panel', 's4-options'],
              };
              const r = await client?.logException(new Error('S4: with LogExceptionOptions'), options);
              setStatus('s4-options', `logException(err, {mechanism, severity, labels}) -> ok=${r?.ok}`, r?.ok);
            }}
          >
            logException with options
          </button>
          <StatusLine status={statuses['s4-options']} />
        </div>
        <div className="control-row">
          <span className="label">Same instance twice (must dedupe)</span>
          <button
            data-testid="s4-dedupe"
            onClick={async () => {
              const r1 = await client?.logException(sharedError);
              const r2 = await client?.logException(sharedError);
              setStatus('s4-dedupe', `first ok=${r1?.ok}, second ok=${r2?.ok} (second should be a dedupe no-op)`);
            }}
          >
            logException(sameInstance) x2
          </button>
          <StatusLine status={statuses['s4-dedupe']} />
        </div>
        <div className="control-row">
          <span className="label">Storm: 200 exceptions in ~1s (must rate-limit, not crash)</span>
          <button
            data-testid="s4-storm"
            onClick={async () => {
              const start = performance.now();
              for (let i = 0; i < 200; i++) {
                void client?.logException(new Error(`S4 storm #${i}`));
              }
              setStatus('s4-storm', `fired 200 logException calls in ${(performance.now() - start).toFixed(1)}ms — app still responsive`);
            }}
          >
            Fire storm
          </button>
          <StatusLine status={statuses['s4-storm']} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- S5 crashes */}
      <section className="scenario-section">
        <h3>S5 — Crashes</h3>
        <div className="control-row">
          <button
            data-testid="s5-uncaught"
            onClick={() => {
              setStatus('s5-uncaught', 'thrown via setTimeout — check window.onerror capture');
              setTimeout(() => {
                throw new Error('S5: uncaught exception outside any try/catch or React boundary');
              }, 0);
            }}
          >
            Throw uncaught (window.onerror)
          </button>
          <StatusLine status={statuses['s5-uncaught']} />
        </div>
        <div className="control-row">
          <button
            data-testid="s5-rejection"
            onClick={() => {
              setStatus('s5-rejection', 'rejected — check unhandledrejection capture');
              Promise.reject(new Error('S5: unhandled promise rejection'));
            }}
          >
            Unhandled promise rejection
          </button>
          <StatusLine status={statuses['s5-rejection']} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- S6 console capture */}
      <section className="scenario-section">
        <h3>S6 — Console capture</h3>
        <div className="control-row">
          {(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) => (
            <button
              key={m}
              className="secondary"
              data-testid={`s6-${m}`}
              onClick={() => {
                // eslint-disable-next-line no-console
                console[m](`S6: console.${m} from the scenario panel`, { at: Date.now() });
                setStatus('s6', `console.${m}(...)`);
              }}
            >
              console.{m}
            </button>
          ))}
        </div>
        <div className="control-row">
          <button
            className="secondary"
            data-testid="s6-circular"
            onClick={() => {
              const obj: Record<string, unknown> = { name: 'circular-fixture' };
              obj.self = obj;
              // eslint-disable-next-line no-console
              console.log('S6: circular object', obj);
              setStatus('s6', 'console.log(circular object)');
            }}
          >
            console.log(circular object)
          </button>
          <StatusLine status={statuses['s6']} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- S7 network capture */}
      <section className="scenario-section">
        <h3>S7 — Network capture</h3>
        <div className="control-row">
          <button
            className="secondary"
            data-testid="s7-get"
            onClick={async () => {
              const body = await scenarioApi.get();
              setStatus('s7', `GET /scenario/get -> ${JSON.stringify(body)}`);
            }}
          >
            fetch GET
          </button>
          <button
            className="secondary"
            data-testid="s7-post-json"
            onClick={async () => {
              const body = await scenarioApi.postJson({ hello: 'world', n: 42 });
              setStatus('s7', `POST JSON -> ${JSON.stringify(body)}`);
            }}
          >
            fetch POST JSON
          </button>
          <button
            className="secondary"
            data-testid="s7-post-text"
            onClick={async () => {
              const body = await scenarioApi.postText('plain text body');
              setStatus('s7', `POST text -> "${body}"`);
            }}
          >
            fetch POST text
          </button>
          <button
            className="secondary"
            data-testid="s7-4xx"
            onClick={async () => {
              const r = await scenarioApi.get4xx();
              setStatus('s7', `GET 4xx -> status ${r.status}`);
            }}
          >
            4xx
          </button>
          <button
            className="secondary"
            data-testid="s7-5xx"
            onClick={async () => {
              const r = await scenarioApi.get5xx();
              setStatus('s7', `GET 5xx -> status ${r.status}`);
            }}
          >
            5xx
          </button>
          <button
            className="secondary"
            data-testid="s7-connfail"
            onClick={async () => {
              try {
                await scenarioApi.getConnectionFailure();
                setStatus('s7', 'connection failure: unexpectedly succeeded', false);
              } catch (e) {
                setStatus('s7', `connection failure -> ${String(e)}`);
              }
            }}
          >
            Connection failure
          </button>
          <button
            className="secondary"
            data-testid="s7-large-body"
            onClick={async () => {
              const r = await scenarioApi.getLargeBody();
              const body = await r.json();
              setStatus(
                's7',
                `large body -> read ${body.big.length} bytes client-side (maxNetworkBodySize=2048 truncates only the CAPTURED copy)`,
              );
            }}
          >
            Body over maxNetworkBodySize
          </button>
          <button
            className="secondary"
            data-testid="s7-no-content-type"
            onClick={async () => {
              const r = await scenarioApi.getNoContentType();
              const text = await r.text();
              setStatus('s7', `no Content-Type -> read "${text}" (captureNetworkBodyWithoutType=true)`);
            }}
          >
            No Content-Type
          </button>
          <button
            className="secondary"
            data-testid="s7-slow"
            onClick={async () => {
              setStatus('s7', 'slow request started…');
              const r = await scenarioApi.getSlow(2500);
              setStatus('s7', `slow request settled: ${r.status}`);
            }}
          >
            Slow (2.5s)
          </button>
          <button
            className="secondary"
            data-testid="s7-xhr"
            onClick={() => {
              const xhr = new XMLHttpRequest();
              xhr.open('GET', '/api/scenario/get');
              xhr.onload = () => setStatus('s7', `XHR -> ${xhr.status} ${xhr.responseText}`);
              xhr.onerror = () => setStatus('s7', 'XHR errored', false);
              xhr.send();
            }}
          >
            XHR GET
          </button>
          <button
            className="secondary"
            data-testid="s7-sse"
            onClick={() => {
              const es = new EventSource('/api/scenario/sse');
              let count = 0;
              es.addEventListener('activity', (e) => {
                count += 1;
                setStatus('s7', `SSE event #${count}: ${(e as MessageEvent).data}`);
                if (count >= 5) es.close();
              });
              es.onerror = () => es.close();
            }}
          >
            SSE (EventSource)
          </button>
        </div>
        <StatusLine status={statuses['s7']} />
      </section>

      {/* ---------------------------------------------------------------- S8 filters & redaction */}
      <section className="scenario-section">
        <h3>S8 — Filters &amp; redaction</h3>
        <p className="desc">
          Network-filter verification is LOCAL only — the backend surface (`get_issue`) does not expose
          network entries (see FINDINGS.md / PLAN §6.6). Log/breadcrumb/report-handler filters ARE
          verifiable on the backend (they land in `# Logs` / labels).
        </p>
        <div className="control-row">
          <button
            data-testid="s8-install"
            onClick={installFilters}
            disabled={filtersInstalled}
          >
            Install filters
          </button>
          <button className="secondary" data-testid="s8-uninstall" onClick={uninstallFilters} disabled={!filtersInstalled}>
            Uninstall filters
          </button>
          <span className="label">installed: {String(filtersInstalled)}</span>
        </div>
        <div className="control-row">
          <button
            className="secondary"
            data-testid="s8-network"
            onClick={() => void scenarioApi.postSecret()}
          >
            POST with secret header + ssn body field
          </button>
          <button className="secondary" data-testid="s8-veto-network" onClick={() => void scenarioApi.getVetoTarget()}>
            GET a vetoed URL
          </button>
          <button
            className="secondary"
            data-testid="s8-log"
            onClick={() => client?.log('leaking SECRET_TOKEN=abc123 in a log line', 'info')}
          >
            log() with a secret
          </button>
          <button
            className="secondary"
            data-testid="s8-breadcrumb"
            onClick={() =>
              client?.addBreadcrumb({ category: 'test', message: 'crumb with secret data', data: { secret: 'sk_live_xyz' } })
            }
          >
            addBreadcrumb() with secret data
          </button>
          <button
            className="secondary"
            data-testid="s8-report-mutate"
            onClick={() =>
              void client?.logException(new Error('S8: report handler should mutate this'), {
                labels: ['MUTATE_ME'],
              })
            }
          >
            logException — should be mutated (label added)
          </button>
          <button
            className="secondary"
            data-testid="s8-report-veto"
            onClick={() =>
              void client?.logException(new Error('S8: report handler should VETO this — must never arrive'), {
                labels: ['VETO_REPORT'],
              })
            }
          >
            logException — should be VETOED
          </button>
        </div>
        {filterLog.length > 0 && (
          <ul className="activity-feed" data-testid="filter-log">
            {filterLog.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------------------------------------------------------- S9 performance / APM */}
      <section className="scenario-section">
        <h3>S9 — Performance / APM</h3>
        <p className="desc">
          Page-load + navigation + interaction transactions are automatic (traceNavigations/
          traceInteractions on by default) — just browsing the app exercises them. This control adds a
          manual transaction with a child span per SpanStatus.
        </p>
        <div className="control-row">
          <button
            data-testid="s9-manual-transaction"
            onClick={() => {
              const perf = client?.ext('performance');
              if (!perf) return setStatus('s9', 'performance ext not registered', false);
              const tx = perf.startTransaction({ name: 'scenario.manual_transaction', operation: 'custom' });
              const statuses: SpanStatus[] = ['OK', 'ERROR', 'TIMEOUT', 'CANCELLED', 'DEADLINE_EXCEEDED', 'UNKNOWN'];
              for (const s of statuses) {
                const span = tx.startChildSpan(`child.${s.toLowerCase()}`, `child span with status ${s}`);
                span.setAttribute('scenario', 's9');
                span.finish(s);
              }
              tx.finish('OK');
              setStatus('s9', `started transaction, ${statuses.length} child spans (one per SpanStatus), finished OK`);
            }}
          >
            Manual transaction + every SpanStatus
          </button>
          <StatusLine status={statuses['s9']} />
        </div>
        <div className="control-row">
          <span className="label">setRouteName (direct call)</span>
          <button
            className="secondary"
            data-testid="s9-set-route-name"
            onClick={() => {
              setRouteName('/manual/:demo');
              setStatus('s9-route', 'setRouteName("/manual/:demo")');
            }}
          >
            setRouteName
          </button>
          <StatusLine status={statuses['s9-route']} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- S11 session replay */}
      <section className="scenario-section">
        <h3>S11 — Session replay</h3>
        <p className="desc">
          `@bugsee/replay` (+ `@bugsee/replay-canvas`) are transitive dependencies of `@bugsee/browser`
          (loaded lazily only when `replay` is set), not a package directly under test in this sample —
          but the catalog scenario still applies. Each control relaunches the SDK with a different replay
          option set. `get_issue` does not expose replay CONTENTS (see FINDINGS.md's MCP-gap note) — this
          is verified at the local/wire level (no throw, `replay.bin` present in the uploaded bundle).
        </p>
        <div className="control-row">
          <button
            data-testid="s11-replay-defaults"
            onClick={async () => {
              await relaunch({ ...FULL_LAUNCH_OPTIONS, replay: true });
              setStatus('s11', 'relaunched with replay: true (fail-closed defaults: maskAllText/maskAllInputs/blockAllMedia)');
            }}
          >
            replay: true (defaults)
          </button>
          <button
            className="secondary"
            data-testid="s11-replay-masking"
            onClick={async () => {
              await relaunch({
                ...FULL_LAUNCH_OPTIONS,
                replay: {
                  maskAllText: true,
                  maskAllInputs: true,
                  blockAllMedia: true,
                  blockAllCanvas: true,
                  maskTextSelector: '.secret-text',
                  blockSelector: '.secret-block',
                  ignoreSelector: '.secret-ignore',
                },
              });
              setStatus('s11', 'relaunched with explicit masking options (maskTextSelector/blockSelector/ignoreSelector/blockAllCanvas)');
            }}
          >
            replay: masking options
          </button>
          <button
            className="secondary"
            data-testid="s11-replay-canvas-fixed"
            onClick={async () => {
              await relaunch({ ...FULL_LAUNCH_OPTIONS, replay: { canvas: { fps: 2 } } });
              setStatus('s11', 'relaunched with replay.canvas: { fps: 2 } (fixed-fps canvas recording)');
            }}
          >
            replay: canvas fps=2
          </button>
          <button
            className="secondary"
            data-testid="s11-replay-canvas-all"
            onClick={async () => {
              await relaunch({ ...FULL_LAUNCH_OPTIONS, replay: { canvas: { fps: 'all' } } });
              setStatus('s11', "relaunched with replay.canvas: { fps: 'all' } (every draw call, full fidelity)");
            }}
          >
            replay: canvas fps='all'
          </button>
          <button
            className="secondary"
            data-testid="s11-replay-off"
            onClick={async () => {
              await relaunch(FULL_LAUNCH_OPTIONS);
              setStatus('s11', 'relaunched with replay off (restored FULL_LAUNCH_OPTIONS baseline)');
            }}
          >
            Restore (replay off)
          </button>
        </div>
        <div className="field-row">
          <label htmlFor="s11-masked">
            .bugsee-show opt-out demo — masked by default (maskAllInputs), this one is NOT
          </label>
          <input id="s11-masked" placeholder="masked by default" data-testid="s11-masked-field" />
          <input
            id="s11-shown"
            className="bugsee-show"
            placeholder="opted OUT of masking via .bugsee-show"
            data-testid="s11-shown-field"
          />
        </div>
        <StatusLine status={statuses['s11']} />
      </section>

      {/* ---------------------------------------------------------------- S12 persistence */}
      <section className="scenario-section">
        <h3>S12 — Persistence &amp; recovery</h3>
        <p className="desc">
          Logs an exception, then force-reloads the page immediately (before the upload can settle) —
          `persist`/`recover` (both on in FULL_LAUNCH_OPTIONS) should re-upload it from IndexedDB on the
          next launch. Verified over MCP by polling for the issue AFTER the reload.
        </p>
        <div className="control-row">
          <button
            data-testid="s12-crash-and-reload"
            onClick={() => {
              void client?.logException(new Error('S12: persist+recover across a hard reload'));
              setTimeout(() => window.location.reload(), 5);
            }}
          >
            logException then hard-reload immediately
          </button>
        </div>
      </section>

      {/* ---------------------------------------------------------------- React: error boundary */}
      <section className="scenario-section">
        <h3>React — BugseeErrorBoundary / withBugseeErrorBoundary</h3>
        <div className="control-row">
          <span className="label">Locally-guarded widget (withBugseeErrorBoundary, own fallback)</span>
          <button className="secondary" data-testid="arm-guarded" onClick={() => setArmGuarded(true)}>
            Arm + throw
          </button>
          <button className="secondary" data-testid="disarm-guarded" onClick={() => setArmGuarded(false)}>
            Reset
          </button>
        </div>
        <GuardedThrowingWidget armed={armGuarded} label="guarded" />

        <div className="control-row" style={{ marginTop: 12 }}>
          <span className="label">Unguarded widget — propagates to the app-level BugseeErrorBoundary</span>
          <button className="secondary" data-testid="arm-global" onClick={() => setArmGlobal(true)}>
            Arm + throw (replaces this page)
          </button>
        </div>
        {armGlobal && <ThrowingWidgetImpl armed label="global" />}
      </section>

      {/* ---------------------------------------------------------------- React: root handlers + report/link */}
      <section className="scenario-section">
        <h3>React — createBugseeErrorHandlers / reportReactError / linkComponentStack</h3>
        <div className="control-row">
          <button
            data-testid="s-root-handlers"
            onClick={() => {
              const handlers = createBugseeErrorHandlers({ mechanism: 'uncaught' });
              handlers.onUncaughtError(new Error('React: onUncaughtError called directly'), {
                componentStack: '\n    at DirectCall (scenario-panel)',
              });
              setStatus('s-handlers', 'createBugseeErrorHandlers().onUncaughtError(...) called directly');
            }}
          >
            Call onUncaughtError directly
          </button>
          <StatusLine status={statuses['s-handlers']} />
        </div>
        <div className="control-row">
          <button
            className="secondary"
            data-testid="s-report-react-error"
            onClick={() => {
              reportReactError(new Error('React: reportReactError called directly'), {
                componentStack: '\n    at ScenarioPage (direct call)',
                mechanism: 'programmatic',
              });
              setStatus('s-report', 'reportReactError(error, {componentStack, mechanism})');
            }}
          >
            reportReactError directly
          </button>
          <button
            className="secondary"
            data-testid="s-link-stack"
            onClick={() => {
              const err = new Error('React: linkComponentStack demo');
              linkComponentStack(err, '\n    at ManuallyLinked (scenario-panel)');
              void client?.logException(err);
              setStatus('s-report', 'linkComponentStack(err, stack) then logException(err)');
            }}
          >
            linkComponentStack + logException
          </button>
          <StatusLine status={statuses['s-report']} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- React: profiler */}
      <section className="scenario-section">
        <h3>React — BugseeProfiler / withBugseeProfiler / recordReactRenderSpan</h3>
        <div className="control-row">
          <button data-testid="s-toggle-slow-list" onClick={() => setShowSlowList((v) => !v)}>
            {showSlowList ? 'Unmount' : 'Mount'} profiled slow list (300 items)
          </button>
          <button
            className="secondary"
            data-testid="s-manual-render-span"
            onClick={() => {
              const start = performance.now();
              // simulate a known render cost so the recorded span duration is deterministic
              let acc = 0;
              for (let i = 0; i < 500000; i++) acc += Math.sqrt(i);
              const end = performance.now();
              recordReactRenderSpan(
                { id: 'ManualDemo', phase: 'update', actualDuration: end - start, baseDuration: end - start, startTime: start, commitTime: end },
                { source: 'fallback' },
              );
              setStatus('s-manual-span', `recordReactRenderSpan(...) — measured ${(end - start).toFixed(2)}ms (acc=${acc.toFixed(0)})`);
            }}
          >
            recordReactRenderSpan directly
          </button>
          <StatusLine status={statuses['s-manual-span']} />
        </div>
        {showSlowList && (
          <BugseeProfiler id="ScenarioPanelWrapper">
            <SlowList count={300} />
          </BugseeProfiler>
        )}
      </section>

      {/* ---------------------------------------------------------------- React: router pattern helpers */}
      <section className="scenario-section">
        <h3>React — routePatternFromMatches / instrumentRouterMatches</h3>
        <p className="desc">
          The live app already auto-names every navigation by route pattern via `instrumentReactRouter`
          (see router.tsx, self-subscribing on the data router). These controls call the lower-level
          primitives directly, the way an app NOT using a data router would.
        </p>
        <div className="control-row">
          <button
            data-testid="s-route-pattern"
            onClick={() => {
              const matches = [{ route: { path: 'board' } }, { route: { path: ':id' } }, { route: { path: 'card' } }, { route: { path: ':cardId' } }];
              const pattern = routePatternFromMatches(matches);
              setStatus('s-pattern', `routePatternFromMatches(...) -> "${pattern}"`, pattern === '/board/:id/card/:cardId');
            }}
          >
            routePatternFromMatches([board, :id, card, :cardId])
          </button>
          <button
            className="secondary"
            data-testid="s-instrument-matches"
            onClick={() => {
              instrumentRouterMatches([{ route: { path: 'board' } }, { route: { path: ':id' } }]);
              setStatus('s-pattern', 'instrumentRouterMatches([board, :id]) — refined the active transaction');
            }}
          >
            instrumentRouterMatches([board, :id])
          </button>
          <StatusLine status={statuses['s-pattern']} />
        </div>
      </section>
    </div>
  );
}
