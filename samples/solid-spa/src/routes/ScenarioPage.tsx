import { ErrorBoundary, For, Show, createResource, createSignal } from 'solid-js';
import type { JSX, Resource } from 'solid-js';
import { reportSolidError, routePatternFromSolidMatches, setRouteName, setRouteNameFromSolidMatches } from '@bugsee/solid';
import type { LogExceptionOptions, SpanStatus } from '@bugsee/solid';
import {
  attemptDuplicateLaunch,
  FULL_LAUNCH_OPTIONS,
  getClient,
  MINIMAL_LAUNCH_OPTIONS,
  onInternalError,
  relaunch,
} from '../bugsee';
import { scenarioApi, api } from '../api/client';
import ThrowingWidgetImpl, { GuardedThrowingWidget } from '../components/ThrowingWidget';

type Status = { text: string; ok: boolean };

function useStatuses(): [() => Record<string, Status>, (id: string, text: string, ok?: boolean) => void] {
  const [statuses, setStatuses] = createSignal<Record<string, Status>>({});
  const set = (id: string, text: string, ok = true): void => {
    setStatuses((prev: Record<string, Status>): Record<string, Status> => ({ ...prev, [id]: { text, ok } }));
  };
  return [statuses, set];
}

function StatusLine(props: { status?: Status }): JSX.Element | null {
  return (
    <Show when={props.status}>
      <p class={`status-line ${props.status!.ok ? 'ok' : 'err'}`}>{props.status!.text}</p>
    </Show>
  );
}

