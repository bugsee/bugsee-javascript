<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import ErrorLab from '../components/ErrorLab.vue';
import { attemptRelaunch, getBugsee, RUN_ID, SAMPLE_USER_ID } from '../bugsee';
import { marker } from '../lib/marker';

// The Scenario panel (docs/samples/PLAN.md §3/§4/§6): one control per scenario in the catalog, plus the
// vue-specific ones (ErrorLab.vue). Every trigger stamps `marker(scenarioId)` into whatever field is
// searchable on the resulting issue (a label, a log line, a breadcrumb) so a specific run's result can
// be told apart from a previous one when polling the backend. `data-testid` attributes let
// scripts/verify.mts (Playwright) drive the whole sweep headlessly.

defineOptions({ name: 'Scenarios' });

const log = reactive<string[]>([]);
function note(msg: string): void {
  log.unshift(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  if (log.length > 60) log.length = 60;
}

// Minimal structural type for ext('performance') — avoids a devDependency on @bugsee/performance just
// for the ambient NameExtensionMapping augmentation (the runtime object is real; this is a type only).
interface PerfSpan {
  setAttribute(key: string, value: unknown): PerfSpan;
  setStatus(status: string): PerfSpan;
  startChildSpan(operation: string, description?: string): PerfSpan;
  finish(status?: string): void;
}
interface PerfApi {
  startTransaction(opts: { name: string; operation: string; description?: string }): PerfSpan;
  setRouteName(name: string): void;
}
function perf(): PerfApi {
  return (getBugsee() as unknown as { ext(name: string): PerfApi }).ext('performance');
}

onMounted(() => note(`Scenario panel ready — RUN_ID=${RUN_ID}`));

// ---------- S1 Launch & lifecycle ----------
function s1Relaunch(): void {
  attemptRelaunch();
  note(`S1: attempted a second launch() — isLaunched=${getBugsee().isLaunched()}`);
}
async function s1Flush(): Promise<void> {
  const ok = await getBugsee().flush(10_000);
  note(`S1: flush() resolved ${ok}`);
}
function s1IsLaunched(): void {
  note(`S1: isLaunched()=${getBugsee().isLaunched()}`);
}

// ---------- S2 Identity & attributes ----------
function s2Identity(): void {
  const c = getBugsee();
  note(`S2: getUserIdentifier() before=${c.getUserIdentifier()}`);
  c.setUserIdentifier(SAMPLE_USER_ID);
  note(`S2: setUserIdentifier(${SAMPLE_USER_ID}); now=${c.getUserIdentifier()}`);
}
function s2Attributes(): void {
  const c = getBugsee();
  c.setAttribute('attr.string', marker('S2'));
  c.setAttribute('attr.number', 42);
  c.setAttribute('attr.boolean', true);
  c.setAttribute('attr.array', ['a', 'b', 'c']);
  note(`S2: set 4 attribute types; getAllAttributes()=${JSON.stringify(c.getAllAttributes())}`);
}
function s2ClearOne(): void {
  const c = getBugsee();
  c.clearAttribute('attr.number');
  note(`S2: cleared attr.number; getAttribute=${c.getAttribute('attr.number')}`);
}
function s2ClearAll(): void {
  const c = getBugsee();
  c.clearAllAttributes();
  note(`S2: clearAllAttributes(); getAllAttributes()=${JSON.stringify(c.getAllAttributes())}`);
  c.setAttribute('sample', 'vue-spa'); // restore the baseline attribute the rest of the demo relies on
  c.setAttribute('runId', RUN_ID);
}
function s2ClearUser(): void {
  const c = getBugsee();
  c.clearUserIdentifier();
  note(`S2: clearUserIdentifier(); now=${c.getUserIdentifier()}`);
  c.setUserIdentifier(SAMPLE_USER_ID); // restore
}

// ---------- S3 Manual telemetry ----------
function s3Logs(): void {
  const c = getBugsee();
  const m = marker('S3-logs');
  c.log(`error level: ${m}`, 'error');
  c.log(`warning level: ${m}`, 'warning');
  c.log(`info level: ${m}`, 'info');
  c.log(`debug level: ${m}`, 'debug');
  c.log(`verbose level: ${m}`, 'verbose');
  note(`S3: logged at all 5 levels — ${m}`);
}
function s3Event(): void {
  const c = getBugsee();
  const m = marker('S3-event');
  c.event('recipe_viewed', { recipeId: 'tomato-basil-soup', marker: m });
  c.event('scenario_no_params');
  note(`S3: event() with and without params — ${m}`);
}
function s3Trace(): void {
  const c = getBugsee();
  const m = marker('S3-trace');
  c.trace('scenario.trace', { marker: m, cookTimeMinutes: 30 });
  note(`S3: trace() — ${m}`);
}
function s3Breadcrumb(): void {
  const c = getBugsee();
  const m = marker('S3-breadcrumb');
  c.addBreadcrumb({
    type: 'navigation',
    category: 'scenario',
    message: `full breadcrumb ${m}`,
    level: 'info',
    data: { marker: m, source: 'Scenarios.vue' },
  });
  note(`S3: addBreadcrumb() with every field — ${m}`);
}

// ---------- S4 Exceptions ----------
async function s4Error(): Promise<void> {
  const m = marker('S4-error');
  await getBugsee().logException(new Error(`S4 plain Error ${m}`), { mechanism: 'programmatic' });
  note(`S4: logException(Error) — ${m}`);
}
async function s4NonError(): Promise<void> {
  const m = marker('S4-nonerror');
  await getBugsee().logException(`a thrown string ${m}`, { mechanism: 'programmatic' });
  await getBugsee().logException({ code: 'BOOM', marker: m }, { mechanism: 'programmatic' });
  await getBugsee().logException(null, { mechanism: 'programmatic' });
  note(`S4: logException(string/object/null) — ${m}`);
}
async function s4Cause(): Promise<void> {
  const m = marker('S4-cause');
  const root = new Error(`root cause ${m}`);
  const wrapped = new Error(`wrapped ${m}`, { cause: root });
  await getBugsee().logException(wrapped, {
    mechanism: 'programmatic',
    severity: 'high',
    labels: [`scenario:S4-cause`, m],
  });
  note(`S4: logException with nested cause + options — ${m}`);
}
async function s4Dedupe(): Promise<void> {
  const m = marker('S4-dedupe');
  const err = new Error(`same instance twice ${m}`);
  await getBugsee().logException(err, { mechanism: 'programmatic' });
  await getBugsee().logException(err, { mechanism: 'programmatic' });
  note(`S4: same Error instance reported twice (expect dedupe) — ${m}`);
}
async function s4Storm(): Promise<void> {
  const m = marker('S4-storm');
  const results = await Promise.all(
    Array.from({ length: 200 }, (_, i) =>
      getBugsee().logException(new Error(`storm #${i} ${m}`), { mechanism: 'programmatic' }),
    ),
  );
  const dropped = results.filter((r) => !r.ok).length;
  note(`S4: fired 200 exceptions — ${dropped} reported not-ok (rate-limited) — ${m}`);
}

// ---------- S5 Crashes ----------
function s5Uncaught(): void {
  const m = marker('S5-uncaught');
  note(`S5: throwing uncaught in a macrotask — ${m}`);
  setTimeout(() => {
    throw new Error(`S5 uncaught exception ${m}`);
  }, 0);
}
function s5Rejection(): void {
  const m = marker('S5-rejection');
  note(`S5: creating unhandled promise rejection — ${m}`);
  Promise.reject(new Error(`S5 unhandled rejection ${m}`));
}

// ---------- S6 Console capture ----------
function s6Console(): void {
  const m = marker('S6');
  console.log('console.log', m, 1, true);
  console.info('console.info', m);
  console.warn('console.warn', m);
  console.error('console.error', m);
  console.debug('console.debug', m);
  console.trace('console.trace', m);
  const obj: Record<string, unknown> = { marker: m, nested: { a: 1 } };
  console.log('console.log with object', obj);
  const circular: Record<string, unknown> = { marker: m };
  circular.self = circular;
  console.log('console.log with circular object', circular);
  note(`S6: exercised console.log/info/warn/error/debug/trace + multi-arg + object + circular — ${m}`);
}

// ---------- S7 Network capture ----------
async function s7FetchJson(): Promise<void> {
  const m = marker('S7-fetch-json');
  const res = await fetch('/api/scenarios/echo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marker: m }),
  });
  const body = (await res.json()) as { marker: string };
  note(`S7: fetch POST JSON round-trip, echoed marker=${body.marker} (app behaviour preserved)`);
}
async function s7FetchText(): Promise<void> {
  const res = await fetch('/api/scenarios/text');
  const text = await res.text();
  note(`S7: fetch GET text/plain — body="${text}"`);
}
async function s74xx(): Promise<void> {
  const res = await fetch('/api/scenarios/4xx');
  note(`S7: fetch 4xx — status=${res.status}`);
}
async function s75xx(): Promise<void> {
  const res = await fetch('/api/scenarios/5xx');
  note(`S7: fetch 5xx — status=${res.status}`);
}
async function s7ConnectionFailure(): Promise<void> {
  try {
    await fetch('http://127.0.0.1:59999/nobody-home');
    note('S7: connection-failure fetch unexpectedly succeeded');
  } catch (err) {
    note(`S7: connection-failure fetch rejected as expected: ${String(err)}`);
  }
}
async function s7Big(): Promise<void> {
  const res = await fetch('/api/scenarios/big');
  const body = (await res.json()) as { big: string };
  note(`S7: fetch body over maxNetworkBodySize — received ${body.big.length} bytes (app still reads it)`);
}
async function s7NoContentType(): Promise<void> {
  const res = await fetch('/api/scenarios/no-content-type');
  const text = await res.text();
  note(`S7: fetch response with no Content-Type — body="${text}"`);
}
function s7Xhr(): void {
  const m = marker('S7-xhr');
  const xhr = new XMLHttpRequest();
  xhr.open('GET', `/api/recipes?xhr=${m}`);
  xhr.onload = () => note(`S7: XHR GET completed — status=${xhr.status}, marker=${m}`);
  xhr.onerror = () => note(`S7: XHR GET errored — marker=${m}`);
  xhr.send();
}
function s7WebSocket(): void {
  const m = marker('S7-ws');
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${window.location.host}/api/scenarios/ws`);
  ws.onopen = () => ws.send(`hello from vue-spa ${m}`);
  ws.onmessage = (evt) => note(`S7: WebSocket message — ${evt.data}`);
  ws.onerror = () => note(`S7: WebSocket error — ${m}`);
  setTimeout(() => ws.close(), 1500);
}
function s7Sse(): void {
  const m = marker('S7-sse');
  const es = new EventSource('/api/scenarios/sse');
  let count = 0;
  es.addEventListener('tick', (evt) => {
    count += 1;
    note(`S7: SSE tick #${count} — ${(evt as MessageEvent).data} — ${m}`);
    if (count >= 3) es.close();
  });
  es.onerror = () => es.close();
}

