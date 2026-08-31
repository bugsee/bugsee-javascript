<script lang="ts">
  // The SDK Scenario panel (docs/samples/PLAN.md §3/§4) — one control per catalog scenario, plus every
  // @bugsee/svelte / @bugsee/svelte-plugin-component-annotate API named in PLAN §5.4's "beyond the
  // catalog" list. Mirrors samples/react-spa's ScenarioPage.tsx structure/ids so the two samples are
  // directly comparable in scripts/verify.mjs and scenarios.md.
  import {
    attemptDuplicateLaunch,
    FULL_LAUNCH_OPTIONS,
    getClient,
    MINIMAL_LAUNCH_OPTIONS,
    onInternalError,
    relaunch,
    reportSvelteErrorDirect,
  } from '../bugsee';
  import { demoRouteIdFromNavigation, demoSetRouteName, navigate } from '../router.svelte';
  import { startSvelteRenderSpan } from '@bugsee/svelte';
  import ThrowingWidget from '../components/ThrowingWidget.svelte';

  let status = $state<Record<string, string>>({});
  let internalErrors = $state<string[]>([]);
  onInternalError((err) => {
    internalErrors = [...internalErrors, String((err as Error)?.message ?? err)];
  });

  function setStatus(id: string, text: string): void {
    status = { ...status, [id]: text };
  }

  // ---------------------------------------------------------------------------------------------- S1
  let isLaunched = $state(getClient()?.isLaunched() ?? false);
  function refreshLaunched(): void {
    isLaunched = getClient()?.isLaunched() ?? false;
  }
  async function s1Flush(): Promise<void> {
    try {
      const drained = await getClient()?.flush(5000);
      setStatus('s1-flush', `flush(5000) -> drained=${drained}`);
    } catch (err) {
      setStatus('s1-flush', `flush(5000) threw: ${String((err as Error)?.message ?? err)}`);
    }
  }
  function s1DuplicateLaunch(): void {
    const { sameInstance } = attemptDuplicateLaunch();
    setStatus('s1-duplicate-launch', `same instance returned: ${sameInstance}`);
  }
  async function s1RelaunchMinimal(): Promise<void> {
    await relaunch(MINIMAL_LAUNCH_OPTIONS);
    refreshLaunched();
    // NOT literally `launch(token, {})`: `relaunch()` (src/bugsee.ts) always injects the wiring this
    // sample cannot run without — `endpoint`, `appId`, `appVersion`, `appBuild`, `onError` — and
    // `doLaunch` adds `carrier`. What "minimal" means here is that MINIMAL_LAUNCH_OPTIONS contributes
    // nothing on top of those: every CAPTURE/BEHAVIOUR option is left at its SDK default.
    setStatus(
      's1-relaunch-minimal',
      'relaunched with no capture/behaviour options — only endpoint/appId/appVersion/appBuild/onError/carrier',
    );
  }
  async function s1RelaunchFull(): Promise<void> {
    await relaunch(FULL_LAUNCH_OPTIONS);
    refreshLaunched();
    setStatus('s1-relaunch-full', 'relaunched with FULL_LAUNCH_OPTIONS');
  }

  // ---------------------------------------------------------------------------------------------- S3
  function s3Log(level: 'error' | 'warning' | 'info' | 'debug' | 'verbose'): void {
    getClient()?.log(`S3: log() at level ${level}`, level);
  }
  function s3EventWithParams(): void {
    getClient()?.event('habit_created', { category: 'health', targetPerWeek: 5 });
  }
  function s3EventNoParams(): void {
    getClient()?.event('scenario_panel_opened');
  }
  function s3Trace(): void {
    getClient()?.trace('habit_streak', 6);
  }
  function s3Breadcrumb(): void {
    getClient()?.addBreadcrumb({
      type: 'user',
      category: 'scenario-panel',
      message: 'S3: addBreadcrumb every field',
      level: 'info',
      data: { control: 's3-breadcrumb' },
    });
  }

  // ---------------------------------------------------------------------------------------------- S4
  function s4Error(): void {
    void getClient()?.logException(new Error('S4: logException(new Error(...))'));
  }
  function s4String(): void {
    void getClient()?.logException('S4: a plain string throwable');
  }
  function s4Object(): void {
    void getClient()?.logException({ code: 'S4_OBJ', message: 'S4: a plain object throwable' });
  }
  function s4Null(): void {
    void getClient()?.logException(null);
  }
  function s4Cause(): void {
    const root = new Error('S4: root cause');
    const wrapped = new Error('S4: wrapped error', { cause: root });
    void getClient()?.logException(wrapped);
  }
  function s4Options(): void {
    void getClient()?.logException(new Error('S4: logException with LogExceptionOptions'), {
      mechanism: 'programmatic',
      severity: 'high',
      labels: ['scenario-panel', 's4-options'],
    });
  }
  const dedupeInstance = new Error('S4: same instance twice — should dedupe');
  function s4Dedupe(): void {
    void getClient()?.logException(dedupeInstance);
    void getClient()?.logException(dedupeInstance);
  }
  function s4Storm(): void {
    for (let i = 0; i < 200; i += 1) {
      void getClient()?.logException(new Error(`S4: storm ${i}`));
    }
  }

  // ---------------------------------------------------------------------------------------------- S5
  function s5Uncaught(): void {
    setTimeout(() => {
      throw new Error('S5: uncaught exception outside any try/catch');
    }, 0);
  }
  function s5Rejection(): void {
    Promise.reject(new Error('S5: unhandled promise rejection'));
  }

  // ---------------------------------------------------------------------------------------------- S6
  function s6Console(method: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace'): void {
    // eslint-disable-next-line no-console
    console[method](`S6: console.${method}`, { control: `s6-${method}` });
  }
  function s6Circular(): void {
    const obj: Record<string, unknown> = { name: 'circular' };
    obj.self = obj;
    // eslint-disable-next-line no-console
    console.log('S6: circular object', obj);
  }

  // ---------------------------------------------------------------------------------------------- S7
  let s7Status = $state('');
  async function s7Get(): Promise<void> {
    const res = await fetch('/api/scenario/get');
    const body = await res.json();
    s7Status = `GET -> ${JSON.stringify(body)}`;
  }
  async function s7PostJson(): Promise<void> {
    const res = await fetch('/api/scenario/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world', n: 42 }),
    });
    const body = await res.json();
    s7Status = `POST JSON -> ${JSON.stringify(body)}`;
  }
  async function s7PostText(): Promise<void> {
    const res = await fetch('/api/scenario/echo-text', { method: 'POST', body: 'plain text body' });
    s7Status = `POST text -> ${await res.text()}`;
  }
  async function s74xx(): Promise<void> {
    const res = await fetch('/api/scenario/4xx');
    s7Status = `4xx -> status ${res.status}`;
  }
  async function s75xx(): Promise<void> {
    const res = await fetch('/api/scenario/5xx');
    s7Status = `5xx -> status ${res.status}`;
  }
  async function s7ConnFail(): Promise<void> {
    try {
      await fetch('http://127.0.0.1:1/definitely-closed');
      s7Status = 'connfail -> unexpectedly succeeded';
    } catch (err) {
      s7Status = `connfail -> caught: ${(err as Error).message}`;
    }
  }
  async function s7LargeBody(): Promise<void> {
    const res = await fetch('/api/scenario/large-body');
    const body = await res.json();
    s7Status = `large-body -> app read ${body.big.length} bytes (full, unaffected by maxNetworkBodySize)`;
  }
  async function s7NoContentType(): Promise<void> {
    const res = await fetch('/api/scenario/no-content-type');
    s7Status = `no-content-type -> ${await res.text()}`;
  }
  async function s7Xhr(): Promise<void> {
    await new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/scenario/get');
      xhr.onload = () => {
        s7Status = `XHR -> ${xhr.responseText}`;
        resolve();
      };
      xhr.send();
    });
  }
  let ws: WebSocket | undefined;
  let wsSends = 0;
  function s7Ws(): void {
    ws?.close();
    // The server greets every new connection with its own `{"type":"welcome",...}` message BEFORE the
    // app sends anything (server/api-server.mjs's `wss.on('connection')`). Reporting the FIRST message
    // that arrives therefore proved only that the socket opened — not that anything round-tripped. Send
    // a per-click nonce and only report the message that carries it back, so the status line is real
    // round-trip evidence (server echo) rather than the greeting.
    const nonce = `s7ws-${(wsSends += 1)}-${Date.now().toString(36)}`;
    const socket = new WebSocket(`ws://${location.host}/api/ws`);
    ws = socket;
    socket.onmessage = (ev) => {
      const text = String(ev.data);
      if (!text.includes(nonce)) return;
      s7Status = `WS echo -> ${text}`;
    };
    socket.onopen = () => socket.send(JSON.stringify({ scenario: 's7-ws', nonce }));
  }
  async function s7Sse(): Promise<void> {
    await new Promise<void>((resolve) => {
      const source = new EventSource('/api/scenario/sse');
      let count = 0;
      source.addEventListener('activity', (ev) => {
        count += 1;
        s7Status = `SSE event #${count} -> ${(ev as MessageEvent).data}`;
        if (count >= 5) {
          source.close();
          resolve();
        }
      });
    });
  }

  // `navigator.sendBeacon` — the one S7 mechanism `@bugsee/capture` intercepts that no sample had ever
  // exercised. Its interceptor patches `navigator.sendBeacon` and emits a `before`/`complete` pair under
  // `mechanism: 'sendBeacon'`, `method: 'POST'` (a beacon is ALWAYS a POST, and it has no response at
  // all — so unlike every other S7 entry there is no `status` and no response body to assert on; the
  // REQUEST body is the only content it can carry).
  //
  // The payload is a fixed distinctive literal rather than a JSON object on purpose: a string payload is
  // sent as `text/plain;charset=UTF-8`, which is what the interceptor's own sync body reader handles, and
  // the literal doubles as the needle verify.mjs looks for inside the uploaded `network.json` — so the
  // wire check asserts THIS control's payload, not merely "some beacon entry exists".
  const S7_BEACON_TAG = 's7-beacon';
  const S7_BEACON_PAYLOAD = 'S7-BEACON-PAYLOAD-MARKER';
  async function s7Beacon(): Promise<void> {
    const queued = navigator.sendBeacon(
      `/api/scenario/beacon?tag=${S7_BEACON_TAG}`,
      S7_BEACON_PAYLOAD,
    );
    // `queued` is only "the user agent accepted this for delivery" — it is NOT delivery, and it is true
    // even if the request never leaves. Read the payload back off the server so the status line is real
    // round-trip evidence (same reasoning as the s7-ws nonce). Polled, because a beacon is dispatched
    // out-of-band and may not have landed by the time this line runs.
    type BeaconLog = { tag?: string | null; body?: string } | null;
    let received: BeaconLog = null;
    for (let attempt = 0; attempt < 25 && received === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const res = await fetch('/api/scenario/beacon-log');
      received = ((await res.json()) as { last: BeaconLog }).last;
    }
    s7Status = `sendBeacon -> queued=${queued}; server received tag=${received?.tag ?? 'none'} body=${received?.body ?? 'none'}`;
  }

  // ------------------------------------------------------- Wire-depth capture probe (S3 / S6 / S7)
  // `log()`, `console.*`, XHR and WebSocket capture have NO per-call wire signal of their own: nothing
  // leaves the process when they happen. They accumulate in the local capture ring and only reach the
  // wire inside the next REPORT's uploaded bundle (`logs.json` / `network.json`). Without this control
  // the only obtainable assertion for them was "the click didn't throw", which is why scenarios.md used
  // to mark them W on the strength of a local check. This fires one report with a distinctive summary
  // so verify.mjs can unzip exactly that bundle and assert the ring's real contents.
  const CAPTURE_PROBE_SUMMARY = 'WIRE: capture probe (log/console/xhr/ws ring contents)';
  function captureWireProbe(): void {
    void getClient()?.logException(new Error(CAPTURE_PROBE_SUMMARY));
  }

  // ---------------------------------------------------------------------------------------------- S8
  let filtersInstalled = $state(false);
  let filterLog = $state<string[]>([]);
  function s8Install(): void {
    const client = getClient();
    if (!client) return;
    client.setNetworkEventFilter((event) => {
      if (event.url.includes('veto-me')) {
        filterLog = [...filterLog, `network: VETOED ${event.url}`];
        return null;
      }
      const headers = { ...event.custom?.headers };
      const droppedSecretHeader = 'x-secret' in headers;
      delete headers['x-secret'];
      const originalBody = event.custom?.body;
      const body =
        typeof originalBody === 'string' ? originalBody.replace(/"ssn":"[^"]*"/, '"ssn":"[REDACTED]"') : originalBody;
      const redactedSsn = body !== originalBody;
      if (droppedSecretHeader || redactedSsn) {
        filterLog = [...filterLog, `network: droppedSecretHeader=${droppedSecretHeader} redactedSsn=${redactedSsn}`];
      }
      return { ...event, custom: { ...event.custom, headers, body } };
    });
    client.setLogEventFilter((event) => {
      if (event.message.includes('SECRET_TOKEN')) {
        filterLog = [...filterLog, `log: redacted "${event.message}"`];
        return { ...event, message: event.message.replace(/SECRET_TOKEN=\S+/, 'SECRET_TOKEN=[REDACTED]') };
      }
      return event;
    });
    client.setBreadcrumbFilter((crumb) => {
      if (crumb.data && 'secret' in crumb.data) {
        filterLog = [...filterLog, 'breadcrumb: redacted data.secret'];
        return { ...crumb, data: { ...crumb.data, secret: '[REDACTED]' } };
      }
      return crumb;
    });
    client.setReportHandler({
      before: (request) => {
        if (request.report.summary?.includes('VETO')) {
          filterLog = [...filterLog, 'report: VETOED'];
          return null;
        }
        filterLog = [...filterLog, 'report: mutated (added label)'];
        return {
          ...request,
          report: { ...request.report, labels: [...request.report.labels, 'redacted-before'] },
        };
      },
    });
    filtersInstalled = true;
  }
  function s8Uninstall(): void {
    const client = getClient();
    client?.setNetworkEventFilter(null);
    client?.setLogEventFilter(null);
    client?.setBreadcrumbFilter(null);
    client?.setReportHandler(null);
    filtersInstalled = false;
  }
  async function s8Network(): Promise<void> {
    // Exercises BOTH redaction limbs the s8Install filter checks for: a secret HEADER (dropped) and a
    // secret BODY FIELD (regex-redacted). Previously this only sent a bodyless GET, so `redactedSsn` was
    // always false — the body-redaction limb never actually ran.
    await fetch('/api/scenario/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-secret': 'abc' },
      body: JSON.stringify({ ssn: '123-45-6789', note: 'S8: network redact scenario' }),
    });
  }
  async function s8VetoNetwork(): Promise<void> {
    await fetch('/api/scenario/get?veto-me=1');
  }
  function s8Log(): void {
    getClient()?.log('leaking SECRET_TOKEN=abc123 in a log line', 'info');
  }
  function s8Breadcrumb(): void {
    getClient()?.addBreadcrumb({ type: 'custom', category: 's8', message: 'has a secret', data: { secret: 'topsecret' } });
  }
  function s8ReportMutate(): void {
    void getClient()?.logException(new Error('S8: report handler should mutate this'));
  }
  function s8ReportVeto(): void {
    void getClient()?.logException(new Error('S8: report handler should VETO this'));
  }

  // ---------------------------------------------------------------------------------------------- S9
  function s9ManualTransaction(): void {
    const perf = getClient()?.ext('performance');
    if (!perf) return;
    const txn = perf.startTransaction({ name: 'scenario.manual', operation: 'test' });
    const statuses: Array<'OK' | 'ERROR' | 'TIMEOUT' | 'CANCELLED' | 'DEADLINE_EXCEEDED' | 'UNKNOWN'> = [
      'OK',
      'ERROR',
      'TIMEOUT',
      'CANCELLED',
      'DEADLINE_EXCEEDED',
      'UNKNOWN',
    ];
    for (const status of statuses) {
      const child = txn.startChildSpan('scenario.child', status);
      child.finish(status);
    }
    txn.finish('OK');
    setStatus('s9-manual-transaction', 'manual transaction + 6 child spans (every SpanStatus) finished OK');
  }
  function s9SetRouteName(): void {
    demoSetRouteName('/scenarios');
    setStatus('s9-set-route-name', 'setRouteName(\'/scenarios\') called directly');
  }

  // `performanceSampleRate` 0 vs 1 — a two-relaunch check (previously marked N/A "out of scope", with no
  // stated reason). A transaction started while sampleRate is 0 is head-sampled OUT and never reaches the
  // continuous /v2/performance/transactions upload; the SAME manual-transaction call after relaunching at
  // sampleRate 1 does reach it — verify.mjs asserts both halves via its wire-level `perfTransactions` tap.
  async function s9RelaunchSampleRateZero(): Promise<void> {
    await relaunch({ ...FULL_LAUNCH_OPTIONS, performanceSampleRate: 0 });
    setStatus('s9-relaunch-rate-0', 'relaunched with performanceSampleRate: 0');
  }
  async function s9RelaunchSampleRateOne(): Promise<void> {
    await relaunch({ ...FULL_LAUNCH_OPTIONS, performanceSampleRate: 1 });
    setStatus('s9-relaunch-rate-1', 'relaunched with performanceSampleRate: 1 (restored)');
  }

  // ---------------------------------------------------------------------------------------------- S10
  // Outbound trace-propagation check: `propagateTrace`/`tracePropagationTargets: ['/api/']` are set in
  // FULL_LAUNCH_OPTIONS, so a fetch to a same-origin `/api/` URL should carry a `traceparent`/`tracestate`
  // header. The local API's `/api/scenario/echo-headers` (built for exactly this, but never called before
  // this fix) echoes back whatever headers it received, letting the app confirm what actually left the
  // process without needing a second sample as a two-hop counterpart (only the trace_id JOIN needs that).
  let s10Status = $state('');
  async function s10TracePropagation(): Promise<void> {
    // The traceparent decorator only injects a header while a transaction is ACTIVE (single-slot model,
    // `ext('performance').getActiveSpan()`) — a bare fetch with nothing else running has no active span
    // to propagate. A manual transaction wrapping the fetch guarantees one, the same way a real
    // navigation/interaction transaction would while its own network calls are in flight.
    const perf = getClient()?.ext('performance');
    const txn = perf?.startTransaction({ name: 'scenario.s10-propagation', operation: 'test' });
    const res = await fetch('/api/scenario/echo-headers');
    const headers = await res.json();
    txn?.finish('OK');
    s10Status = JSON.stringify({ traceparent: headers.traceparent, tracestate: headers.tracestate });
  }

  // The EXCLUDE half of the same allow-list, which nothing exercised before: `tracePropagationTargets:
  // ['/api/']` matches every fetch this app makes, so a build that ignored the allow-list entirely
  // passed the include check above identically. The only non-matching target the sample had was
  // `http://127.0.0.1:1/definitely-closed`, which never connects — so no header is ever observable
  // there and it proves nothing.
  //
  // This one connects: it goes CROSS-ORIGIN and straight to the API server's own origin (:5334, not
  // through Vite's `/api` proxy) on a path with no `/api/` in it, so the allow-list must NOT match it,
  // and the server echoes back exactly what it received. The `Boolean(...)` shape of the status line is
  // deliberate — `s10ExcludeStatus` reports whether the headers ARRIVED, and the check asserts they did
  // not, alongside `echoed` proving the request really completed (otherwise "no traceparent" would also
  // be true of a request that failed outright).
  let s10ExcludeStatus = $state('');
  async function s10TracePropagationExcluded(): Promise<void> {
    const perf = getClient()?.ext('performance');
    const txn = perf?.startTransaction({ name: 'scenario.s10-propagation-excluded', operation: 'test' });
    try {
      const res = await fetch('http://localhost:5334/trace-exclude-probe');
      const headers = await res.json();
      s10ExcludeStatus = JSON.stringify({
        echoed: typeof headers.host === 'string',
        traceparent: headers.traceparent ?? null,
        tracestate: headers.tracestate ?? null,
      });
    } catch (error) {
      s10ExcludeStatus = JSON.stringify({ echoed: false, error: String(error) });
    } finally {
      txn?.finish('OK');
    }
  }

  // ---------------------------------------------------------------------------------------- S11 replay
  // `replay: true` is REDUNDANT now that recording is the default (see the option-path note further
  // down) — it selects the fail-closed masking defaults that would apply anyway. Kept as a control
  // because "the explicit form is still accepted and does not throw" is worth one row; it is NOT what
  // turns recording on, and nothing in this file may claim it is.
  async function s11ReplayDefaults(): Promise<void> {
    await relaunch({ ...FULL_LAUNCH_OPTIONS, replay: true });
    setStatus('s11-replay-defaults', 'relaunched with an explicit replay: true (same as the default)');
  }
  async function s11ReplayMasking(): Promise<void> {
    await relaunch({
      ...FULL_LAUNCH_OPTIONS,
      replay: {
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
        blockAllCanvas: true,
      },
    });
    setStatus('s11-replay-masking', 'relaunched with explicit masking options');
  }
  // The selector-driven masking config (PLAN §4 S11 names `maskTextSelector` / `blockSelector` /
  // `ignoreSelector`; nothing in this sample exercised any of the three before this round). This is the
  // session verify.mjs records the Settings drawer under, then unzips at WIRE depth.
  //
  // `maskAllText: false` is deliberate and load-bearing. With it ON, every text node is masked anyway, so
  // "the maskTextSelector target's text is absent from the recording" and "the blockSelector target's
  // text is absent" would BOTH be true no matter what those two selectors did — the check would be
  // vacuous, and so would any positive control. Turning it off makes the page's text recordable and the
  // three selectors the only reason anything is missing, which is what makes the wire assertion able to
  // fail. `maskAllInputs` stays ON (the fail-closed default) so the input side keeps its floor.
  async function s11ReplaySelectors(): Promise<void> {
    await relaunch({
      ...FULL_LAUNCH_OPTIONS,
      replay: {
        maskAllText: false,
        maskAllInputs: true,
        blockAllMedia: true,
        maskTextSelector: '.s11-mask-target',
        blockSelector: '.s11-block-target',
        ignoreSelector: '.s11-ignore-target',
      },
    });
    setStatus('s11-replay-selectors', 'relaunched with maskTextSelector/blockSelector/ignoreSelector');
  }
  // Fires ONE report whose bundle carries the replay ring exactly as it stands — the same trick the S3/S6/S7
  // capture probe uses, for the same reason: a replay recording has no wire signal of its own, it only
  // reaches the wire inside the next report's `replay.bin`.
  const REPLAY_PROBE_SUMMARY = 'WIRE: replay probe (masked drawer recording)';
  function s11ReplayWireProbe(): void {
    void getClient()?.logException(new Error(REPLAY_PROBE_SUMMARY));
  }
  async function s11ReplayCanvasFixed(): Promise<void> {
    await relaunch({ ...FULL_LAUNCH_OPTIONS, replay: { canvas: { fps: 2 } } });
    setStatus('s11-replay-canvas-fixed', "relaunched with replay.canvas: { fps: 2 }");
  }
  async function s11ReplayCanvasAll(): Promise<void> {
    await relaunch({ ...FULL_LAUNCH_OPTIONS, replay: { canvas: { fps: 'all' } } });
    setStatus('s11-replay-canvas-all', "relaunched with replay.canvas: { fps: 'all' }");
  }
  // ---- The replay OPTION PATH, which is now only observable through its OFF setting.
  //
  // Session replay is ON BY DEFAULT (`packages/browser/src/launch.ts`:
  // `options.replay !== false && domDocument !== undefined`) — the product decision is that video is the
  // headline feature and both mobile SDKs record by default. That flip makes every "replay: <something>"
  // control in this panel produce a recording whether or not its option was read at all: `replay.bin`
  // being present in an uploaded bundle stopped being evidence that the SDK consulted the option the
  // moment the default became "record". `replay: false` is the ONLY replay configuration whose effect is
  // still observable, so it is the only control that can prove the option path exists.
  //
  // Both halves are here deliberately, and each fires its OWN distinctly-summarised report so verify.mjs
  // can unzip exactly that bundle:
  //   * default-on  — relaunch with the `replay` key REMOVED entirely, not set to `true`. Its bundle must
  //                   still carry a `replay.bin`. This is the check that would go red if the default ever
  //                   flipped back, and `replay: true` cannot make it (an explicit `true` is green under
  //                   either default).
  //   * opt-out     — relaunch with `replay: false`. Its bundle must carry NO `replay.bin` at all.
  // Together they are a discriminating pair: an SDK that ignored the option entirely passes exactly one
  // of them, never both.
  const REPLAY_DEFAULT_PROBE_SUMMARY = 'WIRE: replay default probe (no replay option at all)';
  const REPLAY_OFF_PROBE_SUMMARY = 'WIRE: replay opt-out probe (replay: false)';
  /**
   * Relaunch, let the recorder settle, then fire one report carrying the replay ring as it stands.
   *
   * The settle is not padding. `@bugsee/replay` is lazy-loaded (a dynamic `import()` inside its
   * registration) and rrweb's FullSnapshot is taken after that resolves, so a report fired the instant
   * `relaunch()` returns can beat the snapshot into the ring and produce an EMPTY `replay.bin` — which
   * would fail the default-on probe for a timing reason that says nothing about the option.
   */
  async function replayProbeAfter(summary: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await getClient()?.logException(new Error(summary));
  }
  async function s11ReplayDefaultOn(): Promise<void> {
    // Destructured OUT rather than set to `undefined`: `{ replay: undefined }` and "no `replay` key" are
    // the same thing to the resolver today, but only the first would silently start passing if the option
    // ever grew a distinct `undefined` meaning. This asserts the genuine no-option case.
    const { replay: _omitted, ...withoutReplayOption } = FULL_LAUNCH_OPTIONS;
    await relaunch(withoutReplayOption);
    setStatus('s11-replay-default-on', 'relaunched with NO replay option at all');
    await replayProbeAfter(REPLAY_DEFAULT_PROBE_SUMMARY);
  }
  async function s11ReplayOff(): Promise<void> {
    await relaunch({ ...FULL_LAUNCH_OPTIONS, replay: false });
    setStatus('s11-replay-off', 'relaunched with replay: false (opt-out)');
    await replayProbeAfter(REPLAY_OFF_PROBE_SUMMARY);
  }
  async function s11Restore(): Promise<void> {
    await relaunch(FULL_LAUNCH_OPTIONS);
    refreshLaunched();
    setStatus('s11-replay-restore', 'relaunched back to FULL_LAUNCH_OPTIONS baseline');
  }

  // ---------------------------------------------------------------------------------------------- S12
  function s12CrashAndReload(): void {
    void getClient()?.logException(new Error('S12: persist+recover across a hard reload'));
    // 250ms, not 50ms. The delay has to be long enough for the incident's marker + capture chunks to be
    // WRITTEN to IndexedDB before the document is torn down, and short enough that the bundle is not
    // uploaded before the reload (which would make it a plain upload, not a recovery). 50ms cleared that
    // bar on every run measured here, but only barely: the peer sample measured the lower edge of the
    // window at 5ms -> 1 upload, 40ms -> 2, 250ms -> 2, so 50ms sits ~10ms above the edge and one slow
    // IDB write would flip `s12-persist-recover`'s `=== 2` to 1 and read as an SDK regression rather than
    // the timing artifact it would actually be. 250ms is inside the same measured plateau with real
    // margin underneath it.
    setTimeout(() => location.reload(), 250);
  }

  // ---------------------------------------------------------------------------- Svelte-specific (§5.4)
  let boundaryArmed = $state(false);
  function armBoundary(): void {
    boundaryArmed = true;
  }
  function disarmBoundary(): void {
    boundaryArmed = false;
  }

  // The GLOBAL (unguarded) throw: this component is rendered with NO nested `<svelte:boundary>` of its
  // own, so a render throw propagates to the nearest ANCESTOR boundary — App.svelte's outer one wrapping
  // the whole route outlet — exercising `handleAppError` (handleErrorWithBugsee) at the app level. Unlike
  // react-spa's F-5 (react-router's own per-route boundary intercepts first, so its app-level
  // BugseeErrorBoundary is never reached), Svelte has no framework-injected competing boundary here, so
  // this is expected to reach App.svelte's boundary and show its `error-fallback` — a genuine (not a
  // documented gap) exercise of the seam.
  let globalArmed = $state(false);

  function svelteReportErrorDirect(): void {
    reportSvelteErrorDirect(new Error('Svelte: reportSvelteError called directly'), '/scenarios');
    setStatus('svelte-report-error', 'reportSvelteError(error, { routeId }) called directly');
  }

  // `startSvelteRenderSpan(name)()` records a `ui.render` child span on the ACTIVE transaction, and is a
  // documented NO-OP when none is active (packages/web-adapter/src/render-span.ts:38 returns early on
  // `getActiveSpan() === undefined`). Clicking this control in isolation therefore used to produce
  // nothing at all on the wire while the status line still announced "recorded a ui.render mount span" —
  // a literal the panel set unconditionally, so any check reading it asserted the sample's own prose,
  // not the SDK. Two fixes: start a transaction so the span has somewhere real to land (exactly the
  // situation the preprocessor's auto-injected `onMount` call is in during a navigation), and report
  // what was actually OBSERVED (whether a transaction was live when `stop()` ran), never a fixed string.
  // verify.mjs then asserts the span itself on the wire (`svelte-render-span-wire`), by its own name.
  const MANUAL_RENDER_SPAN_NAME = 'ManualScenarioSpan';
  function svelteManualRenderSpan(): void {
    const perf = getClient()?.ext('performance');
    const txn = perf?.startTransaction({ name: 'scenario.manual-render-span', operation: 'test' });
    const stop = startSvelteRenderSpan(MANUAL_RENDER_SPAN_NAME);
    setTimeout(() => {
      // IDENTITY, not mere presence. "Is anything active?" is not enough: a click of this very button
      // starts an interaction transaction, so `getActiveSpan() !== undefined` reads true even with no
      // transaction of our own — measured, by deleting the `startTransaction` call above and watching
      // that weaker form stay green while the span reached the wire 0 times. What has to hold is that
      // the span lands on THE transaction this control started.
      const landedOnOwnTransaction = txn !== undefined && perf?.getActiveSpan() === txn;
      stop();
      txn?.finish('OK');
      setStatus(
        'svelte-render-span',
        `startSvelteRenderSpan('${MANUAL_RENDER_SPAN_NAME}') stop() ran; recorded onto the transaction this control started: ${landedOnOwnTransaction}`,
      );
    }, 60);
  }

  // The RETURNED value, kept on its own status line. The descriptive line below echoes the ARGUMENT for
  // a human reader; a check must never assert against that echo — the expected route id appears inside
  // the input, so `undefined`/`null`/`''` all still "contain" it and the assertion cannot fail.
  let routeIdResult = $state('(not called)');
  function svelteRouteIdFromNavigation(): void {
    const id = demoRouteIdFromNavigation();
    routeIdResult = id === undefined ? '(undefined)' : id;
    setStatus(
      'svelte-route-id-from-navigation',
      "called routeIdFromNavigation({to:{route:{id:'/habits/[id]'}}})",
    );
  }

  // `$derived(document.querySelectorAll(...))` is NOT reactive to real DOM changes (a DOM query is not a
  // rune dependency) — it only ever evaluated ONCE, at component init, BEFORE this component's own markup
  // had even mounted, so a cold `#/scenarios` load measured the PREVIOUS page's annotation count (often 0)
  // rather than this page's. An `$effect` that runs after mount + a MutationObserver that keeps it live
  // makes the count both correct-at-mount and reactive to any subsequent annotation/DOM change.
  let annotatedCount = $state(0);
  $effect(() => {
    if (typeof document === 'undefined') return;
    const recompute = (): void => {
      annotatedCount = document.querySelectorAll('[data-bugsee-component]').length;
    };
    recompute();
    const observer = new MutationObserver(recompute);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-bugsee-component'],
    });
    return () => observer.disconnect();
  });