export default function ScenarioPage(): JSX.Element {
  const [statuses, setStatus] = useStatuses();
  const client = () => getClient();

  // ---- S4 exception dedupe fixture -----------------------------------------------------------
  const sharedError = new Error('shared instance — logException twice must dedupe');

  // ---- Solid-specific: ThrowingWidget demo state ----------------------------------------------
  const [armGuarded, setArmGuarded] = createSignal(false);
  const [armGlobal, setArmGlobal] = createSignal(false);

  // ---- Solid-specific: createResource error demo ----------------------------------------------
  const [resourceTrigger, setResourceTrigger] = createSignal(0);
  const [resource] = createResource(resourceTrigger, async (n) => {
    if (n === 0) return undefined; // not yet armed
    return api.getIssueOrThrow('does-not-exist-404');
  });

  // ---- S8 filters toggle -----------------------------------------------------------------------
  const [filtersInstalled, setFiltersInstalled] = createSignal(false);
  const [filterLog, setFilterLog] = createSignal<string[]>([]);

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
        custom:
          headers || body !== undefined
            ? {
                ...event.custom,
                headers: headers
                  ? Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'x-secret-token'))
                  : headers,
                body,
              }
            : event.custom,
      };
      setFilterLog((prev) => [
        `network: ${event.url} — droppedSecretHeader=${hadSecretHeader} redactedSsn=${hadSsn}`,
        ...prev.slice(0, 39),
      ]);
      // Finding C (FINDINGS.md — re-graded to a DOCS gap, not a defect): the default PII sanitizer never
      // runs once ANY network filter is installed (packages/capture/src/network-provider.ts:151-160 — a
      // user filter REPLACES it, not composes with it; the comment at :137-139 in the same function names
      // this the deliberate "Android XOR rule"). This filter's own logic never touches the URL, so a
      // sensitive-looking query param (`token=`, in the protocol denylist) reaches THIS callback
      // completely unredacted — logged here as direct, reproducible confirmation of the surprise a filter
      // author has no way to learn about from the API surface.
      if (event.url.includes('SUPER_SECRET_TOKEN_VALUE')) {
        setFilterLog((prev) => [
          `network: sanitizer-disabled-by-filter — raw url reached the filter unredacted: ${event.url}`,
          ...prev.slice(0, 39),
        ]);
      }
      if (event.url.includes('veto-me')) {
        setFilterLog((prev) => [`network: VETOED ${event.url}`, ...prev.slice(0, 39)]);
        return null;
      }
      // F-1 (FINDINGS.md, re-graded major): demonstrates the per-ENTRY (not per-REQUEST) veto hole.
      // This rule vetoes on a REQUEST-BODY marker that is only populated on the `before` NetworkStage
      // (packages/capture/src/fetch-interceptor.ts:360-370). The SAME logical request also produces a
      // `complete` stage-entry carrying the RESPONSE headers/body (packages/capture/src/fetch-
      // interceptor.ts:297, the async `override:true` amendment) — which has no request-body field to
      // match, so it sails through UN-vetoed even though the app intended to veto the whole request.
      if (event.url.includes('veto-body-target')) {
        const requestBodyVetoed = typeof body === 'string' && body.includes('VETO_REQUEST_BODY_FIELD');
        setFilterLog((prev) => [
          `network: ${requestBodyVetoed ? 'VETOED(request-body-rule)' : 'leaked-despite-veto-intent(request-body-rule)'} ${event.url} custom=${JSON.stringify(event.custom)}`,
          ...prev.slice(0, 39),
        ]);
        if (requestBodyVetoed) return null;
      }
      return next;
    });
    c.setLogEventFilter((event) => {
      if (event.message.includes('SECRET_TOKEN')) {
        setFilterLog((prev) => [`log: redacted "${event.message}"`, ...prev.slice(0, 39)]);
        return { ...event, message: event.message.replace(/SECRET_TOKEN=\S+/, 'SECRET_TOKEN=[REDACTED]') };
      }
      return event;
    });
    c.setBreadcrumbFilter((crumb) => {
      if (crumb.data && 'secret' in crumb.data) {
        setFilterLog((prev) => [`breadcrumb: redacted data.secret`, ...prev.slice(0, 39)]);
        return { ...crumb, data: { ...crumb.data, secret: '[REDACTED]' } };
      }
      return crumb;
    });
    c.setReportHandler({
      before: (request) => {
        if (request.report.labels.includes('VETO_REPORT')) {
          setFilterLog((prev) => [`report: VETOED ${request.id}`, ...prev.slice(0, 39)]);
          return null;
        }
        if (request.report.labels.includes('MUTATE_ME')) {
          setFilterLog((prev) => [`report: mutated ${request.id}`, ...prev.slice(0, 39)]);
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
  const [internalErrors, setInternalErrors] = createSignal<string[]>([]);
  onInternalError((e) => setInternalErrors((prev) => [String(e instanceof Error ? e.message : e), ...prev.slice(0, 9)]));

  return (
    <div>
      <h2>Scenario panel</h2>
      <p class="desc">
        One control per scenario in docs/samples/PLAN.md §4. Every control here calls the real SDK API
        — see scenarios.md for what should appear in Bugsee for each.
      </p>

      {/* ---------------------------------------------------------------- S1 launch & lifecycle */}
      <section class="scenario-section">
        <h3>S1 — Launch &amp; lifecycle</h3>
        <div class="control-row">
          <span class="label">isLaunched()</span>
          <span data-testid="is-launched">{String(client()?.isLaunched())}</span>
        </div>
        <div class="control-row">
          <span class="label">flush(5000)</span>
          <button
            data-testid="s1-flush"
            onClick={async () => {
              const ok = await client()?.flush(5000);
              setStatus('s1-flush', `flush() -> ${ok}`, ok);
            }}
          >
            Flush
          </button>
          <StatusLine status={statuses()['s1-flush']} />
        </div>
        <div class="control-row">
          <span class="label">Second launch() on the same carrier (must be ignored)</span>
          <button
            data-testid="s1-duplicate-launch"
            onClick={() => {
              const { sameInstance } = attemptDuplicateLaunch();
              setStatus('s1-dup', `same instance returned: ${sameInstance}`, sameInstance);
            }}
          >
            Call launch() again
          </button>
          <StatusLine status={statuses()['s1-dup']} />
        </div>
        <div class="control-row">
          <span class="label">Relaunch with MINIMAL options (same carrier)</span>
          <button
            data-testid="s1-relaunch-minimal"
            onClick={async () => {
              await relaunch(MINIMAL_LAUNCH_OPTIONS);
              setStatus('s1-min', 'relaunched with {} (all defaults)');
            }}
          >
            Relaunch minimal
          </button>
          <StatusLine status={statuses()['s1-min']} />
        </div>
        <div class="control-row">
          <span class="label">Relaunch with FULL options (same carrier)</span>
          <button
            data-testid="s1-relaunch-full"
            onClick={async () => {
              await relaunch(FULL_LAUNCH_OPTIONS);
              setStatus('s1-full', 'relaunched with every option set');
            }}
          >
            Relaunch full
          </button>
          <StatusLine status={statuses()['s1-full']} />
        </div>
        <div class="control-row">
          <span class="label">stop(timeout) — standalone, not incidental inside relaunch()</span>
          <button
            data-testid="s1-stop"
            onClick={async () => {
              // A genuine standalone stop(), not just the one relaunch() runs internally
              // (src/bugsee.ts's relaunch). Reads isLaunched() FRESH here (not via the `is-launched`
              // span above, which Solid only evaluates once at mount — see FINDINGS.md).
              const before = client()?.isLaunched();
              const ok = await client()?.stop(2000);
              const after = client()?.isLaunched();
              setStatus(
                's1-stop',
                `stop(2000) -> ${ok}; isLaunched() before=${before} after=${after}`,
                ok === true && before === true && after === false,
              );
            }}
          >
            Stop
          </button>
          <StatusLine status={statuses()['s1-stop']} />
        </div>
        <div class="control-row">
          <span class="label">Relaunch (restore after Stop)</span>
          <button
            class="secondary"
            data-testid="s1-relaunch-after-stop"
            onClick={async () => {
              // DERIVED, not announced: read isLaunched() FRESH on both sides of the relaunch (the same
              // discipline s1-stop above uses). The original version printed a fixed "relaunched after
              // stop()" string unconditionally, so it could only go red if relaunch() THREW — it never
              // actually checked that the client was restored, which is the claim the check makes.
              const before = client()?.isLaunched();
              await relaunch(FULL_LAUNCH_OPTIONS);
              const after = client()?.isLaunched();
              setStatus(
                's1-restart',
                `relaunched after stop() -> isLaunched() before=${before} after=${after}`,
                before === false && after === true,
              );
            }}
          >
            Relaunch (restore)
          </button>
          <StatusLine status={statuses()['s1-restart']} />
        </div>
        <Show when={internalErrors().length > 0}>
          {/* Given a `data-testid` so `pnpm verify` can READ this list, not only display it. A run in
              round 5 saw two checks go silent — no /v2/issues call and no performance transaction for
              20s — with no way to tell an SDK kill-state (which routes a diagnostic through `onError`)
              apart from an ordinary upload stall, because the sweep never looked here. It does now, in
              the failure details of the two checks concerned. */}
          <div data-testid="internal-errors">
            <p class="desc">onError sink (relaunch/provider diagnostics):</p>
            <ul class="activity-feed">
              <For each={internalErrors()}>{(e) => <li>{e}</li>}</For>
            </ul>
          </div>
        </Show>
      </section>

      {/* ---------------------------------------------------------------- S3 manual telemetry */}
      <section class="scenario-section">
        <h3>S3 — Manual telemetry</h3>
        <div class="control-row">
          <span class="label">log() at every level</span>
          <For each={['error', 'warning', 'info', 'debug', 'verbose'] as const}>
            {(level) => (
              <button
                class="secondary"
                data-testid={`s3-log-${level}`}
                onClick={() => {
                  client()?.log(`sample log at level=${level}`, level);
                  setStatus('s3-log', `log("...", "${level}")`);
                }}
              >
                {level}
              </button>
            )}
          </For>
          <StatusLine status={statuses()['s3-log']} />
        </div>
        <div class="control-row">
          <span class="label">event() with / without params</span>
          <button
            class="secondary"
            data-testid="s3-event-params"
            onClick={() => {
              client()?.event('issue_created', { issueId: 'issue-1', source: 'scenario-panel' });
              setStatus('s3-event', 'event("issue_created", {...})');
            }}
          >
            With params
          </button>
          <button
            class="secondary"
            data-testid="s3-event-no-params"
            onClick={() => {
              client()?.event('scenario_panel_opened');
              setStatus('s3-event', 'event("scenario_panel_opened")');
            }}
          >
            Without params
          </button>
          <StatusLine status={statuses()['s3-event']} />
        </div>
        <div class="control-row">
          <span class="label">trace(name, value)</span>
          <button
            class="secondary"
            data-testid="s3-trace"
            onClick={() => {
              client()?.trace('render.issue_list', { ms: 12.4, issues: 4 });
              setStatus('s3-trace', 'trace("render.issue_list", {...})');
            }}
          >
            Trace
          </button>
          <StatusLine status={statuses()['s3-trace']} />
        </div>
        <div class="control-row">
          <span class="label">addBreadcrumb() — every field</span>
          <button
            class="secondary"
            data-testid="s3-breadcrumb"
            onClick={() => {
              client()?.addBreadcrumb({
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
          <StatusLine status={statuses()['s3-crumb']} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- S4 exceptions */}
      <section class="scenario-section">
        <h3>S4 — Exceptions</h3>
        <div class="control-row">
          <button
            data-testid="s4-error"
            onClick={async () => {
              const r = await client()?.logException(new Error('S4: logException(new Error(...))'));
              setStatus('s4-error', `logException(Error) -> ok=${r?.ok}`, r?.ok);
            }}
          >
            logException(new Error)
          </button>
          <StatusLine status={statuses()['s4-error']} />
        </div>
        <div class="control-row">
          <span class="label">Non-Error throwables</span>
          <button
            class="secondary"
            data-testid="s4-string"
            onClick={async () => {
              await client()?.logException('S4: a bare string throwable');
              setStatus('s4-nonerror', 'logException("string")');
            }}
          >
            string
          </button>
          <button
            class="secondary"
            data-testid="s4-object"
            onClick={async () => {
              await client()?.logException({ code: 'E_SAMPLE', detail: 'plain object throwable' });
              setStatus('s4-nonerror', 'logException({object})');
            }}
          >
            object
          </button>
          <button
            class="secondary"
            data-testid="s4-null"
            onClick={async () => {
              await client()?.logException(null);
              setStatus('s4-nonerror', 'logException(null)');
            }}
          >
            null
          </button>
          <StatusLine status={statuses()['s4-nonerror']} />
        </div>
        <div class="control-row">
          <span class="label">Nested cause</span>
          <button
            data-testid="s4-cause"
            onClick={async () => {
              const root = new Error('S4: root cause');
              const mid = new Error('S4: middle', { cause: root });
              const top = new Error('S4: top-level, chained via cause', { cause: mid });
              const r = await client()?.logException(top);
              setStatus('s4-cause', `logException(chained cause) -> ok=${r?.ok}`, r?.ok);
            }}
          >
            logException(with cause chain)
          </button>
          <StatusLine status={statuses()['s4-cause']} />
        </div>
        <div class="control-row">
          <span class="label">LogExceptionOptions (mechanism/severity/labels)</span>
          <button
            data-testid="s4-options"
            onClick={async () => {
              const options: LogExceptionOptions = {
                mechanism: 'programmatic',
                severity: 'high',
                labels: ['scenario-panel', 's4-options'],
              };
              const r = await client()?.logException(new Error('S4: with LogExceptionOptions'), options);
              setStatus('s4-options', `logException(err, {mechanism, severity, labels}) -> ok=${r?.ok}`, r?.ok);
            }}
          >
            logException with options
          </button>
          <StatusLine status={statuses()['s4-options']} />
        </div>
        <div class="control-row">
          <span class="label">Same instance twice (must dedupe)</span>
          <button
            data-testid="s4-dedupe"
            onClick={async () => {
              const r1 = await client()?.logException(sharedError);
              const r2 = await client()?.logException(sharedError);
              setStatus('s4-dedupe', `first ok=${r1?.ok}, second ok=${r2?.ok} (second should be a dedupe no-op)`);
            }}
          >
            logException(sameInstance) x2
          </button>
          <StatusLine status={statuses()['s4-dedupe']} />
        </div>
        <div class="control-row">
          <span class="label">Storm: 200 exceptions in ~1s (must rate-limit, not crash)</span>
          <button
            data-testid="s4-storm"
            onClick={async () => {
              const start = performance.now();
              for (let i = 0; i < 200; i++) {
                void client()?.logException(new Error(`S4 storm #${i}`));
              }
              setStatus('s4-storm', `fired 200 logException calls in ${(performance.now() - start).toFixed(1)}ms — app still responsive`);
            }}
          >
            Fire storm
          </button>
          <StatusLine status={statuses()['s4-storm']} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- S5 crashes */}
      <section class="scenario-section">
        <h3>S5 — Crashes</h3>
        <div class="control-row">
          <button
            data-testid="s5-uncaught"
            onClick={() => {
              setStatus('s5-uncaught', 'thrown via setTimeout — check window.onerror capture');
              setTimeout(() => {
                throw new Error('S5: uncaught exception outside any try/catch or ErrorBoundary');
              }, 0);
            }}
          >
            Throw uncaught (window.onerror)
          </button>
          <StatusLine status={statuses()['s5-uncaught']} />
        </div>
        <div class="control-row">
          <button
            data-testid="s5-rejection"
            onClick={() => {
              setStatus('s5-rejection', 'rejected — check unhandledrejection capture');
              Promise.reject(new Error('S5: unhandled promise rejection'));
            }}
          >
            Unhandled promise rejection
          </button>
          <StatusLine status={statuses()['s5-rejection']} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- S6 console capture */}
      <section class="scenario-section">
        <h3>S6 — Console capture</h3>
        <div class="control-row">
          <For each={['log', 'info', 'warn', 'error', 'debug', 'trace'] as const}>
            {(m) => (
              <button
                class="secondary"
                data-testid={`s6-${m}`}
                onClick={() => {
                  // eslint-disable-next-line no-console
                  console[m](`S6: console.${m} from the scenario panel`, { at: Date.now() });
                  setStatus('s6', `console.${m}(...)`);
                }}
              >
                console.{m}
              </button>
            )}
          </For>
        </div>
        <div class="control-row">
          <button
            class="secondary"
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
          <StatusLine status={statuses()['s6']} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- S7 network capture */}
      <section class="scenario-section">
        <h3>S7 — Network capture</h3>
        <div class="control-row">
          <button
            class="secondary"
            data-testid="s7-get"
            onClick={async () => {
              const body = await scenarioApi.get();
              setStatus('s7', `GET /scenario/get -> ${JSON.stringify(body)}`);
            }}
          >
            fetch GET
          </button>
          <button
            class="secondary"
            data-testid="s7-post-json"
            onClick={async () => {
              const body = await scenarioApi.postJson({ hello: 'world', n: 42 });
              setStatus('s7', `POST JSON -> ${JSON.stringify(body)}`);
            }}
          >
            fetch POST JSON
          </button>
          <button
            class="secondary"
            data-testid="s7-post-text"
            onClick={async () => {
              const body = await scenarioApi.postText('plain text body');
              setStatus('s7', `POST text -> "${body}"`);
            }}
          >
            fetch POST text
          </button>
          <button
            class="secondary"
            data-testid="s7-4xx"
            onClick={async () => {
              const r = await scenarioApi.get4xx();
              setStatus('s7', `GET 4xx -> status ${r.status}`);
            }}
          >
            4xx
          </button>
          <button
            class="secondary"
            data-testid="s7-5xx"
            onClick={async () => {
              const r = await scenarioApi.get5xx();
              setStatus('s7', `GET 5xx -> status ${r.status}`);
            }}
          >
            5xx
          </button>
          <button
            class="secondary"
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
            class="secondary"
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
            class="secondary"
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
            class="secondary"
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
            class="secondary"
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
            class="secondary"
            data-testid="s7-send-beacon"
            onClick={() => {
              // `navigator.sendBeacon` has its own interceptor in `@bugsee/capture` and this sample
              // called it nowhere, so that transport had no coverage at all here. The marker goes in
              // the body so the sweep can find THIS beacon on the wire and in network.json.
              const { stringAccepted, blobAccepted } = scenarioApi.sendBeacon('S7_BEACON_MARKER');
              setStatus(
                's7',
                `sendBeacon queued by the UA -> string=${stringAccepted} blob=${blobAccepted}`,
                stringAccepted && blobAccepted,
              );
            }}
          >
            sendBeacon POST
          </button>
          <button
            class="secondary"
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
        <StatusLine status={statuses()['s7']} />
      </section>

      {/* ---------------------------------------------------------------- S8 filters & redaction */}
      <section class="scenario-section">
        <h3>S8 — Filters &amp; redaction</h3>
        <p class="desc">
          Network-filter verification is LOCAL only — the backend surface (`get_issue`) does not expose
          network entries. Log/breadcrumb/report-handler filters ARE verifiable on the backend (they
          land in `# Logs` / labels). Two KNOWN SDK DEFECTS are deliberately reproduced here (not fixed
          — see FINDINGS.md): F-1 the network filter's veto is per-NetworkStage-entry, not per-request
          (a request-body veto rule leaks the response's `complete` stage-entry); and Finding C,
          installing ANY network filter silently disables the built-in PII sanitizer for every request.
        </p>
        <div class="control-row">
          <button data-testid="s8-install" onClick={installFilters} disabled={filtersInstalled()}>
            Install filters
          </button>
          <button class="secondary" data-testid="s8-uninstall" onClick={uninstallFilters} disabled={!filtersInstalled()}>
            Uninstall filters
          </button>
          <span class="label">installed: {String(filtersInstalled())}</span>
        </div>
        <div class="control-row">
          <button class="secondary" data-testid="s8-network" onClick={() => void scenarioApi.postSecret()}>
            POST with secret header + ssn body field
          </button>
          <button class="secondary" data-testid="s8-veto-network" onClick={() => void scenarioApi.getVetoTarget()}>
            GET a vetoed URL
          </button>
          <button
            class="secondary"
            data-testid="s8-veto-request-body"
            onClick={() => void scenarioApi.postVetoRequestBody()}
          >
            POST vetoed by a request-body marker (F-1: veto hole demo)
          </button>
          <button
            class="secondary"
            data-testid="s8-sensitive-url"
            onClick={() => void scenarioApi.getWithSensitiveUrlToken()}
          >
            GET with a sensitive `token=` query param (Finding C: sanitizer-disabled demo)
          </button>
          <button
            class="secondary"
            data-testid="s8-log"
            onClick={() => client()?.log('leaking SECRET_TOKEN=abc123 in a log line', 'info')}
          >
            log() with a secret
          </button>
          <button
            class="secondary"
            data-testid="s8-breadcrumb"
            onClick={() =>
              client()?.addBreadcrumb({ category: 'test', message: 'crumb with secret data', data: { secret: 'sk_live_xyz' } })
            }
          >
            addBreadcrumb() with secret data
          </button>
          {/* Both report-handler controls are GUARDED on filtersInstalled(), like "Uninstall filters"
              above — round-4 finding R4-1. Without the guard the VETO button is clickable before
              "Install filters" (or after "Uninstall filters"), in which case no report handler exists,
              nothing vetoes the report, and an exception whose own message says "must never arrive"
              uploads legitimately: that is exactly how SSOLID-82 (`6a8f5dcbd58badbb34924a7a`,
              2026-08-26T21:42:34Z, events_count 1) got onto staging while every sweep printed a full
              pass. It is NOT an SDK defect — packages/core/src/client.ts:670-673 returns `{ok:false}`
              from `applyReportBefore(request) === null` BEFORE `submitReport` is reached, so a genuinely
              vetoed report cannot upload. The MUTATE button is guarded for the same reason: clicked
              without filters it uploads WITHOUT the `redacted-before` label, silently weakening the
              backend evidence scenarios.md's S8 mutate row cites. */}
          <button
            class="secondary"
            data-testid="s8-report-mutate"
            disabled={!filtersInstalled()}
            onClick={() =>
              void client()?.logException(new Error('S8: report handler should mutate this'), {
                labels: ['MUTATE_ME'],
              })
            }
          >
            logException — should be mutated (label added)
          </button>
          <button
            class="secondary"
            data-testid="s8-report-veto"
            disabled={!filtersInstalled()}
            onClick={() =>
              void client()?.logException(new Error('S8: report handler should VETO this — must never arrive'), {
                labels: ['VETO_REPORT'],
              })
            }
          >
            logException — should be VETOED
          </button>
        </div>
        <Show when={filterLog().length > 0}>
          <ul class="activity-feed" data-testid="filter-log">
            <For each={filterLog()}>{(l) => <li>{l}</li>}</For>
          </ul>
        </Show>
      </section>

      {/* ---------------------------------------------------------------- S9 performance / APM */}
      <section class="scenario-section">
        <h3>S9 — Performance / APM</h3>
        <p class="desc">
          Page-load + navigation + interaction transactions are automatic (traceNavigations/
          traceInteractions on by default) — just browsing the app exercises them. This control adds a
          manual transaction with a child span per SpanStatus.
        </p>
        <div class="control-row">
          <button
            data-testid="s9-manual-transaction"
            onClick={() => {
              const perf = client()?.ext('performance');
              if (!perf) return setStatus('s9', 'performance ext not registered', false);
              const tx = perf.startTransaction({ name: 'scenario.manual_transaction', operation: 'custom' });
              const spanStatuses: SpanStatus[] = ['OK', 'ERROR', 'TIMEOUT', 'CANCELLED', 'DEADLINE_EXCEEDED', 'UNKNOWN'];
              for (const s of spanStatuses) {
                const span = tx.startChildSpan(`child.${s.toLowerCase()}`, `child span with status ${s}`);
                span.setAttribute('scenario', 's9');
                span.finish(s);
              }
              tx.finish('OK');
              setStatus('s9', `started transaction, ${spanStatuses.length} child spans (one per SpanStatus), finished OK`);
            }}
          >
            Manual transaction + every SpanStatus
          </button>
          <StatusLine status={statuses()['s9']} />
        </div>
        <div class="control-row">
          <span class="label">setRouteName (direct call)</span>
          <button
            class="secondary"
            data-testid="s9-set-route-name"
            onClick={() => {
              // Wraps its OWN transaction (rather than relying on whatever happens to be ambient) so
              // this is a deterministic, wire-verifiable check: start it, rename it, finish it — see
              // scripts/verify.mjs's `waitForPerfTransactions` for the uploaded-name assertion. This is
              // the DIRECT-call primitive, with no @solidjs/router timing race — contrast with the LIVE
              // router wiring (RootLayout.tsx's RouteNameSync), which IS racy — see FINDINGS.md finding A.
              const perf = client()?.ext('performance');
              if (!perf) return setStatus('s9-route', 'performance ext not registered', false);
              const tx = perf.startTransaction({ name: 'scenario.route_name_demo', operation: 'custom' });
              setRouteName('/manual/:demo');
              tx.finish('OK');
              setStatus('s9-route', 'setRouteName("/manual/:demo") called against a fresh active transaction, then finished — see the wire check for the uploaded name');
            }}
          >
            setRouteName
          </button>
          <StatusLine status={statuses()['s9-route']} />
        </div>
        <div class="control-row">
          <span class="label">performanceSampleRate: 0 (previously never exercised — PLAN §4 S9)</span>
          <button
            data-testid="s9-sample-rate-zero"
            onClick={async () => {
              await relaunch({ ...FULL_LAUNCH_OPTIONS, performanceSampleRate: 0 });
              const perf = client()?.ext('performance');
              const tx = perf?.startTransaction({ name: 'scenario.sample_rate_zero_demo', operation: 'custom' });
              tx?.finish('OK');
              setStatus(
                's9-sample-zero',
                'relaunched with performanceSampleRate:0, started+finished a transaction -- see the wire check for "never uploaded" (unsampled transactions never reach the store, packages/performance/src/controller.ts:104)',
              );
            }}
          >
            Relaunch performanceSampleRate:0
          </button>
          <StatusLine status={statuses()['s9-sample-zero']} />
        </div>
        <div class="control-row">
          <span class="label">Restore performanceSampleRate: 1</span>
          <button
            class="secondary"
            data-testid="s9-sample-rate-restore"
            onClick={async () => {
              await relaunch(FULL_LAUNCH_OPTIONS);
              setStatus('s9-sample-restore', 'relaunched back to performanceSampleRate:1 (FULL_LAUNCH_OPTIONS)');
            }}
          >
            Restore performanceSampleRate:1
          </button>
          <StatusLine status={statuses()['s9-sample-restore']} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- S11 session replay */}
      <section class="scenario-section">
        <h3>S11 — Session replay</h3>
        <p class="desc">
          `@bugsee/replay` (+ `@bugsee/replay-canvas`) are transitive dependencies of `@bugsee/browser`,
          not packages directly under test in this sample — but the catalog scenario still applies.
          <strong>Replay is ON BY DEFAULT</strong> (`packages/browser/src/launch.ts`:
          `options.replay !== false && domDocument !== undefined`), so it is recording for every control
          on this page, not just the ones below; `replay: false` is the opt-out, and a DOM-less host
          (SSR/pre-render) self-skips silently. Each control relaunches the SDK with a different replay
          option set. `get_issue` does not expose replay CONTENTS, so this is verified at the wire level
          instead: `replay.bin` present in the uploaded bundle at the DEFAULT, absent under
          `replay: false`, and — since `replay.bin` is just `gzipSync(JSON.stringify(payloads))` — its
          decoded contents checked for what masking did and did not leak.
        </p>
        <div class="control-row">
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
            class="secondary"
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
            class="secondary"
            data-testid="s11-replay-canvas-fixed"
            onClick={async () => {
              await relaunch({ ...FULL_LAUNCH_OPTIONS, replay: { canvas: { fps: 2 } } });
              setStatus('s11', 'relaunched with replay.canvas: { fps: 2 } (fixed-fps canvas recording)');
            }}
          >
            replay: canvas fps=2
          </button>
          <button
            class="secondary"
            data-testid="s11-replay-canvas-all"
            onClick={async () => {
              await relaunch({ ...FULL_LAUNCH_OPTIONS, replay: { canvas: { fps: 'all' } } });
              setStatus('s11', "relaunched with replay.canvas: { fps: 'all' } (every draw call, full fidelity)");
            }}
          >
            replay: canvas fps='all'
          </button>
          <button
            class="secondary"
            data-testid="s11-replay-unmasked"
            onClick={async () => {
              await relaunch({
                ...FULL_LAUNCH_OPTIONS,
                replay: { maskAllText: false, maskAllInputs: false },
              });
              setStatus(
                's11',
                'relaunched with masking OFF (maskAllText:false, maskAllInputs:false) — the POSITIVE CONTROL for the masking checks: whatever is typed now SHOULD appear verbatim in replay.bin',
              );
            }}
          >
            replay: masking OFF (positive control)
          </button>
          <button
            class="secondary"
            data-testid="s11-replay-off"
            onClick={async () => {
              await relaunch({ ...FULL_LAUNCH_OPTIONS, replay: false });
              setStatus('s11', 'relaunched with replay: false (the OPT-OUT — no replay.bin in the next bundle)');
            }}
          >
            replay: false (opt out)
          </button>
          <button
            class="secondary"
            data-testid="s11-replay-restore"
            onClick={async () => {
              await relaunch(FULL_LAUNCH_OPTIONS);
              setStatus(
                's11',
                'relaunched with FULL_LAUNCH_OPTIONS — no `replay` key at all, i.e. replay at its DEFAULT, which is ON',
              );
            }}
          >
            Restore (replay at default = ON)
          </button>
        </div>
        <div class="field-row">
          {/* The opt-out mark for an input VALUE is `.bugsee-unmask`, NOT `.bugsee-show`.
              `packages/replay/src/masking.ts` feeds `.bugsee-unmask` to rrweb's `unmaskTextSelector` +
              `unmaskInputSelector` and `.bugsee-show` to `unblockSelector` — the latter un-BLOCKS media
              (img/video/audio/canvas), and does nothing at all for a text input. This sample shipped
              `.bugsee-show` on the input below and claimed it opted out; it never did. Two peer samples
              had the identical defect. */}
          <label for="s11-masked">
            masking demo — both inputs are masked by default (maskAllInputs); the second one carries the
            `.bugsee-unmask` opt-out mark
          </label>
          <input id="s11-masked" placeholder="masked by default" data-testid="s11-masked-field" />
          <input
            id="s11-shown"
            class="bugsee-unmask"
            placeholder="marked .bugsee-unmask"
            data-testid="s11-shown-field"
          />
        </div>
        <StatusLine status={statuses()['s11']} />
      </section>

      {/* ---------------------------------------------------------------- S12 persistence */}
      <section class="scenario-section">
        <h3>S12 — Persistence &amp; recovery</h3>
        <p class="desc">
          Logs an exception, then force-reloads the page 250ms later — before the upload can settle, but
          AFTER the durable bundle queue has taken its copy. `persist`/`recover` (both on in
          FULL_LAUNCH_OPTIONS) re-upload it on the next launch. Verified over MCP by polling for the
          issue AFTER the reload. See FINDINGS.md finding B: past ~40ms this reliably delivers the SAME
          incident TWICE.
        </p>
        <div class="control-row">
          <button
            data-testid="s12-crash-and-reload"
            onClick={() => {
              // The 250ms delay is load-bearing, not arbitrary. @bugsee/core persists the bundle to the
              // durable queue BEFORE handing it to the upload pipeline
              // (packages/core/src/durable-upload-pipeline.test.ts:111 pins the order as ['put',
              // 'enqueue']), so a reload timed at the ORIGINAL 5ms lands before the durable queue owns
              // anything: only the report marker survives, only core's recoverReports leg runs, and the
              // result is always exactly ONE upload. 5ms was the one timing that could never expose
              // FINDINGS.md finding B — and no real user reloads 5ms after a crash. Measured on this
              // sample: 5ms -> 1 upload (2/2 runs); 40ms -> 2 (2/2); 250ms -> 2 (3/3).
              void client()?.logException(new Error('S12: persist+recover across a hard reload'));
              setTimeout(() => window.location.reload(), 250);
            }}
          >
            logException then hard-reload (250ms)
          </button>
        </div>
      </section>

      {/* ---------------------------------------------------------------- Solid: ErrorBoundary */}
      <section class="scenario-section">
        <h3>Solid — solidErrorHandler in an &lt;ErrorBoundary&gt;</h3>
        <div class="control-row">
          <span class="label">Locally-guarded widget (own &lt;ErrorBoundary&gt; + solidErrorHandler fallback)</span>
          <button class="secondary" data-testid="arm-guarded" onClick={() => setArmGuarded(true)}>
            Arm + throw
          </button>
          <button class="secondary" data-testid="disarm-guarded" onClick={() => setArmGuarded(false)}>
            Reset
          </button>
        </div>
        <GuardedThrowingWidget armed={armGuarded} label="guarded" />

        <div class="control-row" style={{ 'margin-top': '12px' }}>
          <span class="label">Unguarded widget — propagates to the app-level &lt;ErrorBoundary&gt; in main.tsx</span>
          <button class="secondary" data-testid="arm-global" onClick={() => setArmGlobal(true)}>
            Arm + throw (replaces this page)
          </button>
        </div>
        <Show when={armGlobal()}>
          <ThrowingWidgetImpl armed={armGlobal} label="global" />
        </Show>
      </section>

      {/* ---------------------------------------------------------------- Solid: reportSolidError */}
      <section class="scenario-section">
        <h3>Solid — reportSolidError (direct call)</h3>
        <div class="control-row">
          <button
            data-testid="s-report-solid-error"
            onClick={() => {
              reportSolidError(new Error('Solid: reportSolidError called directly'), { mechanism: 'programmatic' });
              setStatus('s-report', 'reportSolidError(error, {mechanism})');
            }}
          >
            reportSolidError directly
          </button>
          <StatusLine status={statuses()['s-report']} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- Solid: route pattern helpers */}
      <section class="scenario-section">
        <h3>Solid — routePatternFromSolidMatches / setRouteNameFromSolidMatches</h3>
        <p class="desc">
          The live app already auto-names every navigation by route pattern via `useCurrentMatches` +
          `setRouteNameFromSolidMatches` (see RootLayout.tsx's `RouteNameSync`, wired once globally).
          These controls call the primitives directly with a synthetic matches array, the way an app
          NOT using the router's reactive hook would.
        </p>
        <div class="control-row">
          <button
            data-testid="s-route-pattern"
            onClick={() => {
              // @solidjs/router's RouteDescription.pattern is already the FULL cumulative pattern (a
              // nested route's pattern is its parent's pattern + its own segment — see
              // createRoutes()/joinPaths in @solidjs/router's routing.js), so the deepest match alone
              // carries the whole thing — matching what /issues/:id/comments actually produces via
              // useCurrentMatches() in this app.
              const matches = [
                { route: { pattern: '/issues/:id' } },
                { route: { pattern: '/issues/:id/comments' } },
              ];
              const pattern = routePatternFromSolidMatches(matches);
              setStatus('s-pattern', `routePatternFromSolidMatches(...) -> "${pattern}"`, pattern === '/issues/:id/comments');
            }}
          >
            routePatternFromSolidMatches([/issues/:id, /issues/:id/comments])
          </button>
          <button
            class="secondary"
            data-testid="s-set-route-name-matches"
            onClick={() => {
              // Wraps its OWN transaction so this is deterministic and wire-verifiable (rather than
              // relying on whatever happens to be ambient, then unconditionally claiming success) — see
              // scripts/verify.mjs's `waitForPerfTransactions`. This is the DIRECT-call primitive, with
              // no @solidjs/router timing race — contrast with the LIVE reactive wiring
              // (RootLayout.tsx's RouteNameSync), which IS racy and does NOT reliably land — see
              // FINDINGS.md finding A / the `solid-route-name-wire` check.
              const perf = client()?.ext('performance');
              if (!perf) return setStatus('s-pattern', 'performance ext not registered', false);
              const tx = perf.startTransaction({ name: 'scenario.route_name_matches_demo', operation: 'custom' });
              setRouteNameFromSolidMatches([{ route: { pattern: '/issues/:id' } }]);
              tx.finish('OK');
              setStatus('s-pattern', 'setRouteNameFromSolidMatches([{route:{pattern:"/issues/:id"}}]) called against a fresh active transaction, then finished — see the wire check for the uploaded name');
            }}
          >
            setRouteNameFromSolidMatches([/issues/:id])
          </button>
          <StatusLine status={statuses()['s-pattern']} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- Solid: createResource error */}
      <section class="scenario-section">
        <h3>Solid — an error inside a createResource</h3>
        <p class="desc">
          A `createResource` fetcher that rejects (fetching a nonexistent issue id) puts the resource
          into an ERROR state; reading the resource accessor while it's errored RE-THROWS the rejection
          synchronously into the reactive scope, which the local `&lt;ErrorBoundary&gt;` below catches
          via `solidErrorHandler`.
        </p>
        <div class="control-row">
          <button
            data-testid="s-resource-error-arm"
            onClick={() => setResourceTrigger((n) => n + 1)}
          >
            Fetch a nonexistent issue (createResource throws)
          </button>
        </div>
        <ResourceErrorDemo resource={resource} />
      </section>
    </div>
  );
}

/** Isolated so the local &lt;ErrorBoundary&gt; only spans the resource read, not the whole page. */
function ResourceErrorDemo(props: { resource: Resource<unknown> }): JSX.Element {
  return (
    <ErrorBoundary
      fallback={(error) => {
        reportSolidError(error, { mechanism: 'programmatic' });
        return (
          <p class="status-line err" data-testid="resource-error-fallback">
            createResource error caught: {error instanceof Error ? error.message : String(error)}
          </p>
        );
      }}
    >
      <Show when={props.resource.loading}>
        <p class="status-line">loading…</p>
      </Show>
      <Show when={!props.resource.loading && props.resource() !== undefined}>
        <p class="status-line ok" data-testid="resource-ok">
          resource resolved: {JSON.stringify(props.resource())}
        </p>
      </Show>
    </ErrorBoundary>
  );
}
