import { Component, OnDestroy, OnInit, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { SpanStatus } from '@bugsee/performance';
import {
  BugseeErrorHandler,
  createAngularErrorHandler,
  reportAngularError,
  routePatternFromSnapshot,
  setRouteName,
  setRouteNameFromRouter,
  type AngularRouterLike,
  type LogExceptionOptions,
  type RouteSnapshotLike,
} from '@bugsee/angular';
import {
  attemptDuplicateLaunch,
  FULL_LAUNCH_OPTIONS,
  getClient,
  MINIMAL_LAUNCH_OPTIONS,
  onInternalError,
  relaunch,
} from '../bugsee';
import { scenarioApi } from './scenario-api';
import { ThrowingService } from '../shared/throwing.service';
import { ThrowingWidgetComponent } from '../shared/throwing-widget.component';

type Status = { text: string; ok: boolean };
type AttrType = 'string' | 'number' | 'boolean' | 'string[]';

@Component({
  selector: 'app-scenario-panel',
  standalone: true,
  imports: [ThrowingWidgetComponent],
  templateUrl: './scenario-panel.component.html',
})
export class ScenarioPanelComponent implements OnInit, OnDestroy {
  readonly #throwingService = inject(ThrowingService);
  readonly #http = inject(HttpClient);

  // A GETTER, not a cached field: after relaunch() (S1 controls below) the module-level client in
  // bugsee.ts is a NEW instance and the OLD one is stopped. Caching `getClient()` once here (as a
  // plain readonly field) meant every control after the first relaunch called methods on a stale,
  // stopped client — logException()/flush()/etc. silently no-op on a stopped client, so this was a
  // sample bug that looked exactly like an SDK defect until traced. Fixed by always resolving fresh.
  get client() {
    return getClient();
  }
  readonly statuses = signal<Record<string, Status>>({});
  readonly internalErrors = signal<string[]>([]);
  #unsubscribeInternalErrors?: () => void;

  // ---- S4 exception dedupe fixture ---------------------------------------------------------------
  readonly sharedError = new Error('shared instance — logException twice must dedupe');

  // ---- Angular-specific: throwing widget/service/rxjs/HttpClient demo state ----------------------
  readonly armWidget = signal(false);

  // ---- S8 filters toggle --------------------------------------------------------------------------
  readonly filtersInstalled = signal(false);
  readonly filterLog = signal<string[]>([]);

  // ---- Settings-style attribute inputs used by nothing here; S2 lives in settings.component.ts ----

  ngOnInit(): void {
    this.#unsubscribeInternalErrors = onInternalError((e) =>
      this.internalErrors.update((prev) => [String(e instanceof Error ? e.message : e), ...prev.slice(0, 9)]),
    );
  }

  ngOnDestroy(): void {
    this.#unsubscribeInternalErrors?.();
  }

  setStatus(id: string, text: string, ok = true): void {
    this.statuses.update((prev) => ({ ...prev, [id]: { text, ok } }));
  }

  // ------------------------------------------------------------------------------------------ S1
  async flush(): Promise<void> {
    const ok = await this.client?.flush(5000);
    this.setStatus('s1-flush', `flush() -> ${ok}`, ok === true);
  }

  duplicateLaunch(): void {
    const { sameInstance } = attemptDuplicateLaunch();
    this.setStatus('s1-dup', `same instance returned: ${sameInstance}`, sameInstance);
  }

  async relaunchMinimal(): Promise<void> {
    await relaunch(MINIMAL_LAUNCH_OPTIONS);
    // NOT a truly-minimal launch — see FINDINGS.md F-... "Relaunch minimal" / bugsee.ts's
    // MINIMAL_LAUNCH_OPTIONS doc comment: relaunch() always injects endpoint/appId/appVersion/appBuild/
    // onError ahead of these (empty) options, deliberately, because a truly-default endpoint would be
    // PRODUCTION (PLAN §3 forbids that). The caller-supplied options object is `{}`; the resolved
    // launch options are not.
    this.setStatus('s1-min', 'relaunched with caller options = {} (endpoint/appId/etc still pinned to staging by relaunch())');
  }

  /** Direct `stop(timeout)` call + its discarded-elsewhere return value (bugsee.ts's `relaunch()` calls
   *  `client.stop()` too, but never looks at what it returns). Exercised here as its own control so
   *  the boolean result is actually checked; the very next control (`relaunchFull`, in the verify sweep)
   *  brings the client back so nothing downstream runs against a stopped client. */
  async stopDirect(): Promise<void> {
    const ok = await this.client?.stop(2000);
    this.setStatus('s1-stop', `stop(2000) -> ${ok}`, ok === true);
  }

  async relaunchFull(): Promise<void> {
    await relaunch(FULL_LAUNCH_OPTIONS);
    this.setStatus('s1-full', 'relaunched with every option set');
  }

  // ------------------------------------------------------------------------------------------ S3
  log(level: 'error' | 'warning' | 'info' | 'debug' | 'verbose'): void {
    this.client?.log(`sample log at level=${level}`, level);
    this.setStatus('s3-log', `log("...", "${level}")`);
  }

  eventWithParams(): void {
    this.client?.event('expense_created', { category: 'Software', source: 'scenario-panel' });
    this.setStatus('s3-event', 'event("expense_created", {...})');
  }

  eventWithoutParams(): void {
    this.client?.event('scenario_panel_opened');
    this.setStatus('s3-event', 'event("scenario_panel_opened")');
  }

  trace(): void {
    this.client?.trace('render.expenses_list', { ms: 12.4, rows: 5 });
    this.setStatus('s3-trace', 'trace("render.expenses_list", {...})');
  }

  breadcrumb(): void {
    this.client?.addBreadcrumb({
      type: 'navigation',
      category: 'ui.click',
      message: 'user clicked "Add breadcrumb" in the scenario panel',
      level: 'info',
      data: { control: 's3-breadcrumb', screen: 'scenarios' },
    });
    this.setStatus('s3-crumb', 'addBreadcrumb({type, category, message, level, data})');
  }

  // ------------------------------------------------------------------------------------------ S4
  async logError(): Promise<void> {
    const r = await this.client?.logException(new Error('S4: logException(new Error(...))'));
    this.setStatus('s4-error', `logException(Error) -> ok=${r?.ok}`, r?.ok === true);
  }

  async logString(): Promise<void> {
    await this.client?.logException('S4: a bare string throwable');
    this.setStatus('s4-nonerror', 'logException("string")');
  }

  async logObject(): Promise<void> {
    await this.client?.logException({ code: 'E_SAMPLE', detail: 'plain object throwable' });
    this.setStatus('s4-nonerror', 'logException({object})');
  }

  async logNull(): Promise<void> {
    await this.client?.logException(null);
    this.setStatus('s4-nonerror', 'logException(null)');
  }

  async logCause(): Promise<void> {
    const root = new Error('S4: root cause');
    const mid = new Error('S4: middle', { cause: root });
    const top = new Error('S4: top-level, chained via cause', { cause: mid });
    const r = await this.client?.logException(top);
    this.setStatus('s4-cause', `logException(chained cause) -> ok=${r?.ok}`, r?.ok === true);
  }

  async logWithOptions(): Promise<void> {
    // EVERY value here is deliberately NON-DEFAULT, which the round-6 fixture was not.
    //
    // It used to pass `mechanism: 'programmatic'` + `severity: 'high'`, and those are exactly what the
    // SDK produces when the options object is absent: `client.ts:661` defaults `mechanism` to
    // `'programmatic'`, and `defaultSeverity('error')` (`packages/core/src/reporting.ts:96-97`) is
    // `'high'`. So the backend evidence for "LogExceptionOptions was honoured" was byte-identical to a
    // control that passes no options at all — `get_issue SANGULAR-148` (`s4-error`) rendered the same
    // `Trigger: error / Mechanism: programmatic` and the same `severity: High` as `SANGULAR-153`
    // (`s4-options`). Only `# Labels` discriminated.
    //
    // `blocker` is wire severity 5 vs the default's 3, and `manual-dialog` is a mechanism nothing else in
    // this sample emits — so `verify.mjs`'s `s4-options-wire` now fails if either is dropped on the floor.
    const options: LogExceptionOptions = {
      mechanism: 'manual-dialog',
      severity: 'blocker',
      labels: ['scenario-panel', 's4-options'],
    };
    const r = await this.client?.logException(new Error('S4: with LogExceptionOptions'), options);
    this.setStatus('s4-options', `logException(err, {mechanism, severity, labels}) -> ok=${r?.ok}`, r?.ok === true);
  }

  async logDedupe(): Promise<void> {
    const r1 = await this.client?.logException(this.sharedError);
    const r2 = await this.client?.logException(this.sharedError);
    this.setStatus('s4-dedupe', `first ok=${r1?.ok}, second ok=${r2?.ok} (second should be a dedupe no-op)`);
  }

  async logStorm(): Promise<void> {
    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      void this.client?.logException(new Error(`S4 storm #${i}`));
    }
    this.setStatus('s4-storm', `fired 200 logException calls in ${(performance.now() - start).toFixed(1)}ms — app still responsive`);
  }

  // ------------------------------------------------------------------------------------------ S5
  throwUncaught(): void {
    this.setStatus('s5-uncaught', 'thrown via setTimeout — check window.onerror capture');
    setTimeout(() => {
      throw new Error('S5: uncaught exception outside any try/catch or Angular zone task');
    }, 0);
  }

  rejectUncaught(): void {
    this.setStatus('s5-rejection', 'rejected — check unhandledrejection capture');
    Promise.reject(new Error('S5: unhandled promise rejection'));
  }

  // ------------------------------------------------------------------------------------------ S6
  consoleCall(method: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace'): void {
    // eslint-disable-next-line no-console
    console[method](`S6: console.${method} from the scenario panel`, { at: Date.now() });
    this.setStatus('s6', `console.${method}(...)`);
  }

  consoleCircular(): void {
    const obj: Record<string, unknown> = { name: 'circular-fixture' };
    obj['self'] = obj;
    // eslint-disable-next-line no-console
    console.log('S6: circular object', obj);
    this.setStatus('s6', 'console.log(circular object)');
  }

  // ------------------------------------------------------------------------------------------ S7
  async s7Get(): Promise<void> {
    const body = await scenarioApi.get();
    this.setStatus('s7', `GET /scenario/get -> ${JSON.stringify(body)}`);
  }

  async s7PostJson(): Promise<void> {
    const body = await scenarioApi.postJson({ hello: 'world', n: 42 });
    this.setStatus('s7', `POST JSON -> ${JSON.stringify(body)}`);
  }

  async s7PostText(): Promise<void> {
    const body = await scenarioApi.postText('plain text body');
    this.setStatus('s7', `POST text -> "${body}"`);
  }

  async s7Get4xx(): Promise<void> {
    const r = await scenarioApi.get4xx();
    this.setStatus('s7', `GET 4xx -> status ${r.status}`);
  }

  async s7Get5xx(): Promise<void> {
    const r = await scenarioApi.get5xx();
    this.setStatus('s7', `GET 5xx -> status ${r.status}`);
  }

  async s7ConnFail(): Promise<void> {
    try {
      await scenarioApi.getConnectionFailure();
      this.setStatus('s7', 'connection failure: unexpectedly succeeded', false);
    } catch (e) {
      this.setStatus('s7', `connection failure -> ${String(e)}`);
    }
  }

  async s7LargeBody(): Promise<void> {
    const r = await scenarioApi.getLargeBody();
    const body = (await r.json()) as { big: string };
    this.setStatus(
      's7',
      // NOT "truncates": over the byte cap the SDK DROPS the captured body entirely and tags the entry
      // `custom.no_body_reason: 'size_too_large'` (packages/capture/src/network-body.ts's `boundedText`).
      // The app's own read is untouched either way — interceptors must not alter app behaviour.
      `large body -> read ${body.big.length} bytes client-side (maxNetworkBodySize=2048 DROPS the CAPTURED copy entirely — no_body_reason: 'size_too_large' — the app still reads all of it)`,
    );
  }

  async s7NoContentType(): Promise<void> {
    const r = await scenarioApi.getNoContentType();
    const text = await r.text();
    this.setStatus('s7', `no Content-Type -> read "${text}" (captureNetworkBodyWithoutType=true)`);
  }

  async s7Slow(): Promise<void> {
    this.setStatus('s7', 'slow request started…');
    const r = await scenarioApi.getSlow(2500);
    this.setStatus('s7', `slow request settled: ${r.status}`);
  }

  s7Xhr(): void {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/scenario/get');
    xhr.onload = () => this.setStatus('s7', `XHR -> ${xhr.status} ${xhr.responseText}`);
    xhr.onerror = () => this.setStatus('s7', 'XHR errored', false);
    xhr.send();
  }

  /**
   * `navigator.sendBeacon` — a capture source the substrate gained after round 6, and one no other
   * control here reaches: the beacon path is neither `fetch` nor `XHR`, it is a fire-and-forget queue
   * the browser drains after the page may already be gone, which is exactly why analytics/unload code
   * uses it and exactly why an uninstrumented one is a hole in the network record.
   *
   * The status line prints the tag that is also in the beacon's URL and body, so `verify.mjs` can bind
   * the entry it finds in the UPLOADED bundle to THIS click rather than to any beacon (the SDK itself
   * sends none — it patches `navigator.sendBeacon` but never calls it).
   *
   * `sendBeacon` returns false when the user agent refuses to queue the payload (over quota); that is a
   * real outcome, not an exception, so it is reported as a failed status rather than swallowed.
   */
  s7SendBeacon(): void {
    const tag = `beacon-${Date.now().toString(36)}`;
    const queued = navigator.sendBeacon(
      `/api/scenario/echo?beacon=${tag}`,
      JSON.stringify({ beacon: tag }),
    );
    this.setStatus(
      's7',
      queued
        ? `sendBeacon queued ${tag} (POST /api/scenario/echo?beacon=${tag})`
        : `sendBeacon REFUSED ${tag} — the user agent declined to queue the payload`,
      queued,
    );
  }

  s7Sse(): void {
    const es = new EventSource('/api/scenario/sse');
    let count = 0;
    es.addEventListener('activity', (e) => {
      count += 1;
      this.setStatus('s7', `SSE event #${count}: ${(e as MessageEvent).data}`);
      if (count >= 5) es.close();
    });
    es.onerror = () => es.close();
  }

  // ------------------------------------------------------------------------------------------ S8
  installFilters(): void {
    const c = getClient();
    if (!c) return;
    c.setNetworkEventFilter((event) => {
      const headers = event.custom?.headers as Record<string, string> | undefined;
      const hadSecretHeader = headers ? 'x-secret-token' in headers : false;
      let body = (event.custom?.body as string | null | undefined) ?? null;
      const hadSsn = typeof body === 'string' && body.includes('123-45-6789');
      if (hadSsn && body) body = body.replace(/123-45-6789/g, '[REDACTED]');
      const next = {
        ...event,
        custom:
          headers || body !== undefined
            ? {
                ...event.custom,
                headers: headers ? Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'x-secret-token')) : headers,
                body,
              }
            : event.custom,
      };
      this.filterLog.update((prev) => [
        `network: ${event.url} — droppedSecretHeader=${hadSecretHeader} redactedSsn=${hadSsn}`,
        ...prev.slice(0, 9),
      ]);
      if (event.url.includes('veto-me')) {
        this.filterLog.update((prev) => [`network: VETOED ${event.url}`, ...prev.slice(0, 9)]);
        return null;
      }
      return next;
    });
    c.setLogEventFilter((event) => {
      if (event.message.includes('SECRET_TOKEN')) {
        this.filterLog.update((prev) => [`log: redacted "${event.message}"`, ...prev.slice(0, 9)]);
        return { ...event, message: event.message.replace(/SECRET_TOKEN=\S+/, 'SECRET_TOKEN=[REDACTED]') };
      }
      return event;
    });
    c.setBreadcrumbFilter((crumb) => {
      if (crumb.data && 'secret' in crumb.data) {
        this.filterLog.update((prev) => [`breadcrumb: redacted data.secret`, ...prev.slice(0, 9)]);
        return { ...crumb, data: { ...crumb.data, secret: '[REDACTED]' } };
      }
      return crumb;
    });
    c.setReportHandler({
      before: (request) => {
        if (request.report.labels.includes('VETO_REPORT')) {
          this.filterLog.update((prev) => [`report: VETOED ${request.id}`, ...prev.slice(0, 9)]);
          return null;
        }
        if (request.report.labels.includes('MUTATE_ME')) {
          this.filterLog.update((prev) => [`report: mutated ${request.id}`, ...prev.slice(0, 9)]);
          return { ...request, report: { ...request.report, labels: [...request.report.labels, 'redacted-before'] } };
        }
        return request;
      },
    });
    this.filtersInstalled.set(true);
  }

  uninstallFilters(): void {
    const c = getClient();
    c?.setNetworkEventFilter(null);
    c?.setLogEventFilter(null);
    c?.setBreadcrumbFilter(null);
    c?.setReportHandler(null);
    this.filtersInstalled.set(false);
  }

  s8Network(): void {
    void scenarioApi.postSecret();
  }

  s8VetoNetwork(): void {
    void scenarioApi.getVetoTarget();
  }

  s8Log(): void {
    this.client?.log('leaking SECRET_TOKEN=abc123 in a log line', 'info');
  }

  s8Breadcrumb(): void {
    this.client?.addBreadcrumb({ category: 'test', message: 'crumb with secret data', data: { secret: 'sk_live_xyz' } });
  }

  s8ReportMutate(): void {
    void this.client?.logException(new Error('S8: report handler should mutate this'), { labels: ['MUTATE_ME'] });
  }

  s8ReportVeto(): void {
    void this.client?.logException(new Error('S8: report handler should VETO this — must never arrive'), {
      labels: ['VETO_REPORT'],
    });
  }

  // ------------------------------------------------------------------------------------------ S9
  manualTransaction(): void {
    const perf = this.client?.ext('performance');
    if (!perf) return this.setStatus('s9', 'performance ext not registered', false);
    const tx = perf.startTransaction({ name: 'scenario.manual_transaction', operation: 'custom' });
    const statuses: SpanStatus[] = ['OK', 'ERROR', 'TIMEOUT', 'CANCELLED', 'DEADLINE_EXCEEDED', 'UNKNOWN'];
    for (const s of statuses) {
      const span = tx.startChildSpan(`child.${s.toLowerCase()}`, `child span with status ${s}`);
      span.setAttribute('scenario', 's9');
      span.finish(s);
    }
    tx.finish('OK');
    this.setStatus('s9', `started transaction, ${statuses.length} child spans (one per SpanStatus), finished OK`);
  }

  setRouteNameDirect(): void {
    setRouteName('/manual/:demo');
    this.setStatus('s9-route', 'setRouteName("/manual/:demo")');
  }

  /** `performanceSampleRate: 0` — checkable at LOCAL level without a second relaunch pair beyond the
   *  ones the panel already has (S1/S11 relaunch six times between them): relaunch with rate 0, start a
   *  transaction, and read `isSampled()` straight off it — `createRateSampler` (`@bugsee/performance`)
   *  guarantees `rate <= 0` always decides unsampled, no RNG involved. Restores FULL_LAUNCH_OPTIONS
   *  (rate 1) afterward so nothing downstream in the sweep runs unsampled. */
  async performanceSampleRateZero(): Promise<void> {
    await relaunch({ ...FULL_LAUNCH_OPTIONS, performanceSampleRate: 0 });
    const perf = this.client?.ext('performance');
    const tx = perf?.startTransaction({ name: 'scenario.rate_zero', operation: 'custom' });
    const sampled = tx?.isSampled();
    tx?.finish('OK');
    this.setStatus('s9-rate-zero', `relaunched with performanceSampleRate:0, startTransaction().isSampled() -> ${sampled}`, sampled === false);
    await relaunch(FULL_LAUNCH_OPTIONS);
  }

  // ------------------------------------------------------------------------------------------ S10
  /** `propagateTrace`/`tracePropagationTargets: ['/api/']` (FULL_LAUNCH_OPTIONS) — this was previously
   *  N/A ("no two-hop join was attempted"), but the OUTBOUND leg alone is verifiable in-sample: the local
   *  API's `/api/scenario/echo-headers` route (`server/api-server.mjs`) echoes back every header it
   *  received, so a `traceparent` header actually leaving the process is checkable without a second hop. */
  async echoOutboundTraceHeaders(): Promise<void> {
    // The traceparent decorator only stamps a header while a transaction is ACTIVE
    // (`getActiveSpan()`, see `@bugsee/capture`'s `createTraceparentDecorator`) — start one here and
    // hold it open across all three fetches so this check isn't racing the automatic navigation
    // transaction's own idle-finish timing.
    //
    // THREE probes, not one. An earlier revision fired only the same-origin `/api/...` request and
    // claimed it verified `tracePropagationTargets: ['/api/']`. It did not: `createTraceparentDecorator`
    // (`packages/capture/src/traceparent.ts:136-142`) allows ANY same-origin url BEFORE consulting the
    // allowlist, so that probe stays green with `tracePropagationTargets` deleted or set to match
    // nothing — it falsifies `propagateTrace` only. The allowlist governs CROSS-ORIGIN urls, so the
    // two cross-origin probes are what actually exercise it: `include` (cross-origin AND matching
    // `/api/`) must be decorated, `exclude` (cross-origin, no `/api/` in the url) must NOT be.
    const perf = this.client?.ext('performance');
    const tx = perf?.startTransaction({ name: 'scenario.echo_headers', operation: 'custom' });
    let sameOrigin: Record<string, string> = {};
    let crossAllowed: Record<string, string> = {};
    let crossBlocked: Record<string, string> = {};
    let failure: string | undefined;
    try {
      sameOrigin = await scenarioApi.getEchoHeaders();
      crossAllowed = await scenarioApi.getEchoHeadersCrossOriginAllowed();
      crossBlocked = await scenarioApi.getEchoHeadersCrossOriginBlocked();
    } catch (error) {
      // A CORS/preflight failure must surface as a FAILING check, never as a silent "(none)" that
      // would read exactly like a correctly-excluded request.
      failure = String((error as Error)?.message ?? error);
    }
    tx?.finish('OK');
    const w3cTraceparent = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
    const sameOriginTp = sameOrigin['traceparent'];
    const crossAllowedTp = crossAllowed['traceparent'];
    const crossBlockedTp = crossBlocked['traceparent'];
    const isW3c = (v: unknown): boolean => typeof v === 'string' && w3cTraceparent.test(v);
    const ok =
      failure === undefined && isW3c(sameOriginTp) && isW3c(crossAllowedTp) && crossBlockedTp === undefined;
    this.setStatus(
      's10-echo-headers',
      failure !== undefined
        ? `echo-headers probes FAILED to complete: ${failure}`
        : `same-origin /api/scenario/echo-headers -> traceparent: ${sameOriginTp ?? '(none)'}; ` +
          `cross-origin ALLOWLISTED :5336/api/scenario/echo-headers -> traceparent: ${crossAllowedTp ?? '(none)'}; ` +
          `cross-origin NOT-allowlisted :5336/echo-headers-unmatched -> traceparent: ${crossBlockedTp ?? '(none)'}`,
      ok,
    );
  }

  // ------------------------------------------------------------------------------------------ S11
  async replayDefaults(): Promise<void> {
    await relaunch({ ...FULL_LAUNCH_OPTIONS, replay: true });
    this.setStatus('s11', 'relaunched with replay: true (fail-closed defaults: maskAllText/maskAllInputs/blockAllMedia)');
  }

  async replayMasking(): Promise<void> {
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
    this.setStatus('s11', 'relaunched with explicit masking options (maskTextSelector/blockSelector/ignoreSelector/blockAllCanvas)');
  }

  async replayCanvasFixed(): Promise<void> {
    await relaunch({ ...FULL_LAUNCH_OPTIONS, replay: { canvas: { fps: 2 } } });
    this.setStatus('s11', 'relaunched with replay.canvas: { fps: 2 } (fixed-fps canvas recording)');
  }

  async replayCanvasAll(): Promise<void> {
    await relaunch({ ...FULL_LAUNCH_OPTIONS, replay: { canvas: { fps: 'all' } } });
    this.setStatus('s11', "relaunched with replay.canvas: { fps: 'all' } (every draw call, full fidelity)");
  }

  /**
   * The genuine replay OPT-OUT. Session replay is ON BY DEFAULT in the browser tier
   * (`packages/browser/src/launch.ts:433` — `options.replay !== false && domDocument !== undefined`), so
   * `replay: false` is the ONLY way to turn it off, and this control is the only one in the panel whose
   * effect on the uploaded bundle is observable at all: every other S11 configuration produces a
   * `replay.bin`, and so does launching with no `replay` key whatsoever.
   *
   * Until round 7 this method relaunched with plain `FULL_LAUNCH_OPTIONS` and its status line said
   * "replay off" — true only while replay was opt-IN. Under the default it turned nothing off.
   */
  async replayOptOut(): Promise<void> {
    await relaunch({ ...FULL_LAUNCH_OPTIONS, replay: false });
    this.setStatus('s11', 'relaunched with replay: false (the explicit OPT-OUT — replay is on by default)');
  }

  /** Restore the app's own baseline: FULL_LAUNCH_OPTIONS, which carries NO `replay` key — and therefore
   *  records, by default. Runs last in the S11 group so the rest of the sweep sees the app's real
   *  configuration, and doubles as the positive control for the default itself. */
  async replayRestoreBaseline(): Promise<void> {
    await relaunch(FULL_LAUNCH_OPTIONS);
    this.setStatus('s11', 'relaunched with the FULL_LAUNCH_OPTIONS baseline (no replay key — replay records by DEFAULT)');
  }

  // ------------------------------------------------------------------------------------------ S12
  crashAndReload(): void {
    void this.client?.logException(new Error('S12: persist+recover across a hard reload'));
    setTimeout(() => window.location.reload(), 5);
  }

  // ------------------------------------------------------------------- Angular error-seam controls
  callCreateAngularErrorHandler(): void {
    const calls: string[] = [];
    const delegate = { handleError: (e: unknown) => calls.push(`delegate saw: ${String(e instanceof Error ? e.message : e)}`) };
    const handler = createAngularErrorHandler({ delegate, getClient: () => this.client });
    handler.handleError(new Error('Angular: createAngularErrorHandler called directly'));
    this.setStatus('s-create-handler', `createAngularErrorHandler(...).handleError(err) -> ${calls.join('; ')}`);
  }

  callReportAngularErrorDirect(): void {
    reportAngularError(new Error('Angular: reportAngularError called directly'), { getClient: () => this.client });
    this.setStatus('s-report-direct', 'reportAngularError(error, options) called directly');
  }

  callOriginalErrorUnwrap(): void {
    // Simulates Angular's ≤18 ErrorHandler wrapper (`{ ngOriginalError }`) — BugseeErrorHandler must
    // UNWRAP to the real error before reporting it (§5.6 "the originalError unwrap path").
    const real = new Error('Angular: real error inside an ngOriginalError wrapper');
    const wrapped = { ngOriginalError: real, message: 'a generic Angular wrapper message' };
    const handler = new BugseeErrorHandler();
    handler.handleError(wrapped);
    this.setStatus('s-unwrap', `new BugseeErrorHandler().handleError({ngOriginalError: realError}) -> should report "${real.message}"`);
  }

  // ------------------------------------------------------------------- Angular render tracker (see
  // expenses-list.component.ts for the live start()/end() bracketing an ngOnInit->ngAfterViewInit pair;
  // createBugseeRenderTracker itself has no separate "direct call" surface worth repeating here).

  // ------------------------------------------------------------------- Angular router-naming primitives
  routePatternDirect(): void {
    const snapshot: RouteSnapshotLike = {
      routeConfig: { path: 'approvals' },
      firstChild: { routeConfig: { path: ':id' }, firstChild: null },
    };
    const pattern = routePatternFromSnapshot(snapshot);
    this.setStatus('s-route-pattern', `routePatternFromSnapshot({approvals -> :id}) -> "${pattern}"`, pattern === '/approvals/:id');
  }

  setRouteNameFromRouterDirect(): void {
    const fakeRouter: AngularRouterLike = {
      routerState: {
        snapshot: {
          root: { routeConfig: { path: 'expenses' }, firstChild: { routeConfig: { path: 'new' }, firstChild: null } },
        },
      },
    };
    setRouteNameFromRouter(fakeRouter);
    this.setStatus('s-route-router', 'setRouteNameFromRouter(fakeRouter) -> refined active transaction to "/expenses/new"');
  }

  // ------------------------------------------------------------------- error in a component/service/pipe/HttpClient
  armThrowingWidget(): void {
    this.armWidget.set(true);
  }

  resetThrowingWidget(): void {
    this.armWidget.set(false);
  }

  throwFromService(): void {
    this.#throwingService.throwSynchronously();
  }

  throwFromRxjsPipeline(): void {
    // Deliberately no error callback — see throwing.service.ts's doc comment: RxJS's own
    // `reportUnhandledError` path is what surfaces this, not application code.
    this.#throwingService.explodingPipeline().subscribe();
    this.setStatus('s-rxjs', 'subscribed to an exploding pipeline with no error callback');
  }

  throwFromHttpClient(): void {
    // Deliberately no error callback — an HttpClient (XHR-backed) 5xx becomes an Observable error with
    // nowhere to go but RxJS's unhandled-error path, exactly like the RxJS-pipeline control above but
    // via the framework's own HTTP layer.
    this.#http.get('/api/scenario/5xx').subscribe();
    this.setStatus('s-http-throw', 'HttpClient.get("/api/scenario/5xx").subscribe() — no error callback');
  }
}
