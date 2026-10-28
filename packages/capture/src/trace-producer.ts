// A TRACE PRODUCER (Android BugseeCaptureValueProducer / iOS BGSCaptureSystemTraceProducer parity): the unit
// that turns a tracker's aggregated state into named `traces.system` values. It SUBSCRIBES to one or more
// trackers in onStart() and unsubscribes in onStop(); trackers attach/release their OS resources by
// subscriber presence, so a producer that is never started costs nothing. The provider hands every
// producer a sink; the producer never talks to the aggregator itself.
//
// The names a producer may write are the registry's (`TraceName`, @bugsee/protocol): `emit`/`emitIfChanged` take a
// `TraceName`, so an unregistered literal does not compile, and the drift test (instrumentation-tests spec-drift)
// fails when a producer spells a registered name instead of referencing it.

import type { TraceName } from '@bugsee/protocol';

/** Per-emit options for {@link TraceSink.emit}. */
export interface TraceEmitOptions {
  /**
   * `true` = a CHANGE-DRIVEN value the producer only re-emits when it changes (battery, charging, …):
   * the provider keeps it as the last value and re-records it every `refreshMs` so a rolling capture
   * window never loses it. Anything else (absent / `false`) = a POLLED value (cpu, memory, lag, ELU) that
   * is emitted every tick and is NEVER refreshed — if its poll fails, the trace simply stops, rather than
   * the provider fabricating a flat line at the last good reading.
   */
  hold?: boolean;
  /** Sample time (ms, the sink's clock). Absent = the sink stamps the time of the emit itself. */
  timestamp?: number;
}

/** Where a producer sends its values (the provider stamps the time and keeps the last-value snapshot). */
export interface TraceSink {
  /**
   * Record one trace sample. `displayId` scopes it to a display; absent = device-wide. Only an emit with
   * `options.hold === true` is kept for the provider's last-value refresh (see {@link TraceEmitOptions}).
   */
  emit(name: TraceName, value: unknown, displayId?: number, options?: TraceEmitOptions): void;
  /** The sink's clock, so a producer can take ONE timestamp per poll (see TraceProducerBase.poll). Optional for hand-written sinks. */
  now?(): number;
}

export interface TraceProducer {
  /** Producer id, for diagnostics. */
  readonly name: string;
  /** Subscribe to trackers and emit a baseline. Must be safe to call again after stop(). */
  start(sink: TraceSink): void;
  /** Unsubscribe from everything start() attached. Idempotent; a no-op before start(). */
  stop(): void;
}

// BigInt has no JSON form: tag it so it compares by value and is distinct from a string
// (a literal `{ $bigint }` object of that exact shape would still compare equal; accepted).
const bigintSafe = (_key: string, v: unknown): unknown =>
  typeof v === 'bigint' ? { $bigint: v.toString() } : v;

/** Total: never throws. An uncomparable value (circular, throwing toJSON) counts as CHANGED. */
const sameValue = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  try {
    return JSON.stringify(a, bigintSafe) === JSON.stringify(b, bigintSafe);
  } catch {
    return false;
  }
};

const keyOf = (name: string, displayId: number | undefined): string =>
  displayId === undefined ? name : `${displayId}:${name}`;

export abstract class TraceProducerBase implements TraceProducer {
  abstract readonly name: string;
  #sink: TraceSink | undefined;
  readonly #last = new Map<string, unknown>();
  #pollAt: number | undefined;

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

  /**
   * Always emit (polled families: cpu / memory emit every tick, like Android). Sent with `hold: false`:
   * the provider never refreshes a polled value, so a failed poll leaves a gap instead of a frozen line.
   */
  protected emit(name: TraceName, value: unknown, displayId?: number): void {
    this.#send(name, value, displayId, false);
  }

  /**
   * Emit only when the value differs from the last emitted for this name+display (iOS emitIfChangedName).
   * Sent with `hold: true`: the provider re-records the held value every `refreshMs`, because an unchanged
   * value is deliberately not re-emitted here.
   */
  protected emitIfChanged(name: TraceName, value: unknown, displayId?: number): void {
    const key = keyOf(name, displayId);
    if (this.#last.has(key) && sameValue(this.#last.get(key), value)) return;
    this.#send(name, value, displayId, true);
  }

  /**
   * Run `fn` as ONE poll: every emit inside it carries the same timestamp (taken once, from the sink's clock),
   * so the values of one reading correlate exactly. A sink without a clock leaves per-emit stamping. Re-entrant.
   */
  protected poll(fn: () => void): void {
    if (this.#pollAt !== undefined || this.#sink === undefined) {
      fn();
      return;
    }
    this.#pollAt = this.#sink.now?.();
    try {
      fn();
    } finally {
      this.#pollAt = undefined;
    }
  }

  #send(name: TraceName, value: unknown, displayId: number | undefined, hold: boolean): void {
    if (this.#sink === undefined) return;
    this.#sink.emit(
      name,
      value,
      displayId,
      this.#pollAt === undefined ? { hold } : { hold, timestamp: this.#pollAt },
    );
    this.#last.set(keyOf(name, displayId), value);
  }
}
