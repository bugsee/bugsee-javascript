# ST0′ — Tracker / Producer Substrate for System Traces — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `traces.system` the way the Android/iOS SDKs do it — shared **trackers** that own raw signals and aggregate state, per-trace **producers** that subscribe to trackers and turn state into values, and a **provider** that is a container of producers — and prove the pattern end-to-end on one node chain (process stats + event loop) and one browser chain (battery, with the `charging` fix). This replaces the earlier `LifecycleSampler` plan: resource ownership now follows from subscriber presence, so the lifecycle seam is not needed.

**Architecture:** A tracker is an `InterceptorBase` subclass (already the JS listenable-emitter-with-subscriber-presence-activation primitive): it attaches its OS resource (timer, histogram, `getBattery()` listener) on the first subscriber and releases it on the last. A producer subscribes to a tracker in `start()` and unsubscribes in `stop()`, emits a baseline at start, and de-duplicates. `createSystemTracesProvider` takes `producers`, starts/stops each with error isolation, keeps a last-value snapshot, and re-emits stale values so a rolling capture window never loses a rarely-changing trace. The old bare `sample()` option is kept as a legacy polled adapter so nothing existing breaks while later slices migrate the rest.

**Tech Stack:** TypeScript (`module: ESNext`, `verbatimModuleSyntax`), Vitest, pnpm + turbo, Biome. Node ≥18, Bun, Deno, browsers.