// ---------- S8 Filters & redaction ----------
const filtersArmed = ref(false);
function s8ArmFilters(): void {
  const c = getBugsee();
  c.setNetworkEventFilter((event) => {
    // Redact a header and a body field; veto anything hitting /api/scenarios/veto-me entirely.
    if (event.url.includes('/api/scenarios/veto-me')) return null;
    console.debug(`network-filter-ran:${RUN_ID}`); // proxy signal — see samples/vue-spa/scenarios.md S8
    return event;
  });
  c.setLogEventFilter((event) => {
    if (event.message.includes('DROP_ME')) return null;
    if (event.message.includes('SECRET_TOKEN')) {
      return { ...event, message: event.message.replace('SECRET_TOKEN', '[redacted]') };
    }
    return event;
  });
  c.setBreadcrumbFilter((crumb) => {
    if (crumb.message?.includes('SECRET_TOKEN')) {
      return { ...crumb, message: crumb.message.replace('SECRET_TOKEN', '[redacted]') };
    }
    return crumb;
  });
  filtersArmed.value = true;
  note('S8: armed network/log/breadcrumb filters (redact SECRET_TOKEN, drop DROP_ME, veto /veto-me)');
}
function s8DisarmFilters(): void {
  const c = getBugsee();
  c.setNetworkEventFilter(null);
  c.setLogEventFilter(null);
  c.setBreadcrumbFilter(null);
  filtersArmed.value = false;
  note('S8: cleared all filters');
}
function s8TriggerLogRedaction(): void {
  const m = marker('S8-log-redact');
  getBugsee().log(`this line has a SECRET_TOKEN in it ${m}`, 'info');
  getBugsee().log(`this whole DROP_ME line should never arrive ${m}`, 'info');
  note(`S8: fired the redact + drop log lines — ${m}`);
}
async function s8TriggerNetworkVeto(): Promise<void> {
  const m = marker('S8-net-veto');
  await fetch(`/api/scenarios/veto-me?marker=${m}`);
  note(`S8: fetched /api/scenarios/veto-me — this network entry must NOT appear in capture — ${m}`);
}
async function s8TriggerReportBefore(): Promise<void> {
  const m = marker('S8-report-mutate');
  getBugsee().setReportHandler({
    before: (request) => {
      request.report.labels = [...(request.report.labels ?? []), `mutated-by-before:${m}`];
      return request;
    },
  });
  await getBugsee().logException(new Error(`S8 before-mutate ${m}`), { mechanism: 'programmatic' });
  getBugsee().setReportHandler(null);
  note(`S8: setReportHandler before mutated the report (added a label) — ${m}`);
}
async function s8TriggerReportVeto(): Promise<void> {
  const m = marker('S8-report-veto');
  getBugsee().setReportHandler({ before: () => null });
  const result = await getBugsee().logException(new Error(`S8 vetoed report ${m}`), {
    mechanism: 'programmatic',
  });
  getBugsee().setReportHandler(null);
  note(`S8: setReportHandler before vetoed the report — ok=${result.ok} (expect no issue to arrive) — ${m}`);
}

