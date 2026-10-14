# ST0 — Sampler Lifecycle Seam + `charging` Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `traces.system` platform samplers an explicit `{start, stop, sample}` lifecycle owned by the traces provider (so standing resources attach only when `captureSystemTraces` is on and are released on `stop()`), migrate the two pieces of factory-time work that already violate that rule (the node/Bun/Deno delay histogram and the browser `getBattery()` fetch), and fix the shipped `charging` trace so the viewer can render it.

**Architecture:** `@bugsee/capture` defines `LifecycleSampler` and a `SystemTracesSampler = (() => samples) | LifecycleSampler` union; `createSystemTracesProvider` accepts the union, wraps a bare function as sample-only, and calls `start()` at the top of `onStart` and `stop()` in `onStop` — i.e. only after the coordinator's `captureSystemTraces` gate. The three platform factories (`createNodeSystemMetricsSampler`, `createGuardedSystemMetricsSampler`, `createBrowserSystemTracesSampler`) stop returning bare functions and return `LifecycleSampler` objects; the launch files only *pass the object through*. No new traces are added in ST0.

**Tech Stack:** TypeScript (`module: ESNext`, `verbatimModuleSyntax`), Vitest, pnpm + turbo, Biome. Runtimes: Node ≥18, Bun, Deno, browsers.

