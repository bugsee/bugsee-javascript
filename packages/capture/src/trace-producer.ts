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
  (typeof a === 'object' &&
    a !== null &&
    typeof b === 'object' &&
    b !== null &&
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