// ---------- S9 Performance / APM ----------
function s9ManualTransaction(): void {
  const m = marker('S9');
  const txn = perf().startTransaction({ name: `scenario:${m}`, operation: 'scenario.manual' });
  const child = txn.startChildSpan('scenario.child', 'a child span with every SpanStatus exercised');
  child.setAttribute('marker', m);
  child.setStatus('OK');
  child.finish('OK');
  const child2 = txn.startChildSpan('scenario.child.error');
  child2.finish('ERROR');
  txn.setAttribute('marker', m);
  txn.finish('OK');
  note(`S9: manual transaction + 2 child spans (OK, ERROR) — ${m}`);
}
function s9SetRouteName(): void {
  const m = marker('S9-route');
  perf().setRouteName(`/scenarios/custom/${m}`);
  note(`S9: setRouteName() — ${m}`);
}

// ---------- S12 Persistence & recovery ----------
function s12ArmPersistenceProbe(): void {
  const m = marker('S12');
  getBugsee().addBreadcrumb({
    type: 'manual',
    category: 'persistence-probe',
    message: `persistence probe armed ${m}`,
  });
  window.localStorage.setItem('bugsee-sample:last-persistence-marker', m);
  note(
    `S12: armed a persistence probe (${m}) — reload/close the tab now WITHOUT flushing; on the next ` +
      'launch `recover:true` should re-upload this session\'s capture.',
  );
}