**Spec:** `docs/design/system-traces-expansion.md` (PR #53 — read it first). Relevant sections: §5 *Lifecycle seam* and *Per-runtime gates*, §9 ST0, §12 items 1/5 (only item 5 is in ST0), §13.4 (`charging`), §13.5. This plan file lives on its own branch off `main`, so the spec file is only present once PR #53 merges; until then read it from that branch.

## Global Constraints

- **Coverage gate per package:** 100% line / function / statement, ≥ 90% branch (vitest v8). Unreachable code needs an explicit `/* v8 ignore … */` with a one-line justification.
- **Test-first, mutator loop (`docs/implementation-standards.md` §2):** for every new/changed method write the failing test, implement, then inject up to 10 different bugs into the new code, confirm the test fails each time, and **roll back by restoring a saved copy (`cp`), never `git checkout`**. Never commit a mutation.
- **Typecheck is separate from tests:** vitest does not typecheck. Run `pnpm --filter @bugsee/<pkg> exec tsc --noEmit` before every commit.
- **Gate before pushing:** `pnpm ci:local` (not just `pnpm test`).
- **Shared tiers are runtime-portable:** `@bugsee/capture` and `@bugsee/core` never import `node:*` or DOM types; reach globals only through `globalThis as unknown as {…}` casts.
- **Never fabricate a reading** (CLAUDE.md, ELU/lag precedents): when a source cannot answer, the trace is **omitted**, never zeroed.
- **Bun/Deno honesty:** "the call succeeded" is not evidence. The Bun/Deno default sampler must be a real lifecycle object, never a bare function that a `typeof === 'function'` adapter would silently turn into a no-op `start()` (which would leave `event_loop_lag_*` at the idle floor through a stall).
- **Wire shape:** the `charging` trace becomes `{ state: 1 | 2 | 3 }` (viewer table keys `"0"`–`"3"`: unknown, unplugged, charging, full), `source` **omitted, never invented**. `environment.hardware.charging` stays a boolean — do not touch it.
- **Branching:** this work is reviewed as a PR (the design was). Create `feat/st0-lifecycle-sampler` from `main`; one commit per task; open a draft PR after Task 2 and push as you go. Attribution line on every commit/PR: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Review Focus

The input classes the spec implies but a straight reading of the tasks would not exercise (each is pinned by a named test in the owning task):

1. **`sampler.start()` throws, or the first `sample()` throws, inside `onStart`** → the provider must stop the sampler before rethrowing, or a half-started sampler leaks. (Task 1, test "stops the sampler when the initial emit throws".)
2. **`captureSystemTraces: false`** → no histogram is created and no `getBattery()` call is made, through the *real* launch + provider path, for both the node-default and the Bun/Deno guarded sampler. (Task 4, Task 5.)
3. **Start → stop → start (provider cycled across launches)** → the sampler re-attaches and re-releases; no double-enable, no stale battery. (Tasks 1, 2, 3, 5.)
4. **`getBattery()` resolves *after* `stop()`** → the late fulfilment must not cache the manager or surface battery traces. (Task 5.)
5. **`sample()` called before `start()`** (a stub provider, a future caller) → lag traces omitted, not zeroed; no throw. (Tasks 2, 3.)
6. **Bun/Deno wrap hazard** → the default sampler passed through `@bugsee/{bun,deno}` is an object with real `start`/`stop`, and with traces on it enables the histogram exactly once after provider start. (Task 4.)
7. **`charging` at the edges** → `level === 1` while charging is `full` (3), `0.99` is `charging` (2), not charging is `unplugged` (1), and a viewer-unknown state is never emitted. (Task 6.)

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `packages/capture/src/system-traces-provider.ts` | modify | `LifecycleSampler`, `SystemTracesSampler`, `asLifecycleSampler`; provider owns `start()`/`stop()` |
| `packages/capture/src/system-traces-provider.test.ts` | modify | provider lifecycle tests |
| `packages/capture/src/index.ts` | modify | export the new types/helper |
| `packages/node/src/system-metrics.ts` | modify | `EventLoopSource`; node sampler returns `LifecycleSampler`; lazy histogram |
| `packages/node/src/system-metrics.test.ts` | modify | adapt `()` → `.sample()`; lifecycle tests |
| `packages/node/src/guarded-system-metrics.ts` | modify | `guardedEventLoop` returns an `EventLoopSource`; defer `monitor()`+`enable()` to `start()`; guarded factory returns `LifecycleSampler` |
| `packages/node/src/guarded-system-metrics.test.ts` | modify | adapt call sites; lifecycle tests |
| `packages/node/src/launch.ts` | modify | widen `systemMetricsSampler` option type |
| `packages/node/src/launch.test.ts` | modify | end-to-end option-gate tests with the guarded sampler |
| `packages/bun/src/launch.test.ts`, `packages/deno/src/launch.test.ts` | modify | pin that the injected default is a lifecycle object |
| `packages/browser/src/system-metrics.ts` | modify | sampler returns `LifecycleSampler`; `getBattery()` moves to `start()` with an abort token |
| `packages/browser/src/system-metrics.test.ts` | modify | adapt call sites; lifecycle + late-resolve tests |
| `packages/browser/src/system-trace-values.ts` (+ `.test.ts`) | modify | `chargingToWire` |
| `packages/browser/src/launch.ts`, `packages/webview/src/launch.ts` | modify | widen the option type |
| `packages/browser/src/launch.test.ts`, `packages/webview/src/launch.test.ts` | modify | option-gate tests |
| `docs/PROGRESS.md` | modify | one-paragraph record |

`packages/bun/src/launch.ts` and `packages/deno/src/launch.ts` need **no code change** (they already inject `createGuardedSystemMetricsSampler(...)`; the return type widens underneath them).

## Cross-task interfaces (defined once, used by every task)

```ts
// @bugsee/capture  (Task 1)
export interface LifecycleSampler {
  /** Attach every standing resource (histogram, observer, listener). Called by the provider's onStart, after the captureSystemTraces gate. Idempotent. */
  start(): void;
  /** Release everything start() attached. Idempotent; a no-op before start(). */
  stop(): void;
  /** Read current samples synchronously. Must be safe to call before start() (omit what is not yet attached). */
  sample(): readonly TraceSample[];
}
export type SystemTracesSampler = (() => readonly TraceSample[]) | LifecycleSampler;
export function asLifecycleSampler(sampler: SystemTracesSampler): LifecycleSampler;

// @bugsee/node  (Task 2)
export interface EventLoopSource {
  read: () => { meanMs: number; maxMs: number; p99Ms: number } | undefined;
  start(): void;
  stop(): void;
}
// NodeSystemMetricsDeps.eventLoop?: EventLoopReader | EventLoopSource   (function form = no lifecycle)
// createNodeSystemMetricsSampler(deps?): LifecycleSampler
// createGuardedSystemMetricsSampler(deps?): LifecycleSampler
// @bugsee/browser (Task 5)
// createBrowserSystemTracesSampler(env?): LifecycleSampler
// @bugsee/browser (Task 6)
// chargingToWire(battery: { charging: boolean; level: number }): { state: 1 | 2 | 3 }
```

---

### Task 1: Provider owns the sampler lifecycle (`@bugsee/capture`)

**Files:**
- Modify: `packages/capture/src/system-traces-provider.ts`
- Modify: `packages/capture/src/index.ts` (add exports next to the existing `createSystemTracesProvider` block at line ~64)
- Test: `packages/capture/src/system-traces-provider.test.ts`

**Interfaces:**
- Produces: `LifecycleSampler`, `SystemTracesSampler`, `asLifecycleSampler`, and `SystemTracesProviderOptions.sample: SystemTracesSampler` (was `() => readonly TraceSample[]`).

- [ ] **Step 1: Write the failing tests** — append to `system-traces-provider.test.ts` (the file already imports `createSystemTracesProvider`, `fakeScheduler`, `buildInit`, `mkStore`, `options`, `drainSystem`; extend the import line to `import { asLifecycleSampler, createSystemTracesProvider, type LifecycleSampler, type TraceSample } from './system-traces-provider';`):

```ts
// A recording lifecycle sampler: `calls` is the order start/sample/stop were invoked in.
function recordingSampler(samples: TraceSample[] = []): { sampler: LifecycleSampler; calls: string[] } {
  const calls: string[] = [];
  const sampler: LifecycleSampler = {
    start: () => void calls.push('start'),
    stop: () => void calls.push('stop'),
    sample: () => {
      calls.push('sample');
      return samples;
    },
  };
  return { sampler, calls };
}

describe('asLifecycleSampler', () => {
  it('wraps a bare function as a sample-only sampler (start/stop are no-ops)', () => {
    const fn = (): TraceSample[] => [{ name: 'a', value: 1 }];
    const wrapped = asLifecycleSampler(fn);
    expect(() => {
      wrapped.start();
      wrapped.stop();
    }).not.toThrow();
    expect(wrapped.sample()).toEqual([{ name: 'a', value: 1 }]);
  });

  it('returns a lifecycle object unchanged (same reference)', () => {
    const { sampler } = recordingSampler();
    expect(asLifecycleSampler(sampler)).toBe(sampler);
  });
});

describe('createSystemTracesProvider — sampler lifecycle', () => {
  it('starts the sampler BEFORE the initial sample, and stops it on provider stop', () => {
    const fs = fakeScheduler();
    const { sampler, calls } = recordingSampler();
    const p = createSystemTracesProvider({ sample: sampler, scheduler: fs.scheduler });
    p.init(buildInit(mkStore()));
    p.start(options);
    expect(calls).toEqual(['start', 'sample']);
    p.stop();
    expect(calls).toEqual(['start', 'sample', 'stop']);
  });

  it('never starts the sampler when captureSystemTraces is off (the coordinator gate)', () => {
    const store = mkStore();
    const fs = fakeScheduler();
    const { sampler, calls } = recordingSampler();
    const coordinator = createCaptureCoordinator(buildInit(store));
    coordinator.addProvider(
      createSystemTracesProvider({ sample: sampler, scheduler: fs.scheduler }),
    );
    coordinator.start(createOptionsContainer({ [BugseeOption.CaptureSystemTraces]: false }));
    expect(calls).toEqual([]);
    coordinator.stop();
    expect(calls).toEqual([]);
  });

  it('re-attaches on a second start after a stop (provider cycled across launches)', () => {
    const fs = fakeScheduler();
    const { sampler, calls } = recordingSampler();
    const p = createSystemTracesProvider({ sample: sampler, scheduler: fs.scheduler });
    p.init(buildInit(mkStore()));
    p.start(options);
    p.stop();
    p.start(options);
    expect(calls).toEqual(['start', 'sample', 'stop', 'start', 'sample']);
  });

  it('stops the sampler when the initial emit throws, then rethrows', () => {
    const fs = fakeScheduler();
    const calls: string[] = [];
    const sampler: LifecycleSampler = {
      start: () => void calls.push('start'),
      stop: () => void calls.push('stop'),
      sample: () => {
        throw new Error('sample boom');
      },
    };
    const p = createSystemTracesProvider({ sample: sampler, scheduler: fs.scheduler });
    p.init(buildInit(mkStore()));
    expect(() => p.start(options)).toThrow('sample boom');
    expect(calls).toEqual(['start', 'stop']); // released, not leaked
    expect(fs.cleared()).toBe(0); // the timer was never created
  });

  it('propagates a start() throw without sampling or scheduling', () => {
    const fs = fakeScheduler();
    const sampled: string[] = [];
    const sampler: LifecycleSampler = {
      start: () => {
        throw new Error('start boom');
      },
      stop: () => {},
      sample: () => {
        sampled.push('sample');
        return [];
      },
    };
    const p = createSystemTracesProvider({ sample: sampler, scheduler: fs.scheduler });
    p.init(buildInit(mkStore()));
    expect(() => p.start(options)).toThrow('start boom');
    expect(sampled).toEqual([]);
    expect(fs.interval()).toBe(0);
  });
});
```

(`createOptionsContainer` already accepts an initial map in this test file's sibling tests — confirm the exact signature at `packages/core/src/options-container.ts` and mirror how the existing "disabled → no sampling" test builds its disabled container; use that form if it differs.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @bugsee/capture exec vitest run src/system-traces-provider.test.ts`
Expected: FAIL — `asLifecycleSampler` / `LifecycleSampler` are not exported.

- [ ] **Step 3: Implement** — in `system-traces-provider.ts`:

```ts
/** One sampled system trace: a named value at the sampling instant. */
export interface TraceSample { name: string; value: unknown }   // (unchanged)

/**
 * A system-traces sampler that owns standing resources (a delay histogram, an observer, a listener).
 * The PROVIDER owns the lifecycle: `start()` runs in the provider's `onStart` — i.e. only after the
 * coordinator's `captureSystemTraces` gate — and `stop()` in `onStop`, so nothing attaches when the
 * option is off and everything is released on `client.stop()`.
 */
export interface LifecycleSampler {
  start(): void;
  stop(): void;
  sample(): readonly TraceSample[];
}

/** A lifecycle sampler, or a bare function (a test stub / sample-only source) that is wrapped as one. */
export type SystemTracesSampler = (() => readonly TraceSample[]) | LifecycleSampler;

/** Wrap ONLY a bare function; a lifecycle object passes through by reference. */
export function asLifecycleSampler(sampler: SystemTracesSampler): LifecycleSampler {
  return typeof sampler === 'function'
    ? { start: () => {}, stop: () => {}, sample: sampler }
    : sampler;
}
```

Change the option and the class:

```ts
export interface SystemTracesProviderOptions {
  /** Reads the current system traces (the runtime-specific seam). A bare function is sample-only; a LifecycleSampler also gets start()/stop() from the provider. Required. */
  sample: SystemTracesSampler;
  // intervalMs / scheduler / now unchanged
}

class SystemTracesProvider extends CaptureProviderBase {
  // …
  readonly #sampler: LifecycleSampler;

  constructor(options: SystemTracesProviderOptions) {
    super();
    this.#sampler = asLifecycleSampler(options.sample);
    // …
  }

  protected onStart(): void {
    this.#sampler.start();
    try {
      this.#emit(); // initial snapshot, so a short-lived session still has current values
    } catch (error) {
      this.#sampler.stop(); // do not leak a half-started sampler
      throw error;
    }
    this.#timer = this.#scheduler.setInterval(() => this.#emit(), this.#intervalMs);
  }

  protected override onStop(): void {
    this.#scheduler.clearInterval(this.#timer);
    this.#timer = null;
    this.#sampler.stop();
  }

  #emit(): void {
    const timestamp = this.#now();
    for (const { name, value } of this.#sampler.sample()) {
      this.capture('traces.system', timestamp, { timestamp, name, value });
    }
  }
}
```

(Remove the now-unused `#sample` field.) In `index.ts` change the export block to:

```ts
export {
  asLifecycleSampler,
  createSystemTracesProvider,
  type LifecycleSampler,
  type SystemTracesProviderOptions,
  type SystemTracesSampler,
  type TraceSample,
} from './system-traces-provider';
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @bugsee/capture exec vitest run src/system-traces-provider.test.ts && pnpm --filter @bugsee/capture exec tsc --noEmit`
Expected: PASS, no type errors. (The existing function-form tests still pass untouched — that is the compatibility check.)

- [ ] **Step 5: Mutator loop** — save `cp system-traces-provider.ts /tmp/stp.bak`; inject, one at a time, and confirm a test fails each time: (1) delete `this.#sampler.start()`; (2) move `start()` after `#emit()`; (3) drop the `stop()` in the catch; (4) drop the `stop()` in `onStop`; (5) wrap `asLifecycleSampler` for objects too (return a copy) → the "same reference" test; (6) change `typeof sampler === 'function'` to `=== 'object'`; (7) call `start()` in the constructor. Restore with `cp /tmp/stp.bak system-traces-provider.ts`.

- [ ] **Step 6: Coverage + commit**

Run: `pnpm --filter @bugsee/capture exec vitest run --coverage` → 100% lines for this file.

```bash
git add packages/capture/src/system-traces-provider.ts packages/capture/src/system-traces-provider.test.ts packages/capture/src/index.ts
git commit -m "feat(capture): traces provider owns the sampler lifecycle (start/stop)

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 2: Node sampler returns a `LifecycleSampler` with a lazy delay histogram

**Files:**
- Modify: `packages/node/src/system-metrics.ts`
- Test: `packages/node/src/system-metrics.test.ts`

**Interfaces:**
- Consumes: `LifecycleSampler`, `TraceSample` from `@bugsee/capture` (Task 1).
- Produces: `EventLoopSource`; `NodeSystemMetricsDeps.eventLoop?: EventLoopReader | EventLoopSource`; `createNodeSystemMetricsSampler(deps): LifecycleSampler`.

- [ ] **Step 1: Adapt existing call sites** — every `createNodeSystemMetricsSampler(deps(...))()` in `system-metrics.test.ts` (11 call sites) becomes `createNodeSystemMetricsSampler(deps(...)).sample()`. Do this mechanically first; the tests fail to typecheck/run until Step 3 — that is the expected red.

- [ ] **Step 2: Write the new failing tests** (append):

```ts
import type { LifecycleSampler } from '@bugsee/capture';
import type { EventLoopSource } from './system-metrics';

describe('createNodeSystemMetricsSampler — lifecycle', () => {
  it('returns a lifecycle sampler (start/stop/sample)', () => {
    const s: LifecycleSampler = createNodeSystemMetricsSampler(deps());
    expect(typeof s.start).toBe('function');
    expect(typeof s.stop).toBe('function');
    expect(typeof s.sample).toBe('function');
  });

  it('forwards start/stop to an injected EventLoopSource and reads through it', () => {
    const calls: string[] = [];
    const source: EventLoopSource = {
      read: () => ({ meanMs: 1, maxMs: 2, p99Ms: 3 }),
      start: () => void calls.push('start'),
      stop: () => void calls.push('stop'),
    };
    const s = createNodeSystemMetricsSampler(deps({ eventLoop: source }));
    expect(calls).toEqual([]); // nothing attached at construction
    s.start();
    s.stop();
    expect(calls).toEqual(['start', 'stop']);
    expect(byName([...s.sample()]).get('event_loop_lag_max_ms')).toBe(2);
  });

  it('treats a bare-function eventLoop dep as lifecycle-free (start/stop are no-ops)', () => {
    const s = createNodeSystemMetricsSampler(deps({ eventLoop: () => ({ meanMs: 4, maxMs: 5, p99Ms: 6 }) }));
    expect(() => {
      s.start();
      s.stop();
    }).not.toThrow();
    expect(byName([...s.sample()]).get('event_loop_lag_ms')).toBe(4);
  });

  it('default source: no lag traces before start(), lag traces after start()', () => {
    const { eventLoop: _omit, ...rest } = deps();
    const s = createNodeSystemMetricsSampler(rest); // real perf_hooks source
    const before = byName([...s.sample()]);
    expect(before.has('event_loop_lag_ms')).toBe(false); // omitted, NOT zeroed
    s.start();
    try {
      const after = byName([...s.sample()]);
      for (const k of ['event_loop_lag_ms', 'event_loop_lag_max_ms', 'event_loop_lag_p99_ms']) {
        expect(after.has(k)).toBe(true);
      }
    } finally {
      s.stop();
    }
  });

  it('default source: start() twice and stop() before start() are harmless; restart works', () => {
    const { eventLoop: _omit, ...rest } = deps();
    const s = createNodeSystemMetricsSampler(rest);
    expect(() => s.stop()).not.toThrow(); // before start
    s.start();
    s.start(); // idempotent
    s.stop();
    s.start(); // restart
    expect(byName([...s.sample()]).has('event_loop_lag_ms')).toBe(true);
    s.stop();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @bugsee/node exec vitest run src/system-metrics.test.ts`
Expected: FAIL (`.sample` is not a function / `EventLoopSource` not exported).

- [ ] **Step 4: Implement** — in `system-metrics.ts`:

```ts
import type { LifecycleSampler, TraceSample } from '@bugsee/capture';

/**
 * An event-loop reader that owns a STANDING resource (a perf_hooks delay histogram). The histogram is
 * created and enabled in `start()` — never at construction — so it only exists between the traces
 * provider's start and stop (i.e. only when `captureSystemTraces` is on). `read()` answers `undefined`
 * (lag traces omitted, never zeroed) until `start()` has attached it.
 */
export interface EventLoopSource {
  read: EventLoopReader;
  start(): void;
  stop(): void;
}
const toEventLoopSource = (e: EventLoopReader | EventLoopSource): EventLoopSource =>
  typeof e === 'function' ? { read: e, start: () => {}, stop: () => {} } : e;

const createEventLoopSource = (): EventLoopSource => {
  let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
  return {
    start() {
      histogram ??= monitorEventLoopDelay();
      histogram.enable();
      histogram.reset(); // drop anything recorded before a previous stop
    },
    stop() {
      histogram?.disable();
    },
    read() {
      if (histogram === undefined) return undefined; // not started → omit, never zero
      const out = {
        meanMs: eventLoopLagFromMeanNs(histogram.mean),
        maxMs: eventLoopLagFromMeanNs(histogram.max),
        p99Ms: eventLoopLagFromMeanNs(histogram.percentile(99)),
      };
      histogram.reset();
      return out;
    },
  };
};
```

Replace `createEventLoopReader` with the above; change the dep type to `eventLoop?: EventLoopReader | EventLoopSource;` and update its doc comment ("a bare function has no lifecycle"). Change the factory:

```ts
export function createNodeSystemMetricsSampler(deps: NodeSystemMetricsDeps = {}): LifecycleSampler {
  // …unchanged readers…
  const loop: EventLoopSource = toEventLoopSource(deps.eventLoop ?? createEventLoopSource());
  // …
  return {
    start: () => loop.start(),
    stop: () => loop.stop(),
    sample: (): TraceSample[] => {
      // body of the previous returned arrow, with `const lag = loop.read();` in place of `eventLoop()`
    },
  };
}
```

Keep the CPU baseline (`lastCpu`/`lastWallMs`) and ELU baseline at construction — they are values, not standing resources (YAGNI: no re-baseline on restart; the sampler is rebuilt per launch).

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @bugsee/node exec vitest run src/system-metrics.test.ts && pnpm --filter @bugsee/node exec tsc --noEmit`
Expected: PASS (tsc will flag `guarded-system-metrics.ts` and `launch.ts` — fixed in Tasks 3–4; run only this file's tests here and defer the package-wide `tsc` to Task 4).

- [ ] **Step 6: Mutator loop** — back up `system-metrics.ts`; mutate: (1) create the histogram in the factory body again (construction-time) → "before start() omitted" test; (2) `read()` returns zeros instead of `undefined` when not started; (3) drop `histogram.disable()`; (4) drop `reset()` in `start()`; (5) `toEventLoopSource` returns `e` for functions; (6) `start: () => {}` in the returned sampler (forwarding removed). Confirm each fails; restore from the backup.

- [ ] **Step 7: Commit**

```bash
git add packages/node/src/system-metrics.ts packages/node/src/system-metrics.test.ts
git commit -m "feat(node): node system-metrics sampler is a lifecycle sampler; delay histogram attaches on start

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 3: Guarded (Bun/Deno) sampler — defer `monitor()` + `enable()` to `start()`

**Files:**
- Modify: `packages/node/src/guarded-system-metrics.ts` (`guardedEventLoop` lines ~52-79; `DelayHistogram` interface; factory lines ~116-128)
- Test: `packages/node/src/guarded-system-metrics.test.ts`

**Interfaces:**
- Consumes: `EventLoopSource` (Task 2), `LifecycleSampler` (Task 1).
- Produces: `createGuardedSystemMetricsSampler(deps): LifecycleSampler`.

- [ ] **Step 1: Adapt existing call sites** — the 16 uses of `createGuardedSystemMetricsSampler(...)()` become `.sample()`; where an existing test asserts `enable` happened right after construction, change it to call `s.start()` first (those assertions *encode the old bug* — update them, do not preserve them).

- [ ] **Step 2: Write the failing tests** (append; reuse the file's existing fake-histogram helper if present, else this local one):

```ts
function fakePerfHooks(opts: { monitorThrows?: boolean; enableThrows?: boolean } = {}) {
  const log = { monitor: 0, enable: 0, disable: 0, reset: 0 };
  const histogram = {
    enable: () => {
      log.enable += 1;
      if (opts.enableThrows) throw new Error('enable boom');
    },
    disable: () => void (log.disable += 1),
    reset: () => void (log.reset += 1),
    mean: 2e6,
    max: 5e6,
    percentile: () => 4e6,
  };
  const perfHooks = {
    monitorEventLoopDelay: () => {
      log.monitor += 1;
      if (opts.monitorThrows) throw new Error('monitor boom');
      return histogram;
    },
    eventLoopUtilization: () => ({ utilization: 0.5, idle: 1, active: 1 }),
  };
  return { perfHooks, log };
}

describe('createGuardedSystemMetricsSampler — lifecycle', () => {
  it('does NOT construct or enable the histogram at construction or on sample() before start()', () => {
    const { perfHooks, log } = fakePerfHooks();
    const s = createGuardedSystemMetricsSampler({ ...baseDeps(), perfHooks });
    expect(log).toMatchObject({ monitor: 0, enable: 0 });
    expect(byName([...s.sample()]).has('event_loop_lag_ms')).toBe(false); // omitted, not zeroed
    expect(log).toMatchObject({ monitor: 0, enable: 0 });
  });

  it('start() constructs + enables exactly once; lag traces then appear', () => {
    const { perfHooks, log } = fakePerfHooks();
    const s = createGuardedSystemMetricsSampler({ ...baseDeps(), perfHooks });
    s.start();
    s.start(); // idempotent
    expect(log.monitor).toBe(1);
    expect(log.enable).toBeGreaterThanOrEqual(1);
    const t = byName([...s.sample()]);
    expect(t.get('event_loop_lag_ms')).toBe(2);
    expect(t.get('event_loop_lag_max_ms')).toBe(5);
    expect(t.get('event_loop_lag_p99_ms')).toBe(4);
  });

  it('stop() disables the histogram; a restart re-enables the same histogram', () => {
    const { perfHooks, log } = fakePerfHooks();
    const s = createGuardedSystemMetricsSampler({ ...baseDeps(), perfHooks });
    s.start();
    s.stop();
    expect(log.disable).toBe(1);
    s.start();
    expect(log.monitor).toBe(1); // reused, not rebuilt
  });

  it('stop() before start() is a no-op', () => {
    const { perfHooks, log } = fakePerfHooks();
    const s = createGuardedSystemMetricsSampler({ ...baseDeps(), perfHooks });
    expect(() => s.stop()).not.toThrow();
    expect(log.disable).toBe(0);
  });

  it('measuresEventLoopDelay:false never constructs a histogram, even after start()', () => {
    const { perfHooks, log } = fakePerfHooks();
    const s = createGuardedSystemMetricsSampler({ ...baseDeps(), perfHooks, measuresEventLoopDelay: false });
    s.start();
    s.stop();
    expect(log.monitor).toBe(0);
    expect(byName([...s.sample()]).has('event_loop_lag_ms')).toBe(false);
  });

  it('a throwing monitorEventLoopDelay degrades to omitted lag; start() does not throw', () => {
    const { perfHooks } = fakePerfHooks({ monitorThrows: true });
    const s = createGuardedSystemMetricsSampler({ ...baseDeps(), perfHooks });
    expect(() => s.start()).not.toThrow();
    expect(byName([...s.sample()]).has('event_loop_lag_ms')).toBe(false);
  });

  it('a throwing enable() degrades to omitted lag; start() does not throw', () => {
    const { perfHooks } = fakePerfHooks({ enableThrows: true });
    const s = createGuardedSystemMetricsSampler({ ...baseDeps(), perfHooks });
    expect(() => s.start()).not.toThrow();
    expect(byName([...s.sample()]).has('event_loop_lag_ms')).toBe(false);
  });

  it('a runtime histogram with no disable() (Bun/Deno shape) stops cleanly', () => {
    const { perfHooks } = fakePerfHooks();
    const bare = { ...perfHooks, monitorEventLoopDelay: () => {
      const h = perfHooks.monitorEventLoopDelay();
      const { disable: _d, ...noDisable } = h;
      return noDisable;
    } };
    const s = createGuardedSystemMetricsSampler({ ...baseDeps(), perfHooks: bare });
    s.start();
    expect(() => s.stop()).not.toThrow();
  });
});
```

`baseDeps()` = the fully-injected `NodeSystemMetricsDeps` minus `eventLoop`/`eventLoopUtilization` (copy the helper at the top of this test file or `system-metrics.test.ts`'s `deps()`).

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @bugsee/node exec vitest run src/guarded-system-metrics.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement** — in `guarded-system-metrics.ts`:

```ts
import type { LifecycleSampler, TraceSample } from '@bugsee/capture';
import { createNodeSystemMetricsSampler, type EventLoopSource, eluUnavailable, type NodeSystemMetricsDeps } from './system-metrics';

interface DelayHistogram {
  enable(): void;
  /** Absent on some runtimes (Bun/Deno histograms) — stop() tolerates that. */
  disable?(): void;
  reset(): void;
  readonly mean: number;
  readonly max: number;
  percentile(p: number): number;
}

const unavailableLoop = (): undefined => undefined;
const unavailableSource: EventLoopSource = { read: unavailableLoop, start: () => {}, stop: () => {} };

// Builds the lag source. NOTHING is constructed or enabled until start(): a histogram that exists at
// factory time runs with captureSystemTraces:false and survives client.stop(). Answers `undefined` —
// never zero — when the runtime cannot give a real reading, or before start().
function guardedEventLoop(monitor: () => DelayHistogram): EventLoopSource {
  let histogram: DelayHistogram | undefined;
  let unusable = false;
  return {
    start() {
      if (unusable) return;
      try {
        histogram ??= monitor();
        histogram.enable();
        histogram.reset();
      } catch {
        unusable = true; // a partial runtime must not abort SDK startup
        histogram = undefined;
      }
    },
    stop() {
      try {
        histogram?.disable?.();
      } catch {
        // releasing is best-effort
      }
    },
    read() {
      if (histogram === undefined) return undefined;
      try {
        const out = {
          meanMs: lagMs(histogram.mean),
          maxMs: lagMs(histogram.max),
          p99Ms: lagMs(histogram.percentile(99)),
        };
        histogram.reset();
        return out;
      } catch {
        return undefined;
      }
    },
  };
}
```

Factory: `: LifecycleSampler`, and `eventLoop: measuresEventLoopDelay ? guardedEventLoop(perf.monitorEventLoopDelay) : unavailableSource,`. Leave `guardedElu` unchanged (a baseline value, not a standing resource).

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @bugsee/node exec vitest run src/guarded-system-metrics.test.ts src/system-metrics.test.ts`
Expected: PASS.

- [ ] **Step 6: Mutator loop** — backup; mutate: (1) call `monitor()` at factory time; (2) swallow nothing in `start()` (remove try/catch) → throw tests; (3) drop `unusable` guard (retry every start); (4) `stop()` without `?.disable?.()`; (5) `read()` returns zero object when `histogram === undefined`; (6) use `unavailableSource` regardless of the flag (inverted ternary); (7) remove `reset()` in `start()`. Confirm each is caught; restore.

- [ ] **Step 7: Commit**

```bash
git add packages/node/src/guarded-system-metrics.ts packages/node/src/guarded-system-metrics.test.ts
git commit -m "feat(node): guarded sampler defers the delay histogram to start() and releases it on stop()

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 4: Wire node / Bun / Deno launch and pin the gate end-to-end

**Files:**
- Modify: `packages/node/src/launch.ts:385` (option type), import line near `:8`
- Test: `packages/node/src/launch.test.ts`, `packages/bun/src/launch.test.ts`, `packages/deno/src/launch.test.ts`

**Interfaces:**
- Consumes: `SystemTracesSampler`, `LifecycleSampler` (Task 1); `createGuardedSystemMetricsSampler` (Task 3).

- [ ] **Step 1: Write the failing tests.** In `node/src/launch.test.ts` add (reuse `baseOptions`, `launchTracked`, `fakeScheduler`, `memStore`, `fixedClock` already in the file; `perfHooks` fake as in Task 3 — import `createGuardedSystemMetricsSampler` from `./guarded-system-metrics`):

```ts
describe('systemMetricsSampler lifecycle through launch()', () => {
  it('attaches the delay histogram only after the provider starts, and releases it on client.stop()', async () => {
    const { perfHooks, log } = fakePerfHooks(); // the Task-3 helper, copied locally
    const client = launchTracked('tok', baseOptions({
      captureStore: memStore(), clock: fixedClock, scheduler: fakeScheduler().scheduler,
      systemMetricsSampler: createGuardedSystemMetricsSampler({ perfHooks }),
    }));
    expect(log.monitor).toBe(1);
    expect(log.enable).toBeGreaterThanOrEqual(1);
    await client.stop();
    expect(log.disable).toBe(1);
  });

  it('creates NO histogram when captureSystemTraces is false', async () => {
    const { perfHooks, log } = fakePerfHooks();
    const client = launchTracked('tok', baseOptions({
      captureStore: memStore(), clock: fixedClock, scheduler: fakeScheduler().scheduler,
      captureSystemTraces: false,
      systemMetricsSampler: createGuardedSystemMetricsSampler({ perfHooks }),
    }));
    expect(log.monitor).toBe(0);
    expect(log.enable).toBe(0);
    await client.stop();
    expect(log.disable).toBe(0);
  });

  it('calls start() before the first sample and stop() on client.stop() for a lifecycle sampler', async () => {
    const calls: string[] = [];
    const client = launchTracked('tok', baseOptions({
      captureStore: memStore(), clock: fixedClock, scheduler: fakeScheduler().scheduler,
      systemMetricsSampler: {
        start: () => void calls.push('start'),
        stop: () => void calls.push('stop'),
        sample: () => (calls.push('sample'), []),
      },
    }));
    expect(calls.slice(0, 2)).toEqual(['start', 'sample']);
    await client.stop();
    expect(calls.at(-1)).toBe('stop');
  });

  it('still accepts a bare-function sampler (test stub)', () => {
    const client = launchTracked('tok', baseOptions({ captureStore: memStore(), systemMetricsSampler: () => [] }));
    expect(client.isLaunched()).toBe(true);
  });
});
```

In `bun/src/launch.test.ts` and `deno/src/launch.test.ts` (both already `vi.mock` the guarded factory with a pass-through spy) add:

```ts
it('injects a REAL lifecycle sampler, not a bare function a typeof-adapter would turn into a no-op start()', () => {
  track(launchCore('tok', base()).client);
  const sampler = vi.mocked(createGuardedSystemMetricsSampler).mock.results.at(-1)?.value;
  expect(typeof sampler).toBe('object');
  expect(typeof sampler.start).toBe('function');
  expect(typeof sampler.stop).toBe('function');
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @bugsee/node exec vitest run src/launch.test.ts` (type error on the object-valued option) and the bun/deno files.

- [ ] **Step 3: Implement** — `node/src/launch.ts`: `import type { SystemTracesSampler, TraceSample } from '@bugsee/capture';` (drop `TraceSample` from the import if now unused) and

```ts
  /** Reads the current system traces. A LifecycleSampler gets start()/stop() from the traces provider (so nothing attaches when captureSystemTraces is off); a bare function is sample-only (tests). */
  systemMetricsSampler?: SystemTracesSampler;
```

Line ~866 (`sample: options.systemMetricsSampler ?? createNodeSystemMetricsSampler(),`) is unchanged.

- [ ] **Step 4: Run to verify pass + package typecheck**

Run: `pnpm --filter @bugsee/node exec tsc --noEmit && pnpm --filter @bugsee/node exec vitest run && pnpm --filter @bugsee/bun exec tsc --noEmit && pnpm --filter @bugsee/bun exec vitest run && pnpm --filter @bugsee/deno exec tsc --noEmit && pnpm --filter @bugsee/deno exec vitest run`
Expected: PASS. If `tsc` flags another consumer of the old function return type (e.g. `node/src/index.test.ts`, the electron package), adapt it to `.sample()` and note it in the commit message.

- [ ] **Step 5: Mutator loop** — in `launch.ts`/provider wiring mutate: (1) pass `() => sampler.sample()` instead of the object (loses start) → the guarded "log.monitor toBe(1)" test fails; (2) call `systemMetricsSampler.start()` eagerly at launch → the `captureSystemTraces:false` test fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/node/src/launch.ts packages/node/src/launch.test.ts packages/bun/src/launch.test.ts packages/deno/src/launch.test.ts
git commit -m "feat(node,bun,deno): launch passes the lifecycle sampler through; pin the captureSystemTraces gate

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 7: Real-runtime check (not in `pnpm test`)** — `pnpm test:e2e` (boots the real SDK in node/bun/deno): confirm `event_loop_lag_*` are still present in the uploaded bundle on node and bun and **absent on deno**. This is the regression the whole seam exists to prevent.

---

### Task 5: Browser sampler — `getBattery()` moves to `start()`, with an abort token

**Files:**
- Modify: `packages/browser/src/system-metrics.ts` (sampler head at lines ~94-105; return)
- Modify: `packages/browser/src/launch.ts:411`, `packages/webview/src/launch.ts:256` (option type)
- Test: `packages/browser/src/system-metrics.test.ts`, `packages/browser/src/launch.test.ts`, `packages/webview/src/launch.test.ts`

**Interfaces:**
- Consumes: `LifecycleSampler` (Task 1). Produces: `createBrowserSystemTracesSampler(env): LifecycleSampler`.

- [ ] **Step 1: Adapt existing call sites** — 8 uses of `createBrowserSystemTracesSampler(...)()` → `.sample()`; tests that relied on the battery being fetched at construction now call `sampler.start()` before awaiting (`await Promise.resolve()` as before).

- [ ] **Step 2: Write the failing tests** (append to `system-metrics.test.ts`):

```ts
describe('createBrowserSystemTracesSampler — lifecycle', () => {
  it('does not call getBattery() at construction; start() calls it once (idempotent)', () => {
    let calls = 0;
    const s = createBrowserSystemTracesSampler({
      navigator: { getBattery: () => (calls++, Promise.resolve({ level: 1, charging: false })) },
    });
    expect(calls).toBe(0);
    s.start();
    s.start();
    expect(calls).toBe(1);
  });

  it('reports battery once the manager resolves after start()', async () => {
    const s = createBrowserSystemTracesSampler({
      navigator: { getBattery: () => Promise.resolve({ level: 0.5, charging: false }) },
    });
    s.start();
    await Promise.resolve();
    expect(byName([...s.sample()]).get('battery')).toBe(50);
  });

  it('IGNORES a getBattery() that resolves AFTER stop() (no cache, no battery trace)', async () => {
    let resolve!: (m: { level: number; charging: boolean }) => void;
    const s = createBrowserSystemTracesSampler({
      navigator: { getBattery: () => new Promise((r) => (resolve = r)) },
    });
    s.start();
    s.stop();
    resolve({ level: 0.9, charging: true });
    await Promise.resolve();
    expect(byName([...s.sample()]).has('battery')).toBe(false);
  });

  it('a stale generation cannot overwrite a newer start (stop → start → old promise resolves late)', async () => {
    const resolvers: Array<(m: { level: number; charging: boolean }) => void> = [];
    const s = createBrowserSystemTracesSampler({
      navigator: { getBattery: () => new Promise((r) => resolvers.push(r)) },
    });
    s.start();
    s.stop();
    s.start();
    resolvers[0]?.({ level: 0.1, charging: false }); // the OLD fetch
    await Promise.resolve();
    expect(byName([...s.sample()]).has('battery')).toBe(false);
    resolvers[1]?.({ level: 0.7, charging: false }); // the CURRENT fetch
    await Promise.resolve();
    expect(byName([...s.sample()]).get('battery')).toBe(70);
  });

  it('stop() drops a cached manager; a restart fetches again', async () => {
    let calls = 0;
    const s = createBrowserSystemTracesSampler({
      navigator: { getBattery: () => (calls++, Promise.resolve({ level: 0.5, charging: false })) },
    });
    s.start();
    await Promise.resolve();
    s.stop();
    expect(byName([...s.sample()]).has('battery')).toBe(false);
    s.start();
    expect(calls).toBe(2);
  });

  it('a synchronously-throwing getBattery() does not break start()', () => {
    const s = createBrowserSystemTracesSampler({
      navigator: { getBattery: () => { throw new Error('SecurityError'); } },
    });
    expect(() => s.start()).not.toThrow();
  });

  it('sample() before start() omits battery and never throws', () => {
    const s = createBrowserSystemTracesSampler({ navigator: { getBattery: () => Promise.resolve({ level: 1, charging: true }) } });
    expect(byName([...s.sample()]).has('battery')).toBe(false);
  });
});
```

In `browser/src/launch.test.ts` add (reusing its `baseOptions`/`launchTracked`/`vi.stubGlobal` pattern):

```ts
it('does not fetch the BatteryManager when captureSystemTraces is false, and does when it is true', async () => {
  const getBattery = vi.fn(() => Promise.resolve({ level: 1, charging: false }));
  vi.stubGlobal('navigator', { userAgent: 'UA', getBattery });
  const off = await launchTracked('tok', baseOptions({ systemMetricsSampler: undefined, captureSystemTraces: false }));
  expect(getBattery).not.toHaveBeenCalled();
  await off.stop();
  const on = await launchTracked('tok', baseOptions({ systemMetricsSampler: undefined }));
  expect(getBattery).toHaveBeenCalledTimes(1);
  await on.stop();
});
```

Add the equivalent lifecycle-sampler pass-through test to `webview/src/launch.test.ts` mirroring Task 4's "calls start() before the first sample" test (webview has its own `baseOptions`).

- [ ] **Step 3: Run to verify failure** — `pnpm --filter @bugsee/browser exec vitest run src/system-metrics.test.ts`.

- [ ] **Step 4: Implement** — `system-metrics.ts`:

```ts
import type { LifecycleSampler, TraceSample } from '@bugsee/capture';

/** Build a system-traces sampler over the browser context APIs (default the real globals). */
export function createBrowserSystemTracesSampler(
  env: BrowserTracesEnv = realEnv(),
): LifecycleSampler {
  // The BatteryManager is fetched in start() — NOT at construction — so it is never requested when
  // captureSystemTraces is off. `generation` makes a fetch that resolves after stop() (or after a
  // stop→start cycle) a no-op: a late fulfilment must not cache a manager or surface battery traces.
  let battery: BatteryManager | undefined;
  let started = false;
  let generation = 0;
  return {
    start() {
      if (started) return;
      started = true;
      const mine = ++generation;
      try {
        env.navigator?.getBattery?.().then(
          (manager) => {
            if (started && generation === mine) battery = manager;
          },
          () => {}, // unsupported / permission denied → no battery traces
        );
      } catch {
        // a synchronous throw (e.g. a SecurityError in a sandboxed frame) just means no battery traces
      }
    },
    stop() {
      started = false;
      generation += 1;
      battery = undefined;
    },
    sample: (): TraceSample[] => {
      // …the existing returned arrow's body, unchanged…
    },
  };
}
```

Widen `systemMetricsSampler?: SystemTracesSampler;` in `browser/src/launch.ts:411` and `webview/src/launch.ts:256` (`import type { SystemTracesSampler } from '@bugsee/capture'`; leave webview's `:372` drop-list alone).

- [ ] **Step 5: Run to verify pass + typecheck**

Run: `pnpm --filter @bugsee/browser exec tsc --noEmit && pnpm --filter @bugsee/browser exec vitest run && pnpm --filter @bugsee/webview exec tsc --noEmit && pnpm --filter @bugsee/webview exec vitest run`
Expected: PASS.

- [ ] **Step 6: Mutator loop** — backup; mutate: (1) call `getBattery` at construction again; (2) drop `generation === mine`; (3) drop `started &&`; (4) drop `battery = undefined` in `stop()`; (5) drop the `try/catch`; (6) remove the `if (started) return` guard; (7) `stop()` without `generation += 1`. Confirm each fails; restore.

- [ ] **Step 7: Commit**

```bash
git add packages/browser/src packages/webview/src
git commit -m "feat(browser,webview): browser sampler is a lifecycle sampler; getBattery() moves to start() with an abort token

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 6: `charging` trace → `{ state }` (the viewer-renderable shape)

**Files:**
- Modify: `packages/browser/src/system-trace-values.ts` (add `chargingToWire` after `orientationToWire`), `packages/browser/src/system-metrics.ts` (the `charging` sample)
- Test: `packages/browser/src/system-trace-values.test.ts`, `packages/browser/src/system-metrics.test.ts` (lines ~114-180 assert the boolean)

**Interfaces:** Produces `chargingToWire(battery: { charging: boolean; level: number }): { state: 1 | 2 | 3 }`.

Why: the viewer's `charging` table is keyed `"0"`–`"3"` and `processCharging` takes an int or `{state, …}`. A JS boolean never matches (`false` is dropped by a falsy guard, `true` looks up `states["true"]`), so the shipped trace renders nothing (spec §13.4). `source` has no Battery-API equivalent and is omitted.

- [ ] **Step 1: Write the failing tests.** `system-trace-values.test.ts`:

```ts
describe('chargingToWire', () => {
  it('not charging → unplugged (1)', () => {
    expect(chargingToWire({ charging: false, level: 0.4 })).toEqual({ state: 1 });
  });
  it('charging below full → charging (2), including 0.99', () => {
    expect(chargingToWire({ charging: true, level: 0.5 })).toEqual({ state: 2 });
    expect(chargingToWire({ charging: true, level: 0.99 })).toEqual({ state: 2 });
  });
  it('charging at level 1 → full (3)', () => {
    expect(chargingToWire({ charging: true, level: 1 })).toEqual({ state: 3 });
  });
  it('never invents a source, and never emits unknown (0)', () => {
    for (const b of [{ charging: false, level: 0 }, { charging: true, level: 0 }, { charging: true, level: 1 }]) {
      const v = chargingToWire(b);
      expect(Object.keys(v)).toEqual(['state']);
      expect([1, 2, 3]).toContain(v.state);
    }
  });
});
```

Update `system-metrics.test.ts` so every `{ name: 'charging', value: true|false }` expectation becomes `{ name: 'charging', value: { state: … } }` (`charging: true, level: 0.426` → `{ state: 2 }`; `charging: false` → `{ state: 1 }`; the file's `level: 1, charging: false` case → `{ state: 1 }`; add one `level: 1, charging: true` case → `{ state: 3 }`).

- [ ] **Step 2: Run to verify failure** — `pnpm --filter @bugsee/browser exec vitest run src/system-trace-values.test.ts src/system-metrics.test.ts`.

- [ ] **Step 3: Implement.**

```ts
/**
 * The `charging` trace in the vocabulary the viewer's table is keyed by (Android/iOS state ints:
 * 0 unknown, 1 unplugged, 2 charging, 3 full) — an `{ state }` object, `source` omitted because the
 * Battery API cannot say AC vs USB vs wireless and an invented one would be a lie. Unknown (0) is never
 * emitted: with no BatteryManager the trace is omitted entirely.
 */
export function chargingToWire(battery: { charging: boolean; level: number }): { state: 1 | 2 | 3 } {
  if (!battery.charging) return { state: 1 };
  return { state: battery.level >= 1 ? 3 : 2 };
}
```

In `system-metrics.ts`: `{ name: 'charging', value: chargingToWire(battery) }` (import it next to `connectionTypeToWire`). Update the header comment's `battery (0-100) + charging` line. Do **not** touch `environment.hardware.charging`.

- [ ] **Step 4: Run to verify pass** — same command, plus `pnpm --filter @bugsee/browser exec tsc --noEmit`. Also `grep -rn "charging" packages/*/src e2e` and fix any other assertion on the boolean (only `system-metrics.test.ts` was found at planning time).

- [ ] **Step 5: Mutator loop** — mutate: (1) `>= 1` → `> 1`; (2) `>= 1` → `>= 0.99`; (3) swap 1/2; (4) return `{ state: 2, source: 'ac' }`; (5) invert `!battery.charging`; (6) always `{state: 2}`. Each must fail; restore.

- [ ] **Step 6: Commit**

```bash
git add packages/browser/src/system-trace-values.ts packages/browser/src/system-trace-values.test.ts packages/browser/src/system-metrics.ts packages/browser/src/system-metrics.test.ts
git commit -m "fix(browser): charging trace is { state } (viewer table keys 1/2/3), not a boolean the viewer cannot render

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 7: Gates, record, review, PR

- [ ] **Step 1: Full local gate** — `pnpm ci:local` (lint → typecheck → cycles → per-package coverage → e2e). Expected: green. Fix any coverage gap by adding a test, never by lowering a threshold.
- [ ] **Step 2: Docs** — add a short paragraph to `docs/PROGRESS.md` under the traces section: "ST0 done: traces provider owns `LifecycleSampler.start()/stop()`; node/guarded/browser samplers are lifecycle objects; delay histogram and `getBattery()` attach on start; `charging` is `{state}`." Commit: `docs: record ST0 (sampler lifecycle seam)`.
- [ ] **Step 3: Convergent review (`docs/implementation-standards.md` §7)** — run a multi-agent review in parallel over the branch diff: one agent per concern — (a) provider/sampler lifecycle correctness, (b) Bun/Deno honesty + gate wiring, (c) browser late-resolve/abort and `charging`, (d) tests (do they assert outcomes, do mutations die). Agents are read-only and must cite `file:line`. Triage, fix real findings test-first, re-run a *fresh* review until a round yields zero new real findings.
- [ ] **Step 4: Open the PR** — `gh pr create --draft --base main --title "feat(capture,node,browser): traces sampler lifecycle seam + charging fix (ST0)"`; body: summary of Tasks 1–6, link to `docs/design/system-traces-expansion.md` (PR #53), the test evidence (`pnpm ci:local` output, e2e on node/bun/deno), and the Review Focus list with the test that pins each item.

---

## Self-Review

**Spec coverage (design doc §9 ST0, §5, §12 item 5, §13.4):** lifecycle seam + provider owns start/stop → Task 1; existing factory-time work moved (`monitorEventLoopDelay().enable()` in both the node site and the Bun/Deno `guardedEventLoop` site, `getBattery()`) → Tasks 2, 3, 5; bare-function wrap only for `typeof === 'function'`, production factories return objects → Tasks 1–3; three composition roots (node/browser/webview) pass the object through, Bun/Deno inject the guarded sampler → Tasks 4, 5; late-resolve abort token → Task 5; `charging` decision → Task 6. Out of ST0 by design: browser `window`/`document` env threading and rAF (ST4), the events source and `matchMedia` (ST4b), Electron wrap (ST6), `measures*` flags beyond the existing `measuresEventLoopDelay` (ST1/ST2). **WebView:** covered for the option type and the lifecycle pass-through test; its default sampler is the same browser factory, so Task 5's behaviour tests cover it.

**Placeholder scan:** none; every code step carries its code. Two steps say "confirm the exact signature/helper name in the file and mirror it" (`createOptionsContainer` in Task 1, the fake-histogram helper in Task 3) — both name the exact file to read.

**Type consistency:** `LifecycleSampler{start,stop,sample}`, `SystemTracesSampler`, `asLifecycleSampler`, `EventLoopSource{read,start,stop}`, `chargingToWire` are used with the same names/signatures in every task; the provider option stays named `sample` (accepting the union) to keep the diff small.

**Known risks to watch during execution:** (1) `tsc` may surface other consumers of the old function return type (the electron package, `node/src/index.test.ts`) — adapt them to `.sample()`; (2) ELU/CPU baselines stay at construction (deliberate, YAGNI); (3) `histogram.reset()` on a Deno/Bun histogram is assumed present as today (`guardedEventLoop` already called it); (4) all runtime facts are macOS-measured — the e2e step (Task 4 Step 7) is the real-runtime confirmation.