**Spec:** `docs/design/system-traces-expansion.md` (PR #53) — read §5, §9, §12, §13.4 and the new **§14 (tracker/producer structure)**. Mobile references: Android `shared/trackers/BugseeTrackerBase.java`, `capture/providers/traces_system/*`, `BugseeCaptureValueProducer*`; iOS `Shared/Trackers/BGSTrackerBase.*`, `Capture/Providers/TracesSystem/*`.

## Global Constraints

- **Coverage per package:** 100% line/function/statement, ≥ 90% branch (vitest v8); unreachable code only via `/* v8 ignore … */` with a one-line justification.
- **Test-first + mutator loop (`docs/implementation-standards.md` §2):** write the failing test, implement, then inject up to 10 different bugs into the new code and confirm the tests fail each time; **restore by `cp` from a saved copy, never `git checkout`**; never commit a mutation.
- **Typecheck separately:** vitest does not typecheck — run `pnpm --filter @bugsee/<pkg> exec tsc --noEmit` before every commit.
- **Gate before pushing:** `pnpm ci:local`.
- **Portable shared tiers:** `@bugsee/capture` and `@bugsee/core` never import `node:*` or DOM types.
- **Trackers are `InterceptorBase` subclasses**, created **per launch** from injected environment (like `createBrowserSystemEventsSource`), not module singletons. Activation is by subscriber presence only; a tracker never starts anything in its constructor.
- **Never fabricate a reading:** when a source cannot answer, the trace is omitted, never zeroed. Bun/Deno honesty flags live on the tracker/factory deps, not on launch options.
- **Error isolation at every layer:** the emitter already isolates a throwing listener; the provider additionally isolates each producer's `start()`/`stop()`; the provider timer never lets an exception escape.
- **Wire shape:** unchanged trace names and values everywhere **except** `charging`, which becomes `{ state: 1 | 2 | 3 }` (viewer table keys `"0"`–`"3"`), `source` omitted, never invented. `environment.hardware.charging` stays a boolean.
- **Public API:** `systemMetricsSampler` keeps working (legacy). New option `systemTraceProducers`. Beta packages — removing the legacy samplers is a later cleanup slice, not this plan.
- **Branching:** reviewed as a PR. Branch `feat/trace-producers` from `main`; one commit per task; draft PR after Task 3. Attribution on every commit/PR: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Review Focus

Failure modes the spec implies but a straight reading of the tasks would not exercise (each pinned by a named test in the owning task):

1. **Option gate:** with `captureSystemTraces: false` no tracker activates — no timer, no histogram, no `getBattery()` call — through the real launch + provider path, for the node default **and** the Bun/Deno-flagged factory. (Tasks 4, 5, 6.)
2. **One producer throws in `start()`** → the others still start, the error is reported, the half-started producer is stopped. **One throws in `stop()`** → the rest still stop. (Task 2.)
3. **Rolling-window loss:** a value that never changes (e.g. battery) must still be present in a report taken after the window has rolled — the provider's refresh re-emits it. (Task 2.)
4. **Start → stop → start:** trackers re-attach, baselines re-emit, no double timers, no stale state. (Tasks 3, 4, 6.)
5. **`getBattery()` resolves after `stop()`, or after a stop→start:** the late fulfilment must not attach listeners or emit. (Task 6.)
6. **Late callbacks after provider stop:** a tracker event delivered after the provider stopped must not write an entry. (Task 2.)
7. **Shared tracker, many producers:** three producers on one process-stats tracker must not triple-advance CPU deltas at start. (Task 3.)
8. **Bun/Deno blindness:** event-loop lag is omitted where the runtime cannot measure it, and `sample`-before-start never yields a zero. (Task 4.)
9. **`charging` edges:** level 1 while charging → full (3); 0.99 → charging (2); not charging → unplugged (1); unknown (0) never emitted. (Task 6.)

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/capture/src/trace-producer.ts` (+ `.test.ts`) | create | `TraceSink`, `TraceProducer`, `TraceProducerBase` (baseline-friendly emit + de-dup) |
| `packages/capture/src/system-traces-provider.ts` (+ test) | modify | producers container, sink, isolation, snapshot + refresh, legacy `sample` kept |
| `packages/capture/src/index.ts` | modify | export the new API |
| `packages/node/src/trackers/process-stats-tracker.ts` (+ test) | create | one timer; memory / system RAM / CPU / event-loop; shared by 5 producers |
| `packages/node/src/trackers/guarded-event-loop.ts` (+ test) | create | lazy event-loop + ELU sources with the Bun/Deno guards (moved out of `guarded-system-metrics.ts`) |
| `packages/node/src/trace-producers.ts` (+ test) | create | the five node producers + `createNodeSystemTraceProducers(deps)` |
| `packages/node/src/launch.ts` (+ test) | modify | `systemTraceProducers` option; default producers |
| `packages/bun/src/launch.ts`, `packages/deno/src/launch.ts` (+ tests) | modify | inject `createNodeSystemTraceProducers(...)` with the Deno flag |
| `packages/browser/src/trackers/battery-tracker.ts` (+ test) | create | `getBattery()` on activation, abort token, `levelchange`/`chargingchange` |
| `packages/browser/src/trace-producers.ts` (+ test) | create | `BatteryProducer`, `createBrowserSystemTraceProducers(env)` |
| `packages/browser/src/system-trace-values.ts` (+ test) | modify | `chargingToWire` |
| `packages/browser/src/system-metrics.ts` (+ test) | modify | remove battery/charging from the legacy sampler |
| `packages/browser/src/launch.ts`, `packages/webview/src/launch.ts` (+ tests) | modify | wire `producers` |
| `docs/PROGRESS.md` | modify | record |

Untouched by design at ST0′: `guarded-system-metrics.ts` and `system-metrics.ts` in `@bugsee/node` stayed until a cleanup slice. Deleted in ST0′-D.

## Cross-task interfaces (defined once)

```ts
// @bugsee/capture (Task 1)
export interface TraceSink { emit(name: string, value: unknown, displayId?: number): void }
export interface TraceProducer { readonly name: string; start(sink: TraceSink): void; stop(): void }
export abstract class TraceProducerBase implements TraceProducer {
  abstract readonly name: string;
  start(sink: TraceSink): void;           // idempotent; clears dedup state; calls onStart()
  stop(): void;                           // idempotent; calls onStop(); drops the sink
  protected abstract onStart(): void;
  protected onStop(): void;
  protected emit(name: string, value: unknown, displayId?: number): void;           // always
  protected emitIfChanged(name: string, value: unknown, displayId?: number): void;  // only when != last
}
// SystemTracesProviderOptions gains: producers?: readonly TraceProducer[]; onError?: (e: unknown) => void;
//   refreshMs?: number (default 10_000; Infinity disables); `sample` stays (legacy, now optional)

// @bugsee/node (Tasks 3-4)
export interface ProcessStats {
  memory: { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number };
  systemMemory: { total: number; free: number };
  cpu: { userDelta: number; systemDelta: number; processPct: number };
  eventLoop?: { meanMs: number; maxMs: number; p99Ms: number };   // absent when not measurable
  utilization?: number;                                            // absent when not measurable
}
export interface EventLoopSource { read(): { meanMs: number; maxMs: number; p99Ms: number } | undefined; start(): void; stop(): void }
export class ProcessStatsTracker extends InterceptorBase<{ stats: ProcessStats }> { current(): ProcessStats }
export function createNodeSystemTraceProducers(deps?: NodeTraceProducerDeps): TraceProducer[];

// @bugsee/browser (Tasks 6)
export interface BatteryState { level: number; charging: boolean }
export class BatteryTracker extends InterceptorBase<{ state: BatteryState }> { current(): BatteryState | undefined }
export function createBrowserSystemTraceProducers(env?: BrowserBatteryEnv): TraceProducer[];
export function chargingToWire(b: { charging: boolean; level: number }): { state: 1 | 2 | 3 };
```

---

### Task 1: Producer contract and base class (`@bugsee/capture`)

**Files:** Create `packages/capture/src/trace-producer.ts`, `packages/capture/src/trace-producer.test.ts`; modify `packages/capture/src/index.ts`.

- [ ] **Step 1: Write the failing tests** (`trace-producer.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { type TraceSink, TraceProducerBase } from './trace-producer';

type Emitted = { name: string; value: unknown; displayId?: number };
const mkSink = (): { sink: TraceSink; got: Emitted[] } => {
  const got: Emitted[] = [];
  return { got, sink: { emit: (name, value, displayId) => void got.push({ name, value, ...(displayId !== undefined ? { displayId } : {}) }) } };
};

class Probe extends TraceProducerBase {
  readonly name = 'probe';
  starts = 0;
  stops = 0;
  emitAll: (n: string, v: unknown, d?: number) => void = (n, v, d) => this.emit(n, v, d);
  emitChanged: (n: string, v: unknown, d?: number) => void = (n, v, d) => this.emitIfChanged(n, v, d);
  protected onStart(): void { this.starts += 1; }
  protected override onStop(): void { this.stops += 1; }
}

describe('TraceProducerBase', () => {
  it('start() is idempotent and calls onStart once', () => {
    const p = new Probe(); const { sink } = mkSink();
    p.start(sink); p.start(sink);
    expect(p.starts).toBe(1);
  });

  it('stop() is idempotent, a no-op before start, and calls onStop once', () => {
    const p = new Probe(); const { sink } = mkSink();
    p.stop();
    expect(p.stops).toBe(0);
    p.start(sink); p.stop(); p.stop();
    expect(p.stops).toBe(1);
  });

  it('emit() always forwards; after stop() it is dropped (late callbacks cannot write)', () => {
    const p = new Probe(); const { sink, got } = mkSink();
    p.start(sink);
    p.emitAll('a', 1); p.emitAll('a', 1);
    p.stop();
    p.emitAll('a', 2);
    expect(got).toEqual([{ name: 'a', value: 1 }, { name: 'a', value: 1 }]);
  });

  it('emitIfChanged() drops equal consecutive values per name+display (primitives)', () => {
    const p = new Probe(); const { sink, got } = mkSink();
    p.start(sink);
    p.emitChanged('a', 1); p.emitChanged('a', 1); p.emitChanged('a', 2); p.emitChanged('a', 1);
    expect(got.map((g) => g.value)).toEqual([1, 2, 1]);
  });

  it('emitIfChanged() compares objects structurally', () => {
    const p = new Probe(); const { sink, got } = mkSink();
    p.start(sink);
    p.emitChanged('c', { state: 2 }); p.emitChanged('c', { state: 2 }); p.emitChanged('c', { state: 3 });
    expect(got.map((g) => g.value)).toEqual([{ state: 2 }, { state: 3 }]);
  });

  it('emitIfChanged() tracks each name and displayId separately', () => {
    const p = new Probe(); const { sink, got } = mkSink();
    p.start(sink);
    p.emitChanged('a', 1); p.emitChanged('b', 1); p.emitChanged('a', 1, 0); p.emitChanged('a', 1, 0);
    expect(got).toEqual([
      { name: 'a', value: 1 }, { name: 'b', value: 1 }, { name: 'a', value: 1, displayId: 0 },
    ]);
  });

  it('a restart clears the dedup state, so the baseline re-emits', () => {
    const p = new Probe(); const { sink, got } = mkSink();
    p.start(sink); p.emitChanged('a', 1); p.stop();
    p.start(sink); p.emitChanged('a', 1);
    expect(got).toHaveLength(2);
  });

  it('stop() still drops the sink when onStop throws', () => {
    class Throwing extends Probe { protected override onStop(): void { throw new Error('boom'); } }
    const p = new Throwing(); const { sink, got } = mkSink();
    p.start(sink);
    expect(() => p.stop()).toThrow('boom');
    p.emitAll('a', 1); // dropped
    expect(got).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @bugsee/capture exec vitest run src/trace-producer.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** (`trace-producer.ts`):

```ts
// A TRACE PRODUCER (Android BugseeCaptureValueProducer / iOS BGSCaptureSystemTraceProducer parity): the unit
// that turns a tracker's aggregated state into named `traces.system` values. It SUBSCRIBES to one or more
// trackers in onStart() and unsubscribes in onStop(); trackers attach/release their OS resources by
// subscriber presence, so a producer that is never started costs nothing. The provider hands every
// producer a sink; the producer never talks to the aggregator itself.

/** Where a producer sends its values (the provider stamps the time and keeps the last-value snapshot). */
export interface TraceSink {
  /** Record one trace sample. `displayId` scopes it to a display; absent = device-wide. */
  emit(name: string, value: unknown, displayId?: number): void;
}

export interface TraceProducer {
  /** Producer id, for diagnostics. */
  readonly name: string;
  /** Subscribe to trackers and emit a baseline. Must be safe to call again after stop(). */
  start(sink: TraceSink): void;
  /** Unsubscribe from everything start() attached. Idempotent; a no-op before start(). */
  stop(): void;
}

const sameValue = (a: unknown, b: unknown): boolean =>
  Object.is(a, b) ||
  (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null &&
    JSON.stringify(a) === JSON.stringify(b));

const keyOf = (name: string, displayId: number | undefined): string =>
  displayId === undefined ? name : `${displayId}:${name}`;

export abstract class TraceProducerBase implements TraceProducer {
  abstract readonly name: string;
  #sink: TraceSink | undefined;
  readonly #last = new Map<string, unknown>();

  start(sink: TraceSink): void {
    if (this.#sink !== undefined) return;
    this.#sink = sink;
    this.#last.clear();
    this.onStart();
  }

  stop(): void {
    if (this.#sink === undefined) return;
    try {
      this.onStop();
    } finally {
      this.#sink = undefined; // late tracker callbacks after stop() must not write
      this.#last.clear();
    }
  }

  /** Subscribe to trackers (and emit the baseline) here. */
  protected abstract onStart(): void;
  /** Unsubscribe here. */
  protected onStop(): void {}

  /** Always emit (polled families: cpu / memory emit every tick, like Android). */
  protected emit(name: string, value: unknown, displayId?: number): void {
    this.#sink?.emit(name, value, displayId);
    if (this.#sink !== undefined) this.#last.set(keyOf(name, displayId), value);
  }

  /** Emit only when the value differs from the last emitted for this name+display (iOS emitIfChangedName). */
  protected emitIfChanged(name: string, value: unknown, displayId?: number): void {
    const key = keyOf(name, displayId);
    if (this.#last.has(key) && sameValue(this.#last.get(key), value)) return;
    this.emit(name, value, displayId);
  }
}
```

Export from `index.ts`: `export { type TraceProducer, TraceProducerBase, type TraceSink } from './trace-producer';`

- [ ] **Step 4: Run to verify pass** — same command + `pnpm --filter @bugsee/capture exec tsc --noEmit`.
- [ ] **Step 5: Mutator loop** — back up the file; mutate: drop the `#sink !== undefined` guard in `start`/`stop`; remove `#last.clear()` in start; make `sameValue` use `===` only (objects); key without displayId; `emit` writing `#last` before the sink check; swallow `onStop` throw; skip `finally`. Each must fail a test; restore.
- [ ] **Step 6: Commit** — `git add packages/capture/src/trace-producer.ts packages/capture/src/trace-producer.test.ts packages/capture/src/index.ts && git commit -m "feat(capture): TraceProducer contract and base (baseline-friendly emit, de-dup)"` + attribution.

---

### Task 2: Provider becomes a producer container (`@bugsee/capture`)

**Files:** Modify `packages/capture/src/system-traces-provider.ts` and its `.test.ts`; `index.ts` unchanged.

**Interfaces:** Consumes `TraceProducer`/`TraceSink` (Task 1). Produces the extended `SystemTracesProviderOptions` and a provider that still accepts the legacy `sample`.

Behaviour (each is a test below): `start()` → per producer `start(sink)` in try/catch (failure → `onError`, `stop()` that producer, continue); then legacy `sample()` initial emit (a throw there stops all started producers and rethrows — launch already routes a provider-start failure to `onError`); then one timer at `intervalMs` (default 1000) whose tick runs the legacy `sample()` and the refresh. `stop()` → timer cleared, every started producer stopped in try/catch, snapshot cleared, sink closed. The sink stamps `now()`, writes `traces.system` `{timestamp, name, value[, displayId]}`, and records `{value, timestamp}` per `displayId:name`. **Refresh:** on each tick, any held value with `now - timestamp >= refreshMs` is re-emitted with the current timestamp (Android/iOS re-emit the snapshot on a part switch; JS stores roll a time window with no part hook — `chunk-capture-store.ts` evicts by `maxRecordingTimeMs`, so without this a rarely-changing trace ages out of every report).

- [ ] **Step 1: Write the failing tests** (append; `fakeScheduler`, `buildInit`, `mkStore`, `options`, `drainSystem` already exist in the file):

```ts
import { TraceProducerBase, type TraceSink } from './trace-producer';

class Fixed extends TraceProducerBase {
  readonly name: string;
  constructor(name: string, private readonly values: Array<[string, unknown, number?]>, private readonly opts: { throwStart?: boolean; throwStop?: boolean } = {}) { super(); this.name = name; }
  startedCount = 0; stoppedCount = 0; sinkRef: (() => void) | undefined;
  protected onStart(): void {
    this.startedCount += 1;
    for (const [n, v, d] of this.values) this.emit(n, v, d);
    if (this.opts.throwStart) throw new Error(`${this.name} start boom`);
  }
  protected override onStop(): void {
    this.stoppedCount += 1;
    if (this.opts.throwStop) throw new Error(`${this.name} stop boom`);
  }
  push(n: string, v: unknown): void { this.emit(n, v); }
}
const values = async (store: CaptureStore) => (await drainSystem(store))?.map((e) => e.data as { name: string; value: unknown; timestamp: number; displayId?: number }) ?? [];

describe('createSystemTracesProvider — producers', () => {
  it('starts every producer, routing their emits to traces.system with the provider timestamp', async () => {
    const store = mkStore(); const fs = fakeScheduler();
    const a = new Fixed('a', [['x', 1]]); const b = new Fixed('b', [['y', 2, 0]]);
    const p = createSystemTracesProvider({ producers: [a, b], scheduler: fs.scheduler, now: () => 1000 });
    p.init(buildInit(store)); p.start(options);
    expect(await values(store)).toEqual([
      { timestamp: 1000, name: 'x', value: 1 },
      { timestamp: 1000, name: 'y', value: 2, displayId: 0 },
    ]);
  });

  it('isolates a producer whose start() throws: reports, stops it, the others still start', () => {
    const fs = fakeScheduler(); const errors: unknown[] = [];
    const bad = new Fixed('bad', [], { throwStart: true }); const good = new Fixed('good', [['x', 1]]);
    const p = createSystemTracesProvider({ producers: [bad, good], scheduler: fs.scheduler, onError: (e) => errors.push(e) });
    p.init(buildInit(mkStore()));
    expect(() => p.start(options)).not.toThrow();
    expect(good.startedCount).toBe(1);
    expect(bad.stoppedCount).toBe(1);
    expect((errors[0] as Error).message).toBe('bad start boom');
  });

  it('isolates a producer whose stop() throws: the rest still stop, the timer is cleared', () => {
    const fs = fakeScheduler(); const errors: unknown[] = [];
    const bad = new Fixed('bad', [], { throwStop: true }); const good = new Fixed('good', []);
    const p = createSystemTracesProvider({ producers: [bad, good], scheduler: fs.scheduler, onError: (e) => errors.push(e) });
    p.init(buildInit(mkStore())); p.start(options);
    expect(() => p.stop()).not.toThrow();
    expect(good.stoppedCount).toBe(1);
    expect(fs.cleared()).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('never starts a producer when captureSystemTraces is off (coordinator gate)', () => {
    const fs = fakeScheduler(); const a = new Fixed('a', [['x', 1]]);
    const coordinator = createCaptureCoordinator(buildInit(mkStore()));
    coordinator.addProvider(createSystemTracesProvider({ producers: [a], scheduler: fs.scheduler }));
    coordinator.start(createOptionsContainer({ [BugseeOption.CaptureSystemTraces]: false }));
    expect(a.startedCount).toBe(0);
    coordinator.stop();
    expect(a.stoppedCount).toBe(0);
  });

  it('drops a producer emit that arrives after stop() (a late tracker callback)', async () => {
    const store = mkStore(); const fs = fakeScheduler();
    const a = new Fixed('a', []);
    const p = createSystemTracesProvider({ producers: [a], scheduler: fs.scheduler, now: () => 1 });
    p.init(buildInit(store)); p.start(options); p.stop();
    a.push('x', 1);
    expect(await values(store)).toEqual([]);
  });

  it('restart: producers start again and the baseline re-emits', async () => {
    const store = mkStore(); const fs = fakeScheduler();
    const a = new Fixed('a', [['x', 1]]);
    const p = createSystemTracesProvider({ producers: [a], scheduler: fs.scheduler, now: () => 1 });
    p.init(buildInit(store)); p.start(options); p.stop(); p.start(options);
    expect(a.startedCount).toBe(2);
    expect((await values(store)).map((v) => v.name)).toEqual(['x', 'x']);
  });

  it('REFRESH: re-emits a held value once it is older than refreshMs, and not before', async () => {
    const store = mkStore(); const fs = fakeScheduler(); let t = 0;
    const a = new Fixed('a', [['battery', 50]]);
    const p = createSystemTracesProvider({ producers: [a], scheduler: fs.scheduler, now: () => t, refreshMs: 10_000 });
    p.init(buildInit(store)); p.start(options);          // t=0 baseline
    t = 9_999; fs.tick();                                  // not yet
    t = 10_000; fs.tick();                                 // refresh at 10 000
    t = 10_500; fs.tick();                                 // not again until 20 000
    expect((await values(store)).map((v) => [v.name, v.timestamp])).toEqual([['battery', 0], ['battery', 10_000]]);
  });

  it('refreshMs: Infinity disables the refresh', async () => {
    const store = mkStore(); const fs = fakeScheduler(); let t = 0;
    const a = new Fixed('a', [['x', 1]]);
    const p = createSystemTracesProvider({ producers: [a], scheduler: fs.scheduler, now: () => t, refreshMs: Number.POSITIVE_INFINITY });
    p.init(buildInit(store)); p.start(options);
    t = 1e9; fs.tick();
    expect(await values(store)).toHaveLength(1);
  });

  it('a value that keeps changing is not refreshed (its latest timestamp is fresh)', async () => {
    const store = mkStore(); const fs = fakeScheduler(); let t = 0;
    const a = new Fixed('a', [['x', 0]]);
    const p = createSystemTracesProvider({ producers: [a], scheduler: fs.scheduler, now: () => t, refreshMs: 10_000 });
    p.init(buildInit(store)); p.start(options);
    t = 9_000; a.push('x', 1);
    t = 12_000; fs.tick();   // last write at 9 000 → age 3 000 < 10 000
    expect((await values(store)).map((v) => v.value)).toEqual([0, 1]);
  });

  it('the timer never lets an exception escape: a throwing legacy sample() goes to onError', () => {
    const fs = fakeScheduler(); const errors: unknown[] = []; let n = 0;
    const p = createSystemTracesProvider({
      sample: () => { n += 1; if (n > 1) throw new Error('tick boom'); return []; },
      scheduler: fs.scheduler, onError: (e) => errors.push(e),
    });
    p.init(buildInit(mkStore())); p.start(options);
    expect(() => fs.tick()).not.toThrow();
    expect((errors[0] as Error).message).toBe('tick boom');
  });

  it('a throwing INITIAL legacy sample stops the started producers and rethrows (launch routes it to onError)', () => {
    const fs = fakeScheduler(); const a = new Fixed('a', []);
    const p = createSystemTracesProvider({ producers: [a], sample: () => { throw new Error('sample boom'); }, scheduler: fs.scheduler });
    p.init(buildInit(mkStore()));
    expect(() => p.start(options)).toThrow('sample boom');
    expect(a.stoppedCount).toBe(1);
    expect(fs.interval()).toBe(0);
  });

  it('legacy: `sample` alone still behaves exactly as before (initial snapshot + interval)', async () => {
    const store = mkStore(); const fs = fakeScheduler();
    const p = createSystemTracesProvider({ sample: () => [{ name: 'm', value: 1 }], scheduler: fs.scheduler, now: () => 5 });
    p.init(buildInit(store)); p.start(options); fs.tick();
    expect(await values(store)).toHaveLength(2);
    expect(fs.interval()).toBe(1000);
  });

  it('requires producers or sample (a provider with neither is a programming error)', () => {
    expect(() => createSystemTracesProvider({} as never)).toThrow(/producers or sample/);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @bugsee/capture exec vitest run src/system-traces-provider.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Replace the class body in `system-traces-provider.ts`:

```ts
import { type TraceProducer, type TraceSink } from './trace-producer';

export interface SystemTracesProviderOptions {
  /** Trace producers (each subscribes to trackers; the provider owns start/stop + isolation). */
  producers?: readonly TraceProducer[];
  /** LEGACY polled seam: read every system trace on each tick. Kept so existing samplers/tests keep working. */
  sample?: () => readonly TraceSample[];
  intervalMs?: number;
  scheduler?: Scheduler;
  now?: () => number;
  /** A value older than this is re-emitted so a rolling capture window never loses a rarely-changing trace. Default 10 000; Infinity disables. */
  refreshMs?: number;
  /** Reports an isolated producer/tick failure. Must not throw. */
  onError?: (error: unknown) => void;
}

interface Held { name: string; value: unknown; timestamp: number; displayId: number | undefined }

class SystemTracesProvider extends CaptureProviderBase {
  readonly name = 'traces.system';
  readonly controllingOption = BugseeOption.CaptureSystemTraces;
  readonly #producers: readonly TraceProducer[];
  readonly #sample: (() => readonly TraceSample[]) | undefined;
  readonly #intervalMs: number;
  readonly #refreshMs: number;
  readonly #scheduler: Scheduler;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #held = new Map<string, Held>();
  #started: TraceProducer[] = [];
  #running = false;
  #timer: unknown = null;
  readonly #sink: TraceSink = {
    emit: (name, value, displayId) => {
      if (this.#running) this.#record(name, value, displayId, this.#now());
    },
  };

  constructor(options: SystemTracesProviderOptions) {
    super();
    if (options.producers === undefined && options.sample === undefined) {
      throw new Error('createSystemTracesProvider needs producers or sample');
    }
    this.#producers = options.producers ?? [];
    this.#sample = options.sample;
    this.#intervalMs = options.intervalMs ?? 1000;
    this.#refreshMs = options.refreshMs ?? 10_000;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#now = options.now ?? (() => Date.now());
    this.#onError = options.onError ?? (() => {});
  }

  protected onStart(): void {
    this.#held.clear();
    this.#running = true;
    for (const producer of this.#producers) {
      try {
        producer.start(this.#sink);
        this.#started.push(producer);
      } catch (error) {
        this.#onError(error);
        this.#safeStop(producer);
      }
    }
    try {
      this.#emitLegacy(this.#now()); // initial snapshot, so a short-lived session still has current values
    } catch (error) {
      this.#stopProducers();
      this.#running = false;
      throw error;
    }
    this.#timer = this.#scheduler.setInterval(() => this.#tick(), this.#intervalMs);
  }

  protected override onStop(): void {
    this.#scheduler.clearInterval(this.#timer);
    this.#timer = null;
    this.#stopProducers();
    this.#running = false;
    this.#held.clear();
  }

  #tick(): void {
    try {
      const now = this.#now();
      this.#emitLegacy(now);
      for (const held of this.#held.values()) {
        if (now - held.timestamp >= this.#refreshMs) {
          this.#record(held.name, held.value, held.displayId, now);
        }
      }
    } catch (error) {
      this.#onError(error); // a timer must never throw into the host
    }
  }

  #emitLegacy(timestamp: number): void {
    if (this.#sample === undefined) return;
    for (const { name, value } of this.#sample()) this.#record(name, value, undefined, timestamp);
  }

  #record(name: string, value: unknown, displayId: number | undefined, timestamp: number): void {
    this.capture('traces.system', timestamp, {
      timestamp, name, value, ...(displayId !== undefined ? { displayId } : {}),
    });
    this.#held.set(displayId === undefined ? name : `${displayId}:${name}`, { name, value, timestamp, displayId });
  }

  #stopProducers(): void {
    for (const producer of this.#started.splice(0)) this.#safeStop(producer);
  }

  #safeStop(producer: TraceProducer): void {
    try {
      producer.stop();
    } catch (error) {
      this.#onError(error);
    }
  }
}
```

(Mutating `#held` while iterating in `#tick` via `#record` only overwrites existing keys — safe for `Map`; if a linter objects, iterate over `[...this.#held.values()]`.) Keep `createSystemTracesProvider(options)` as is.

- [ ] **Step 4: Run to verify pass** — the whole file (the pre-existing tests are the legacy-compat check) + `tsc --noEmit`.
- [ ] **Step 5: Mutator loop** — back up; mutate: drop the per-producer try/catch in start / in stop; drop `#safeStop` on a failed start; `>=` → `>` in refresh; refresh uses the old timestamp; skip `#held.clear()` on restart; drop the `#running` guard in the sink; swallow the initial-sample throw; remove the tick try/catch; don't clear the timer on stop; refresh ignoring `displayId`. Each must fail; restore.
- [ ] **Step 6: Commit** — `feat(capture): traces provider is a producer container (isolation, last-value refresh), legacy sample kept`.

---

### Task 3: `ProcessStatsTracker` (node) — one timer, shared state

**Files:** Create `packages/node/src/trackers/process-stats-tracker.ts` and `.test.ts`.

**Interfaces:** Consumes `InterceptorBase`, `Scheduler` from `@bugsee/core`. Produces `ProcessStats`, `EventLoopSource`, `ProcessStatsTracker` (see Cross-task interfaces). Reuses the arithmetic of `system-metrics.ts` exactly (same names/formulas) so Task 4's parity test can compare against the legacy sampler.

- [ ] **Step 1: Write the failing tests** (`process-stats-tracker.test.ts`):

```ts
import type { Scheduler } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { type EventLoopSource, type ProcessStats, ProcessStatsTracker } from './process-stats-tracker';

function fakeScheduler() {
  let cb: (() => void) | null = null; let cleared = 0; let sets = 0;
  const scheduler: Scheduler = { setInterval: (c) => { cb = c; sets += 1; return 'h'; }, clearInterval: () => { cleared += 1; } };
  return { scheduler, tick: () => cb?.(), cleared: () => cleared, sets: () => sets };
}
const mem = { rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 };
function mk(over: Partial<ConstructorParameters<typeof ProcessStatsTracker>[0]> = {}) {
  let cpu = { user: 0, system: 0 }; let wall = 0;
  const fs = fakeScheduler();
  const tracker = new ProcessStatsTracker({
    memoryUsage: () => mem, systemMemory: () => ({ total: 100, free: 40 }),
    cpuUsage: () => cpu, cpuCount: () => 2, monotonicNowMs: () => wall,
    scheduler: fs.scheduler, intervalMs: 1000, ...over,
  });
  return { tracker, fs, advance: (c: { user: number; system: number }, w: number) => { cpu = c; wall = w; } };
}

describe('ProcessStatsTracker', () => {
  it('attaches NOTHING at construction (no timer, no sources started)', () => {
    const started: string[] = [];
    const eventLoop: EventLoopSource = { read: () => undefined, start: () => void started.push('start'), stop: () => void started.push('stop') };
    const { fs } = mk({ eventLoop });
    expect(fs.sets()).toBe(0);
    expect(started).toEqual([]);
  });

  it('the first subscriber activates it: one timer + event-loop source started; the last one leaves → released', () => {
    const calls: string[] = [];
    const eventLoop: EventLoopSource = { read: () => undefined, start: () => void calls.push('start'), stop: () => void calls.push('stop') };
    const { tracker, fs } = mk({ eventLoop });
    const off1 = tracker.on('stats', () => {}); const off2 = tracker.on('stats', () => {});
    expect(fs.sets()).toBe(1);
    expect(calls).toEqual(['start']);
    off1();
    expect(fs.cleared()).toBe(0);                 // still one subscriber
    off2();
    expect(fs.cleared()).toBe(1);
    expect(calls).toEqual(['start', 'stop']);
  });

  it('emits stats on each tick with cpu deltas over the wall window (normalized by cores)', () => {
    const { tracker, fs, advance } = mk();
    const got: ProcessStats[] = [];
    tracker.on('stats', (s) => got.push(s));
    advance({ user: 400_000, system: 200_000 }, 1000);      // 600 000 µs busy over 1 000 ms on 2 cores
    fs.tick();
    expect(got).toHaveLength(1);
    expect(got[0]?.memory).toEqual(mem);
    expect(got[0]?.systemMemory).toEqual({ total: 100, free: 40 });
    expect(got[0]?.cpu).toEqual({ userDelta: 400_000, systemDelta: 200_000, processPct: 30 });
  });

  it('current() returns the cached stats and does NOT advance the cpu baseline (shared by many producers)', () => {
    const { tracker, advance } = mk();
    tracker.on('stats', () => {});
    const a = tracker.current(); advance({ user: 500_000, system: 0 }, 1000);
    const b = tracker.current(); const c = tracker.current();
    expect(b).toBe(a); expect(c).toBe(a);          // same object until the next poll
    expect(a.cpu.userDelta).toBe(0);               // baseline: no delta yet
  });

  it('a zero wall window yields processPct 0 (no divide by zero)', () => {
    const { tracker, fs } = mk();
    const got: ProcessStats[] = [];
    tracker.on('stats', (s) => got.push(s));
    fs.tick();                                       // wall unchanged
    expect(got[0]?.cpu.processPct).toBe(0);
  });

  it('includes eventLoop / utilization only when their sources answer (omitted, never zeroed)', () => {
    const { tracker, fs } = mk({
      eventLoop: { read: () => ({ meanMs: 1, maxMs: 2, p99Ms: 3 }), start: () => {}, stop: () => {} },
      eventLoopUtilization: () => undefined,
    });
    const got: ProcessStats[] = [];
    tracker.on('stats', (s) => got.push(s)); fs.tick();
    expect(got[0]?.eventLoop).toEqual({ meanMs: 1, maxMs: 2, p99Ms: 3 });
    expect('utilization' in (got[0] ?? {})).toBe(false);
  });

  it('restart: re-attaches and re-baselines (no stale cache)', () => {
    const { tracker, fs, advance } = mk();
    const off = tracker.on('stats', () => {});
    advance({ user: 1, system: 1 }, 10);
    off();
    tracker.on('stats', () => {});
    expect(fs.sets()).toBe(2);
    expect(tracker.current().cpu.userDelta).toBe(0);
  });

  it('a throwing reader is reported via onError and does not break the timer', () => {
    const errors: unknown[] = [];
    let boom = false;
    const { tracker, fs } = mk({ memoryUsage: () => { if (boom) throw new Error('read boom'); return mem; }, onError: (e) => errors.push(e) });
    const got: ProcessStats[] = [];
    tracker.on('stats', (s) => got.push(s));
    boom = true;
    expect(() => fs.tick()).not.toThrow();
    expect(got).toHaveLength(0);
    expect((errors[0] as Error).message).toBe('read boom');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @bugsee/node exec vitest run src/trackers/process-stats-tracker.test.ts`.
- [ ] **Step 3: Implement** (`process-stats-tracker.ts`):

```ts
import { cpus, freemem, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { InterceptorBase, type Scheduler } from '@bugsee/core';

export interface EventLoopSource {
  /** Mean/max/p99 lag (ms) since the previous read, or undefined when the runtime cannot measure it. */
  read(): { meanMs: number; maxMs: number; p99Ms: number } | undefined;
  start(): void;
  stop(): void;
}
export interface ProcessStats { /* as in Cross-task interfaces */ }

export interface ProcessStatsDeps {
  memoryUsage?: () => ProcessStats['memory'];
  cpuUsage?: () => { user: number; system: number };
  systemMemory?: () => { total: number; free: number };
  cpuCount?: () => number;
  monotonicNowMs?: () => number;
  /** Lazily started on activation, stopped on deactivation. Default: none (lag omitted). */
  eventLoop?: EventLoopSource;
  /** ELU delta 0..1 per call, or undefined when unavailable. Default: none. */
  eventLoopUtilization?: () => number | undefined;
  scheduler?: Scheduler;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

const defaultScheduler: Scheduler = {
  setInterval: (cb, ms) => {
    const h = setInterval(cb, ms);
    (h as { unref?: () => void }).unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export class ProcessStatsTracker extends InterceptorBase<{ stats: ProcessStats }> {
  readonly name = 'node-process-stats';
  readonly #d: Required<Pick<ProcessStatsDeps, 'memoryUsage' | 'cpuUsage' | 'systemMemory' | 'cpuCount' | 'monotonicNowMs' | 'scheduler' | 'intervalMs'>> & ProcessStatsDeps;
  #timer: unknown = null;
  #lastCpu = { user: 0, system: 0 };
  #lastWallMs = 0;
  #cached: ProcessStats | undefined;

  constructor(deps: ProcessStatsDeps = {}) {
    super(deps.onError);
    this.#d = {
      memoryUsage: () => process.memoryUsage(),
      cpuUsage: () => process.cpuUsage(),
      systemMemory: () => ({ total: totalmem(), free: freemem() }),
      cpuCount: () => cpus().length,
      monotonicNowMs: () => performance.now(),
      scheduler: defaultScheduler,
      intervalMs: 1000,
      ...deps,
    };
  }

  /** Latest stats (read once on activation, then replaced on every poll). Safe for many callers. */
  current(): ProcessStats {
    this.#cached ??= this.#read();
    return this.#cached;
  }

  protected onActivate(): void {
    this.#lastCpu = this.#d.cpuUsage();
    this.#lastWallMs = this.#d.monotonicNowMs();
    this.#cached = undefined;
    this.#d.eventLoop?.start();
    this.#timer = this.#d.scheduler.setInterval(() => this.#poll(), this.#d.intervalMs);
  }

  protected override onDeactivate(): void {
    this.#d.scheduler.clearInterval(this.#timer);
    this.#timer = null;
    this.#d.eventLoop?.stop();
    this.#cached = undefined;
  }

  #poll(): void {
    try {
      this.#cached = this.#read();
    } catch (error) {
      this.#d.onError?.(error);
      return;
    }
    this.emit('stats', this.#cached);
  }

  #read(): ProcessStats {
    const memory = this.#d.memoryUsage();
    const systemMemory = this.#d.systemMemory();
    const cpu = this.#d.cpuUsage();
    const nowMs = this.#d.monotonicNowMs();
    const userDelta = cpu.user - this.#lastCpu.user;
    const systemDelta = cpu.system - this.#lastCpu.system;
    const wallMsDelta = nowMs - this.#lastWallMs;
    this.#lastCpu = cpu;
    this.#lastWallMs = nowMs;
    const processPct = wallMsDelta > 0 ? ((userDelta + systemDelta) / (wallMsDelta * 1000) / this.#d.cpuCount()) * 100 : 0;
    const eventLoop = this.#d.eventLoop?.read();
    const utilization = this.#d.eventLoopUtilization?.();
    return {
      memory, systemMemory, cpu: { userDelta, systemDelta, processPct },
      ...(eventLoop !== undefined ? { eventLoop } : {}),
      ...(utilization !== undefined ? { utilization } : {}),
    };
  }
}
```

Note the first-call baseline in the "current() does not advance" test: `onActivate` reads the CPU baseline, then `current()` performs the first `#read()` with `userDelta` 0 only if `cpuUsage()` is unchanged between activation and the call — the test advances **after** the first `current()`, which is what it asserts.

- [ ] **Step 4: Run to verify pass** + `tsc --noEmit` for `@bugsee/node`.
- [ ] **Step 5: Mutator loop** — mutate: start the timer in the constructor; never call `eventLoop.stop()`; `current()` re-reads each call; keep `#cached` across deactivate; drop `?? ` baseline reset in `onActivate`; divide by 1000 only; ignore `onError`; emit before caching; omit the `utilization` guard (always include). Restore each.
- [ ] **Step 6: Commit** — `feat(node): ProcessStatsTracker — one timer, shared state, lazy event-loop source`.

---

### Task 4: Guarded event-loop sources + node producers + factory

**Files:** Create `packages/node/src/trackers/guarded-event-loop.ts` (+ test), `packages/node/src/trace-producers.ts` (+ test); modify `packages/node/src/index.ts` (exports).

**Interfaces:** Consumes `ProcessStatsTracker`, `EventLoopSource` (Task 3), `TraceProducerBase` (Task 1). Produces `createNodeSystemTraceProducers(deps?: NodeTraceProducerDeps): TraceProducer[]` where `NodeTraceProducerDeps extends ProcessStatsDeps { perfHooks?: PerfHooks; measuresEventLoopDelay?: boolean }`.

- [ ] **Step 1: Write the failing tests.**

`guarded-event-loop.test.ts` — move/adapt the guard logic and tests from `guarded-system-metrics.ts` (`guardedEventLoop`, `guardedElu`, `eluUnavailable` semantics): with a fake `perfHooks`: (a) construction calls neither `monitorEventLoopDelay` nor `enable`; (b) `start()` constructs + enables once, idempotent; `stop()` disables, `?.disable?.()` tolerated when absent; restart reuses the histogram; (c) `read()` before `start()` → `undefined`; after → `{meanMs, maxMs, p99Ms}` in ms and resets the histogram; (d) a throwing `monitorEventLoopDelay` / `enable` → `start()` does not throw and `read()` stays `undefined`; (e) `createGuardedElu(elu)` → `undefined` when idle and active are both 0 (Bun/Deno), the utilization delta otherwise, `undefined` when it throws. (Write them in full with the same `fakePerfHooks` helper shape as `guarded-system-metrics.test.ts`; `lagMs` conversion: `mean 2e6` ns → 2 ms.)

`trace-producers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createNodeSystemTraceProducers } from './trace-producers';
import { createNodeSystemMetricsSampler } from './system-metrics';

// Collect what a producer set emits for one tick, via a recording sink.
function runOnce(deps: Parameters<typeof createNodeSystemTraceProducers>[0]) {
  const got = new Map<string, unknown>();
  let tick: (() => void) | undefined;
  const producers = createNodeSystemTraceProducers({ ...deps, scheduler: { setInterval: (cb) => ((tick = cb), 'h'), clearInterval: () => {} } });
  for (const p of producers) p.start({ emit: (n, v) => void got.set(n, v) });
  tick?.();
  return { got, producers, stopAll: () => producers.forEach((p) => p.stop()) };
}
const baseDeps = (over = {}) => ({
  memoryUsage: () => ({ rss: 10, heapTotal: 20, heapUsed: 30, external: 40, arrayBuffers: 50 }),
  systemMemory: () => ({ total: 1000, free: 400 }),
  cpuUsage: (() => { let u = 0; return () => ({ user: (u += 100_000), system: (u += 100_000) }); })(),
  cpuCount: () => 2, monotonicNowMs: (() => { let w = 0; return () => (w += 1000); })(),
  ...over,
});

describe('createNodeSystemTraceProducers', () => {
  it('emits the SAME trace names and values as the legacy sampler (parity)', () => {
    const { got } = runOnce(baseDeps({ eventLoop: { read: () => ({ meanMs: 1, maxMs: 2, p99Ms: 3 }), start: () => {}, stop: () => {} }, eventLoopUtilization: () => 0.5 }));
    expect([...got.keys()].sort()).toEqual([
      'cpu_usage_process', 'cpu_usage_system', 'cpu_usage_user', 'event_loop_lag_max_ms', 'event_loop_lag_ms',
      'event_loop_lag_p99_ms', 'event_loop_utilization', 'process_memory_array_buffers', 'process_memory_external',
      'process_memory_heap_total', 'process_memory_heap_used', 'process_memory_rss', 'ram_system_free', 'ram_system_total',
    ]);
    expect(got.get('process_memory_rss')).toBe(10);
    expect(got.get('ram_system_total')).toBe(1000);
    expect(got.get('event_loop_lag_max_ms')).toBe(2);
    expect(got.get('event_loop_utilization')).toBe(0.5);
  });
  // …
});
```

(Add the real parity check to this test: build the legacy sampler with the **same** injected readers, call it once, and assert the producers' tick values equal the legacy sampler's values name-for-name — the legacy sampler's first call and the tracker's first poll see the same reader sequence only if the readers are deterministic counters; use fixed readers returning constant deltas to make this exact.) Further tests: omitted — with no `eventLoop` source the three lag traces and `event_loop_utilization` are absent; `measuresEventLoopDelay: false` → no histogram is ever constructed (fake perfHooks counts `monitor`), lag absent, `event_loop_utilization` still present when ELU answers; **gate** — creating the producers constructs no histogram and starts no timer (`setInterval` spy not called) until `start`; after `stopAll()` the histogram is disabled and the interval cleared; **shared tracker** — three producers starting does not triple the CPU baseline (the first tick's `cpu_usage_user` delta equals one window, not three); a restart re-emits the baseline.

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `guarded-event-loop.ts`: export `createGuardedEventLoopSource(monitor)`, `createGuardedElu(elu)`, `eluUnavailable` re-exported from `system-metrics` (do not duplicate), and `PerfHooks`/`realPerfHooks` — code per the previous design:

```ts
export function createGuardedEventLoopSource(monitor: () => DelayHistogram): EventLoopSource {
  let histogram: DelayHistogram | undefined;
  let unusable = false;
  return {
    start() {
      if (unusable) return;
      try { histogram ??= monitor(); histogram.enable(); histogram.reset(); }
      catch { unusable = true; histogram = undefined; }   // a partial runtime must not abort SDK startup
    },
    stop() { try { histogram?.disable?.(); } catch { /* best-effort */ } },
    read() {
      if (histogram === undefined) return undefined;       // not started → omit, never zero
      try {
        const out = { meanMs: lagMs(histogram.mean), maxMs: lagMs(histogram.max), p99Ms: lagMs(histogram.percentile(99)) };
        histogram.reset(); return out;
      } catch { return undefined; }
    },
  };
}
```

`trace-producers.ts`: five `TraceProducerBase` subclasses, each constructed with the shared tracker:

```ts
abstract class StatsProducer extends TraceProducerBase {
  #off: (() => void) | undefined;
  constructor(protected readonly tracker: ProcessStatsTracker) { super(); }
  protected abstract publish(stats: ProcessStats): void;
  protected onStart(): void {
    this.#off = this.tracker.on('stats', (s) => this.publish(s));   // subscribing activates the tracker
    this.publish(this.tracker.current());                            // baseline
  }
  protected override onStop(): void { this.#off?.(); this.#off = undefined; }
}
class ProcessMemoryProducer extends StatsProducer { readonly name = 'process-memory'; protected publish(s: ProcessStats) { this.emit('process_memory_rss', s.memory.rss); /* heap_total, heap_used, external, array_buffers */ } }
class SystemMemoryProducer extends StatsProducer { /* ram_system_total, ram_system_free */ }
class CpuProducer extends StatsProducer { /* cpu_usage_user, cpu_usage_system, cpu_usage_process */ }
class EventLoopLagProducer extends StatsProducer { /* event_loop_lag_ms, _max_ms, _p99_ms — only when s.eventLoop !== undefined */ }
class EventLoopUtilizationProducer extends StatsProducer { /* event_loop_utilization — only when s.utilization !== undefined */ }

export interface NodeTraceProducerDeps extends ProcessStatsDeps { perfHooks?: PerfHooks; measuresEventLoopDelay?: boolean }
export function createNodeSystemTraceProducers(deps: NodeTraceProducerDeps = {}): TraceProducer[] {
  const { perfHooks, measuresEventLoopDelay = true, ...rest } = deps;
  const perf = perfHooks ?? realPerfHooks;
  const tracker = new ProcessStatsTracker({
    eventLoop: measuresEventLoopDelay ? createGuardedEventLoopSource(perf.monitorEventLoopDelay) : undefined,
    eventLoopUtilization: createGuardedElu(perf.eventLoopUtilization),
    ...rest,          // an explicit caller-supplied reader wins over the guarded default
  });
  return [new ProcessMemoryProducer(tracker), new SystemMemoryProducer(tracker), new CpuProducer(tracker), new EventLoopLagProducer(tracker), new EventLoopUtilizationProducer(tracker)];
}
```

(`eventLoop: undefined` must be omitted rather than set when the flag is off — with `exactOptionalPropertyTypes` build the object with a conditional spread.) Export `createNodeSystemTraceProducers`, `NodeTraceProducerDeps`, `ProcessStatsTracker`, `type ProcessStats`, `type EventLoopSource` from `packages/node/src/index.ts`. The ELU baseline stays at tracker construction inside `createGuardedElu` (a value, not a resource).

- [ ] **Step 4: Run to verify pass + typecheck.**
- [ ] **Step 5: Mutator loop** — mutate: construct the histogram at factory time (gate test); `measuresEventLoopDelay` ignored; emit lag when `eventLoop` undefined (zeros); producers not unsubscribing in `stop`; `current()` replaced by a direct read (triple-advance test); skip `start()` of the source; emit a utilization 0 when undefined. Restore each.
- [ ] **Step 6: Commit** — `feat(node): node trace producers over ProcessStatsTracker; guarded lazy event-loop source`.

---

### Task 5: Wire node / Bun / Deno launch

**Files:** Modify `packages/node/src/launch.ts` (option `systemTraceProducers?: readonly TraceProducer[]`, import line ~8, wiring ~865), `packages/bun/src/launch.ts`, `packages/deno/src/launch.ts`; tests `node/src/launch.test.ts`, `bun/src/launch.test.ts`, `deno/src/launch.test.ts`.

- [ ] **Step 1: Write the failing tests.** In `node/src/launch.test.ts` (reusing `baseOptions`, `launchTracked`, `fakeScheduler`, `memStore`, `fixedClock`):

```ts
it('the default producers attach nothing when captureSystemTraces is false, and release everything on stop()', async () => {
  const fs = fakeScheduler(); const monitorCalls: string[] = [];
  const perfHooks = { monitorEventLoopDelay: () => (monitorCalls.push('monitor'), { enable: () => void monitorCalls.push('enable'), disable: () => void monitorCalls.push('disable'), reset() {}, mean: 0, max: 0, percentile: () => 0 }), eventLoopUtilization: () => ({ utilization: 0, idle: 1, active: 0 }) };
  const off = launchTracked('tok', baseOptions({ captureStore: memStore(), clock: fixedClock, scheduler: fs.scheduler, captureSystemTraces: false, systemTraceProducers: createNodeSystemTraceProducers({ perfHooks, scheduler: fs.scheduler }) }));
  expect(monitorCalls).toEqual([]);
  await off.stop();
  expect(monitorCalls).toEqual([]);
  const on = launchTracked('tok', baseOptions({ captureStore: memStore(), clock: fixedClock, scheduler: fs.scheduler, systemTraceProducers: createNodeSystemTraceProducers({ perfHooks, scheduler: fs.scheduler }) }));
  expect(monitorCalls).toEqual(['monitor', 'enable']);
  await on.stop();
  expect(monitorCalls.at(-1)).toBe('disable');
});

it('a legacy systemMetricsSampler still wins when supplied (back-compat for existing injectors)', () => {
  const client = launchTracked('tok', baseOptions({ captureStore: memStore(), systemMetricsSampler: () => [{ name: 'x', value: 1 }] }));
  expect(client.isLaunched()).toBe(true);
});

it('routes a throwing producer to onError and still launches', () => {
  const onError = vi.fn();
  const bad: TraceProducer = { name: 'bad', start: () => { throw new Error('p boom'); }, stop: () => {} };
  const client = launchTracked('tok', baseOptions({ captureStore: memStore(), onError, systemTraceProducers: [bad] }));
  expect(client.isLaunched()).toBe(true);
  expect((onError.mock.calls[0]?.[0] as Error).message).toBe('p boom');
});
```

In `bun/src/launch.test.ts` and `deno/src/launch.test.ts` (both `vi.mock('@bugsee/node', …)` with a pass-through spy — change the spied function to `createNodeSystemTraceProducers`): Deno pins `toHaveBeenCalledWith(expect.objectContaining({ measuresEventLoopDelay: false }))`; Bun pins it was called with no `measuresEventLoopDelay: false`. Both also assert the injected `systemTraceProducers` is a non-empty array of objects with `start`/`stop`.

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `node/src/launch.ts`:

```ts
/** Trace producers (each subscribes to trackers; the provider starts/stops them). Default: the node set. */
systemTraceProducers?: readonly TraceProducer[];
```

```ts
client.addCaptureProvider(
  createSystemTracesProvider({
    ...(options.systemMetricsSampler !== undefined
      ? { sample: options.systemMetricsSampler }              // legacy injector wins (tests)
      : { producers: options.systemTraceProducers ?? createNodeSystemTraceProducers() }),
    refreshMs: Math.min(10_000, Math.max(1_000, (maxRecordingTime * 1000) / 4)),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
    ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
  }),
);
```

(`maxRecordingTime` is the seconds value already in scope at `launch.ts:657`; confirm the variable is visible at line ~865, else compute `refreshMs` beside it.) `bun/src/launch.ts`: replace `systemMetricsSampler: createGuardedSystemMetricsSampler()` with `systemTraceProducers: createNodeSystemTraceProducers()`; `deno/src/launch.ts`: `systemTraceProducers: createNodeSystemTraceProducers({ measuresEventLoopDelay: false })`, keeping the existing explanatory comment about Deno's histogram. Both stay **before** `...options` (same position as today).

- [ ] **Step 4: Run to verify pass** — `pnpm --filter @bugsee/node exec tsc --noEmit && … vitest run` for node, bun, deno.
- [ ] **Step 5: Mutator loop** — mutate: provider always given `sample` (producers ignored); `refreshMs` omitted; Deno flag dropped; `onError` not forwarded. Restore.
- [ ] **Step 6: Real-runtime check** — `pnpm test:e2e`: the uploaded bundle has `event_loop_lag_*` on node and bun, none on deno; `ram_*`/`process_memory_*`/`cpu_usage_*` present on all three. This is the regression the whole design guards.
- [ ] **Step 7: Commit** — `feat(node,bun,deno): launch wires trace producers; Deno opts out of event-loop lag`.

---

### Task 6: Browser — `BatteryTracker`, `BatteryProducer`, the `charging` fix

**Files:** Create `packages/browser/src/trackers/battery-tracker.ts` (+ test), `packages/browser/src/trace-producers.ts` (+ test); modify `system-trace-values.ts` (+ test), `system-metrics.ts` (+ test), `browser/src/launch.ts`, `webview/src/launch.ts` (+ tests), `browser/src/index.ts`.

- [ ] **Step 1: Write the failing tests.**

`system-trace-values.test.ts` — `chargingToWire`: not charging → `{state: 1}`; charging at 0.5 and 0.99 → `{state: 2}`; charging at 1 → `{state: 3}`; never a `source` key, never `0`.

`battery-tracker.test.ts`:

```ts
function mkManager(level = 0.5, charging = false) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    level, charging,
    addEventListener: (t: string, l: () => void) => { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(l); },
    removeEventListener: (t: string, l: () => void) => void listeners.get(t)?.delete(l),
    fire: (t: string) => listeners.get(t)?.forEach((l) => l()),
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}
```

Cases: construction never calls `getBattery`; first subscriber calls it once (a second subscriber does not); resolve → listeners attached for `levelchange`+`chargingchange` and a `state` event emitted with the current `{level, charging}`; `fire('levelchange')` emits the new state; last unsubscribe removes both listeners; **stop before resolve → the late resolve attaches nothing and emits nothing**; **stop → start → old promise resolves late → ignored, the new one applies**; a rejecting or synchronously-throwing `getBattery` → no throw, no event; a manager without `addEventListener` (older shape) still emits the one baseline; `current()` is `undefined` before resolve and the latest state after, and `undefined` again after deactivation.

`trace-producers.test.ts`: `BatteryProducer` emits `battery` (`Math.round(level*100)`) and `charging` (`chargingToWire`) as the baseline once the manager resolves, then only on change (de-dup: a `levelchange` with an unchanged rounded level emits nothing for `battery`); `createBrowserSystemTraceProducers({ getBattery })` constructs nothing at call time (no `getBattery` call); started via a provider with `captureSystemTraces:false` → `getBattery` not called.

`system-metrics.test.ts`: delete the battery/charging expectations (they move to the producer); add one test that the legacy sampler no longer calls `getBattery` at all.

- [ ] **Step 2: Run to verify failure** (`pnpm --filter @bugsee/browser exec vitest run`).
- [ ] **Step 3: Implement.**

```ts
// battery-tracker.ts
export interface BatteryManagerLike {
  level: number; charging: boolean;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}
export interface BatteryState { level: number; charging: boolean }
export interface BatteryEnv { getBattery?: () => Promise<BatteryManagerLike> }

export class BatteryTracker extends InterceptorBase<{ state: BatteryState }> {
  readonly name = 'browser-battery';
  readonly #env: BatteryEnv;
  #generation = 0;
  #manager: BatteryManagerLike | undefined;
  #state: BatteryState | undefined;
  readonly #onChange = (): void => this.#publish();

  constructor(env: BatteryEnv, onError?: (e: unknown) => void) { super(onError); this.#env = env; }

  current(): BatteryState | undefined { return this.#state; }

  protected onActivate(): void {
    const mine = ++this.#generation;
    try {
      this.#env.getBattery?.().then(
        (manager) => {
          if (this.#generation !== mine) return;          // stopped (or restarted) while in flight
          this.#manager = manager;
          manager.addEventListener?.('levelchange', this.#onChange);
          manager.addEventListener?.('chargingchange', this.#onChange);
          this.#publish();
        },
        () => {},                                           // unsupported / denied → no battery traces
      );
    } catch { /* a synchronous SecurityError just means no battery traces */ }
  }

  protected override onDeactivate(): void {
    this.#generation += 1;                                  // invalidate any in-flight fetch
    this.#manager?.removeEventListener?.('levelchange', this.#onChange);
    this.#manager?.removeEventListener?.('chargingchange', this.#onChange);
    this.#manager = undefined;
    this.#state = undefined;
  }

  #publish(): void {
    if (this.#manager === undefined) return;
    this.#state = { level: this.#manager.level, charging: this.#manager.charging };
    this.emit('state', this.#state);
  }
}
```

`chargingToWire` in `system-trace-values.ts`:

```ts
/** The viewer's `charging` table is keyed by the Android/iOS ints (0 unknown, 1 unplugged, 2 charging, 3 full) and
 *  `processCharging` takes an int or `{state}`. A boolean never matched (false is dropped by a falsy guard; true looks up
 *  states["true"]), so the old trace rendered nothing. `source` is omitted: the Battery API cannot say AC/USB/wireless. */
export function chargingToWire(b: { charging: boolean; level: number }): { state: 1 | 2 | 3 } {
  if (!b.charging) return { state: 1 };
  return { state: b.level >= 1 ? 3 : 2 };
}
```

`trace-producers.ts`:

```ts
class BatteryProducer extends TraceProducerBase {
  readonly name = 'battery';
  #off: (() => void) | undefined;
  constructor(private readonly tracker: BatteryTracker) { super(); }
  protected onStart(): void {
    this.#off = this.tracker.on('state', (s) => this.#publish(s));
    const cur = this.tracker.current();
    if (cur !== undefined) this.#publish(cur);
  }
  protected override onStop(): void { this.#off?.(); this.#off = undefined; }
  #publish(s: BatteryState): void {
    this.emitIfChanged('battery', Math.round(s.level * 100));   // 0-1 → 0-100 (Android parity)
    this.emitIfChanged('charging', chargingToWire(s));
  }
}
export function createBrowserSystemTraceProducers(env: BatteryEnv = realBatteryEnv()): TraceProducer[] {
  return [new BatteryProducer(new BatteryTracker(env))];
}
```

(`realBatteryEnv()` reads `globalThis.navigator` lazily and binds `getBattery` — `{ getBattery: () => nav.getBattery() }` when present, else `{}`.) In `system-metrics.ts` delete the `getBattery` fetch, the `battery` variable, and the two battery samples; update the header comment (battery is now a tracker-backed producer). `browser/src/launch.ts` (~797) and `webview/src/launch.ts` (~672): `createSystemTracesProvider({ sample: options.systemMetricsSampler ?? createBrowserSystemTracesSampler(), producers: createBrowserSystemTraceProducers(), refreshMs: …, onError })`; widen nothing else (the public `systemMetricsSampler` option stays a function). Export `createBrowserSystemTraceProducers` and `chargingToWire` from `browser/src/index.ts`.

- [ ] **Step 4: Run to verify pass + typecheck** — `pnpm --filter @bugsee/browser exec tsc --noEmit && … vitest run`, same for `@bugsee/webview`. Also `grep -rn "charging" packages/*/src e2e` and fix any other assertion on the boolean.
- [ ] **Step 5: Mutator loop** — mutate: `getBattery` in the constructor; drop `generation !== mine`; drop the generation bump in `onDeactivate`; skip removing listeners; `>= 1` → `> 1`; `>= 0.99`; swap states 1/2; add `source`; emit instead of `emitIfChanged`; baseline skipped when `current()` is set; drop the sync try/catch. Restore each.
- [ ] **Step 6: Commit** — `feat(browser,webview): BatteryTracker + BatteryProducer (event-driven, abortable); charging is { state }`.

---

### Task 7: Gates, record, review, PR

- [ ] **Step 1:** `pnpm ci:local` green (lint → typecheck → cycles → per-package coverage → e2e). Fix coverage by adding tests, never by lowering a threshold. `pnpm check:cycles` matters here: trackers live in platform packages and import only `@bugsee/core` / `@bugsee/capture`.
- [ ] **Step 2:** Add a paragraph to `docs/PROGRESS.md` (traces section): "ST0′: trace producers + trackers; provider is a producer container with last-value refresh; node `ProcessStatsTracker` (+ guarded lazy event-loop source) and browser `BatteryTracker` are the first chains; legacy `sample` remains for the rest; `charging` is `{state}`." Commit `docs: record ST0′`.
- [ ] **Step 3:** Convergent multi-agent review (`docs/implementation-standards.md` §7) over the branch diff, one agent per concern: (a) provider container + refresh correctness, (b) tracker lifecycle and subscriber-presence activation/restart, (c) Bun/Deno honesty and gate wiring, (d) browser battery abort + `charging`, (e) tests (outcomes asserted, mutations die). Agents are read-only and cite `file:line`. Triage, fix real findings test-first, repeat with a **fresh** review until a round yields zero new real findings.
- [ ] **Step 4:** `gh pr create --draft --base main --title "feat(capture,node,browser): trace producers over shared trackers (ST0′) + charging fix"` — body: summary of Tasks 1–6, link to the design doc (PR #53) incl. §14, test evidence (`pnpm ci:local`, e2e on node/bun/deno), the Review Focus list with the test pinning each item.

---

## Follow-on slices (not in this plan)

| Slice | Content |
|---|---|
| ST0′-B | Browser trackers for the rest of the legacy sampler: memory (`performance.memory`), connection (`online`/`offline` + `connection.change`, `onLine`-first mapper kept), orientation, device memory — then delete the legacy browser sampler |
| ST0′-C | Shared `PageLifecycleTracker` (visibility / `pagehide` / `freeze` / `resume`) bound to the injected window+document, subscribed by BOTH the system-events source and the traces producers (`app_state`, later `fps`/`main_thread_lag_ms` gating) — removes the duplicated `visibilitychange` wiring |
| ST0′-D | Delete the legacy `createNodeSystemMetricsSampler` / `createGuardedSystemMetricsSampler` (DONE); the `sample` / `systemMetricsSampler` option is kept as a caller-supplied override because tests and callers still inject it |
| ST1+ | New traces from the design doc as producers on these trackers (V8 heap, GC observer, disk, `process_memory_limit`, …) with their `measures*` flags on `NodeTraceProducerDeps` |
| ST6 | Electron trackers (`app`, `powerMonitor`, `screen`) subscribed by Electron producers and the events source — no wrapping of the node sampler |

## Self-Review

**Spec coverage:** structure (§14) → Tasks 1–6; gate-by-subscriber-presence (§5 lifecycle seam, round-2–9 findings) → Tasks 3, 4, 5, 6 and Review Focus 1/4/5/6; Bun/Deno honesty flags on tracker/factory deps → Tasks 4–5; `charging` (§13.4) → Task 6; rolling-window parity (mobile snapshot-on-part-switch) → Task 2 refresh. **Out of this plan by design:** the remaining browser/Electron/page-lifecycle migrations (follow-on table), new traces (ST1+), viewer/specs PRs.

**Placeholder scan:** two spots are explicitly marked "replace with…" inside tests (the legacy-parity helper in Task 4 and the `guarded-event-loop` test list, which is "port the existing guarded tests"); both name the exact source to port from and the assertion required. No TBD/TODO.

**Type consistency:** `TraceSink.emit(name, value, displayId?)`, `TraceProducer{name,start,stop}`, `TraceProducerBase.emit/emitIfChanged`, `ProcessStats`, `EventLoopSource{read,start,stop}`, `ProcessStatsTracker.current()`, `BatteryTracker.current()`, `chargingToWire`, `createNodeSystemTraceProducers`, `createBrowserSystemTraceProducers` are used with identical names in every task.

**Risks to watch:** (1) `InterceptorBase`'s `emit`/`onActiveChange` come from `MultiKeyEmitterBase` — confirm `emit` is public/protected as used (`this.emit(...)` is how the existing sources call it); (2) subscribing a tracker listener from a producer inside the provider's `onStart` activates the tracker synchronously — the baseline `current()` call right after relies on that; (3) `Map` mutation while iterating in `#tick` (see note in Task 2); (4) all runtime facts are macOS-measured — Task 5 Step 6 (real-runtime e2e) is the confirmation on node/bun/deno.