// ---------- S14 Vue-specific: render-mixin proof ----------
function s14RenderMixinNote(): void {
  note('S14: component mixin + render mixin run on every mount/update in this app (see main.ts) — no ' +
    'separate trigger; data-bugsee-component is visible on every element via devtools.');
}
</script>

<template>
  <section class="scenarios">
    <h1>Scenario panel</h1>
    <p>
      RUN_ID: <code>{{ RUN_ID }}</code> — every button below stamps this into a label/breadcrumb/log line
      so the resulting issue can be found on the backend.
    </p>

    <div class="panel">
      <h2>S1 · Launch &amp; lifecycle</h2>
      <div class="row">
        <button data-testid="s1-relaunch" @click="s1Relaunch">launch() again (must be ignored)</button>
        <button data-testid="s1-flush" @click="s1Flush">flush()</button>
        <button data-testid="s1-islaunched" @click="s1IsLaunched">isLaunched()</button>
      </div>
    </div>

    <div class="panel">
      <h2>S2 · Identity &amp; attributes</h2>
      <div class="row">
        <button data-testid="s2-identity" @click="s2Identity">setUserIdentifier</button>
        <button data-testid="s2-attributes" @click="s2Attributes">setAttribute (4 types)</button>
        <button data-testid="s2-clear-one" @click="s2ClearOne">clearAttribute</button>
        <button data-testid="s2-clear-all" @click="s2ClearAll">clearAllAttributes</button>
        <button data-testid="s2-clear-user" @click="s2ClearUser">clearUserIdentifier</button>
      </div>
    </div>

    <div class="panel">
      <h2>S3 · Manual telemetry</h2>
      <div class="row">
        <button data-testid="s3-logs" @click="s3Logs">log() at every level</button>
        <button data-testid="s3-event" @click="s3Event">event()</button>
        <button data-testid="s3-trace" @click="s3Trace">trace()</button>
        <button data-testid="s3-breadcrumb" @click="s3Breadcrumb">addBreadcrumb()</button>
      </div>
    </div>

    <div class="panel">
      <h2>S4 · Exceptions</h2>
      <div class="row">
        <button data-testid="s4-error" @click="s4Error">logException(Error)</button>
        <button data-testid="s4-nonerror" @click="s4NonError">logException(string/object/null)</button>
        <button data-testid="s4-cause" @click="s4Cause">logException(cause + options)</button>
        <button data-testid="s4-dedupe" @click="s4Dedupe">logException(same instance x2)</button>
        <button data-testid="s4-storm" @click="s4Storm">logException storm (200)</button>
      </div>
    </div>

    <div class="panel">
      <h2>S5 · Crashes</h2>
      <div class="row">
        <button data-testid="s5-uncaught" @click="s5Uncaught">uncaught exception</button>
        <button data-testid="s5-rejection" @click="s5Rejection">unhandled promise rejection</button>
      </div>
    </div>

    <div class="panel">
      <h2>S6 · Console capture</h2>
      <div class="row">
        <button data-testid="s6-console" @click="s6Console">console.* (all levels + object + circular)</button>
      </div>
    </div>

    <div class="panel">
      <h2>S7 · Network capture</h2>
      <div class="row">
        <button data-testid="s7-fetch-json" @click="s7FetchJson">fetch POST JSON</button>
        <button data-testid="s7-fetch-text" @click="s7FetchText">fetch GET text</button>
        <button data-testid="s7-4xx" @click="s74xx">fetch 4xx</button>
        <button data-testid="s7-5xx" @click="s75xx">fetch 5xx</button>
        <button data-testid="s7-conn-fail" @click="s7ConnectionFailure">connection failure</button>
        <button data-testid="s7-big" @click="s7Big">body over maxNetworkBodySize</button>
        <button data-testid="s7-no-ct" @click="s7NoContentType">response with no Content-Type</button>
        <button data-testid="s7-xhr" @click="s7Xhr">XHR</button>
        <button data-testid="s7-ws" @click="s7WebSocket">WebSocket</button>
        <button data-testid="s7-sse" @click="s7Sse">SSE (EventSource)</button>
      </div>
    </div>

    <div class="panel">
      <h2>S8 · Filters &amp; redaction</h2>
      <div class="row">
        <button data-testid="s8-arm" @click="s8ArmFilters" :disabled="filtersArmed">Arm filters</button>
        <button data-testid="s8-disarm" @click="s8DisarmFilters" :disabled="!filtersArmed">
          Disarm filters
        </button>
        <button data-testid="s8-log-redact" @click="s8TriggerLogRedaction">Trigger log redact/drop</button>
        <button data-testid="s8-net-veto" @click="s8TriggerNetworkVeto">Trigger network veto</button>
        <button data-testid="s8-report-mutate" @click="s8TriggerReportBefore">
          before: mutate report
        </button>
        <button data-testid="s8-report-veto" @click="s8TriggerReportVeto">before: veto report</button>
      </div>
    </div>

    <div class="panel">
      <h2>S9 · Performance / APM</h2>
      <div class="row">
        <button data-testid="s9-manual-txn" @click="s9ManualTransaction">
          Manual transaction + child spans
        </button>
        <button data-testid="s9-route-name" @click="s9SetRouteName">setRouteName()</button>
      </div>
    </div>

    <div class="panel">
      <h2>S12 · Persistence &amp; recovery</h2>
      <div class="row">
        <button data-testid="s12-arm" @click="s12ArmPersistenceProbe">Arm persistence probe</button>
      </div>
    </div>

    <div class="panel">
      <h2>Vue-specific error surfaces</h2>
      <ErrorLab />
    </div>

    <div class="panel">
      <h2>S14 · Platform / framework specifics</h2>
      <div class="row">
        <button data-testid="s14-note" @click="s14RenderMixinNote">About the render/component mixin</button>
      </div>
    </div>

    <div class="panel log-panel">
      <h2>Activity log</h2>
      <ul data-testid="activity-log">
        <li v-for="(line, i) in log" :key="i">{{ line }}</li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
  .panel {
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.9rem 1rem;
    margin-bottom: 1rem;
    background: white;
  }
  .panel h2 {
    margin-top: 0;
    font-size: 1rem;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .row button {
    background: #f3ece0;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.4rem 0.7rem;
    font-size: 0.85rem;
  }
  .row button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .log-panel ul {
    list-style: none;
    padding: 0;
    margin: 0;
    max-height: 260px;
    overflow-y: auto;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
  }
  .log-panel li {
    padding: 0.15rem 0;
    border-bottom: 1px dashed var(--border);
  }
</style>