</script>

<h2>Scenario panel</h2>
<p class="status-line">
  Every control below maps to a scenario id in <code>docs/samples/PLAN.md</code> §4/§5.4 — see
  <code>scenarios.md</code> for the full table. isLaunched(): <span data-testid="is-launched">{isLaunched}</span>
</p>

{#if internalErrors.length > 0}
  <div class="card" data-testid="internal-errors">
    <h3>onError sink</h3>
    {#each internalErrors as err}<p class="status-line">{err}</p>{/each}
  </div>
{/if}

<div class="scenario-section">
  <h3>S1 — Launch &amp; lifecycle</h3>
  <div class="row">
    <button data-testid="s1-flush" onclick={s1Flush}>Flush</button>
    <button data-testid="s1-duplicate-launch" onclick={s1DuplicateLaunch}>Call launch() again</button>
    <button data-testid="s1-relaunch-minimal" onclick={s1RelaunchMinimal}>Relaunch minimal</button>
    <button data-testid="s1-relaunch-full" onclick={s1RelaunchFull}>Relaunch full</button>
  </div>
  <p class="status-line" data-testid="s1-flush-status">{status['s1-flush'] ?? ''}</p>
  <p class="status-line" data-testid="s1-duplicate-launch-status">{status['s1-duplicate-launch'] ?? ''}</p>
</div>

<div class="scenario-section">
  <h3>S3 — Manual telemetry</h3>
  <div class="row">
    {#each ['error', 'warning', 'info', 'debug', 'verbose'] as level}
      <button data-testid={`s3-log-${level}`} onclick={() => s3Log(level as never)}>log({level})</button>
    {/each}
    <button data-testid="s3-event-params" onclick={s3EventWithParams}>event(params)</button>
    <button data-testid="s3-event-no-params" onclick={s3EventNoParams}>event()</button>
    <button data-testid="s3-trace" onclick={s3Trace}>trace()</button>
    <button data-testid="s3-breadcrumb" onclick={s3Breadcrumb}>addBreadcrumb()</button>
  </div>
</div>

<div class="scenario-section">
  <h3>S4 — Exceptions</h3>
  <div class="row">
    <button data-testid="s4-error" onclick={s4Error}>Error</button>
    <button data-testid="s4-string" onclick={s4String}>string</button>
    <button data-testid="s4-object" onclick={s4Object}>object</button>
    <button data-testid="s4-null" onclick={s4Null}>null</button>
    <button data-testid="s4-cause" onclick={s4Cause}>cause chain</button>
    <button data-testid="s4-options" onclick={s4Options}>LogExceptionOptions</button>
    <button data-testid="s4-dedupe" onclick={s4Dedupe}>same instance x2</button>
    <button data-testid="s4-storm" onclick={s4Storm}>storm x200</button>
  </div>
</div>

<div class="scenario-section">
  <h3>S5 — Crashes</h3>
  <div class="row">
    <button data-testid="s5-uncaught" onclick={s5Uncaught}>uncaught exception</button>
    <button data-testid="s5-rejection" onclick={s5Rejection}>unhandled rejection</button>
  </div>
</div>

<div class="scenario-section">
  <h3>S6 — Console capture</h3>
  <div class="row">
    {#each ['log', 'info', 'warn', 'error', 'debug', 'trace'] as m}
      <button data-testid={`s6-${m}`} onclick={() => s6Console(m as never)}>console.{m}</button>
    {/each}
    <button data-testid="s6-circular" onclick={s6Circular}>circular object</button>
  </div>
</div>

<div class="scenario-section">
  <h3>S7 — Network capture</h3>
  <div class="row">
    <button data-testid="s7-get" onclick={s7Get}>GET</button>
    <button data-testid="s7-post-json" onclick={s7PostJson}>POST JSON</button>
    <button data-testid="s7-post-text" onclick={s7PostText}>POST text</button>
    <button data-testid="s7-4xx" onclick={s74xx}>4xx</button>
    <button data-testid="s7-5xx" onclick={s75xx}>5xx</button>
    <button data-testid="s7-connfail" onclick={s7ConnFail}>connection failure</button>
    <button data-testid="s7-large-body" onclick={s7LargeBody}>large body</button>
    <button data-testid="s7-no-content-type" onclick={s7NoContentType}>no content-type</button>
    <button data-testid="s7-xhr" onclick={s7Xhr}>XHR</button>
    <button data-testid="s7-ws" onclick={s7Ws}>WebSocket</button>
    <button data-testid="s7-sse" onclick={s7Sse}>SSE</button>
    <button data-testid="s7-beacon" onclick={s7Beacon}>sendBeacon</button>
  </div>
  <p class="status-line" data-testid="s7-status">{s7Status}</p>
</div>

<div class="scenario-section">
  <h3>Wire-depth capture probe (S3 / S6 / S7)</h3>
  <p class="status-line">
    Fires one report whose bundle carries the capture ring as it stands right now — the only way
    <code>log()</code>, <code>console.*</code>, XHR and WebSocket capture reach the wire at all.
  </p>
  <div class="row">
    <button data-testid="capture-wire-probe" onclick={captureWireProbe}>Report the ring (wire probe)</button>
  </div>
</div>

<div class="scenario-section">
  <h3>S8 — Filters &amp; redaction</h3>
  <div class="row">
    <button data-testid="s8-install" onclick={s8Install}>install filters</button>
    <button data-testid="s8-uninstall" onclick={s8Uninstall}>uninstall filters</button>
    <button data-testid="s8-network" onclick={s8Network} disabled={!filtersInstalled}>network (redact)</button>
    <button data-testid="s8-veto-network" onclick={s8VetoNetwork} disabled={!filtersInstalled}>network (veto)</button>
    <button data-testid="s8-log" onclick={s8Log} disabled={!filtersInstalled}>log (redact)</button>
    <button data-testid="s8-breadcrumb" onclick={s8Breadcrumb} disabled={!filtersInstalled}>breadcrumb (redact)</button>
    <button data-testid="s8-report-mutate" onclick={s8ReportMutate} disabled={!filtersInstalled}>report (mutate)</button>
    <button data-testid="s8-report-veto" onclick={s8ReportVeto} disabled={!filtersInstalled}>report (veto)</button>
  </div>
  <p class="status-line" data-testid="filter-log">{filterLog.join(' | ')}</p>
</div>

<div class="scenario-section">
  <h3>S9 — Performance / APM</h3>
  <div class="row">
    <button data-testid="s9-manual-transaction" onclick={s9ManualTransaction}>manual transaction + spans</button>
    <button data-testid="s9-set-route-name" onclick={s9SetRouteName}>setRouteName</button>
    <button data-testid="s9-relaunch-rate-0" onclick={s9RelaunchSampleRateZero}>relaunch performanceSampleRate:0</button>
    <button data-testid="s9-relaunch-rate-1" onclick={s9RelaunchSampleRateOne}>relaunch performanceSampleRate:1</button>
  </div>
</div>

<div class="scenario-section">
  <h3>S10 — Distributed tracing (outbound propagation only)</h3>
  <div class="row">
    <button data-testid="s10-propagation" onclick={s10TracePropagation}>fetch /api/scenario/echo-headers</button>
    <button data-testid="s10-propagation-excluded" onclick={s10TracePropagationExcluded}>
      fetch cross-origin /trace-exclude-probe (must NOT be propagated)
    </button>
  </div>
  <p class="status-line" data-testid="s10-status">{s10Status}</p>
  <p class="status-line" data-testid="s10-exclude-status">{s10ExcludeStatus}</p>
</div>

<div class="scenario-section">
  <h3>S11 — Session replay</h3>
  <div class="row">
    <button data-testid="s11-replay-defaults" onclick={s11ReplayDefaults}>replay: true (defaults)</button>
    <button data-testid="s11-replay-masking" onclick={s11ReplayMasking}>explicit masking</button>
    <button data-testid="s11-replay-selectors" onclick={s11ReplaySelectors}>
      mask/block/ignore selectors
    </button>
    <button data-testid="s11-replay-wire-probe" onclick={s11ReplayWireProbe}>replay wire probe</button>
    <button data-testid="s11-replay-canvas-fixed" onclick={s11ReplayCanvasFixed}>canvas fps:2</button>
    <button data-testid="s11-replay-canvas-all" onclick={s11ReplayCanvasAll}>canvas fps:'all'</button>
    <button data-testid="s11-replay-default-on" onclick={s11ReplayDefaultOn}>no replay option (default ON)</button>
    <button data-testid="s11-replay-off" onclick={s11ReplayOff}>replay: false (opt out)</button>
    <button data-testid="s11-replay-restore" onclick={s11Restore}>restore baseline</button>
  </div>
  <p class="status-line">masking-target fields live on the Settings page's drawer (S11).</p>
</div>

<div class="scenario-section">
  <h3>S12 — Persistence &amp; recovery</h3>
  <div class="row">
    <button data-testid="s12-crash-and-reload" onclick={s12CrashAndReload}>logException then hard-reload</button>
  </div>
</div>

<div class="scenario-section">
  <h3>@bugsee/svelte — beyond the catalog</h3>
  <div class="row">
    <button data-testid="svelte-report-error" onclick={svelteReportErrorDirect}>reportSvelteError (direct)</button>
    <button data-testid="svelte-render-span" onclick={svelteManualRenderSpan}>startSvelteRenderSpan (direct)</button>
    <button data-testid="svelte-route-id-from-navigation" onclick={svelteRouteIdFromNavigation}>
      routeIdFromNavigation (direct)
    </button>
    <button data-testid="svelte-navigate-habits" onclick={() => navigate('/habits')}>
      navigate('/habits') — exercises instrumentSvelteKitNavigation
    </button>
  </div>
  <p class="status-line">{status['svelte-report-error'] ?? ''}</p>
  <p class="status-line" data-testid="svelte-render-span-status">{status['svelte-render-span'] ?? ''}</p>
  <p class="status-line" data-testid="svelte-route-id-status">{status['svelte-route-id-from-navigation'] ?? ''}</p>
  <!-- The RETURNED value on its own, with nothing else in it — so a check asserting on it is asserting
       on `routeIdFromNavigation`'s output, not on an echo of the argument it was handed. -->
  <p class="status-line" data-testid="svelte-route-id-result">{routeIdResult}</p>
  <p class="status-line" data-testid="component-annotate-count">
    data-bugsee-component elements currently in the DOM: {annotatedCount}
  </p>

  <h4>Local boundary (handleErrorWithBugsee via a NESTED &lt;svelte:boundary&gt;)</h4>
  <div class="row">
    <button data-testid="arm-boundary" onclick={armBoundary}>Arm ThrowingWidget</button>
    <button data-testid="disarm-boundary" onclick={disarmBoundary}>Disarm</button>
  </div>
  <svelte:boundary onerror={(err) => reportSvelteErrorDirect(err, '/scenarios')}>
    <ThrowingWidget armed={boundaryArmed} scenario="local" />
    {#snippet failed(error, reset)}
      <div class="card" data-testid="guarded-widget-fallback">
        <p>Guarded fallback: {(error as Error)?.message ?? String(error)}</p>
        <button onclick={reset}>Reset</button>
      </div>
    {/snippet}
  </svelte:boundary>

  <h4>Global (app-level) boundary — no nested boundary here, propagates to App.svelte's</h4>
  <div class="row">
    <button data-testid="arm-global" onclick={() => (globalArmed = true)}>Arm global throw</button>
    <button data-testid="disarm-global" onclick={() => (globalArmed = false)}>Disarm</button>
  </div>
  {#if globalArmed}
    <ThrowingWidget armed={true} scenario="global" />
  {/if}
</div>
