import type { Clock } from '@bugsee/core';

// The APM Span/Transaction model (Android-canonical: contracts/performance/{Span,Transaction,SpanStatus}).
// Runtime-portable (no DOM/process); timing comes from the injected core Clock — wallNow() anchors the
// wire `*TimestampMs`, monotonicNow() gives the precise `durationNanos` (sub-ms preserved). Serializes to
// the design §8.8 transaction wire owned by this extension. Spans form a flat per-trace list linked by
// parentSpanId; the transaction is the root span (no parent) plus name/sampled.

/** Span outcome (Android SpanStatus parity; the §8.8 wire `status` values). */
export type SpanStatus = 'OK' | 'ERROR' | 'TIMEOUT' | 'CANCELLED' | 'DEADLINE_EXCEEDED' | 'UNKNOWN';

/** A unit of work in a trace (Android contracts/performance/Span). Fluent setters return the span. */
export interface Span {
  setName(name: string): this;
  setDescription(description: string | undefined): this;
  setAttribute(key: string, value: unknown): this;
  setStatus(status: SpanStatus): this;
  /** Open a child span parented to this one, sharing the trace. */
  startChildSpan(operation: string, description?: string): Span;
  getSpanId(): string;
  getTraceId(): string;
  getStatus(): SpanStatus;
  getOperation(): string;
  getDescription(): string | undefined;
  /** A shallow copy of the span's attributes. */
  getAttributes(): Record<string, unknown>;
  isFinished(): boolean;
  /** Close the span (idempotent); optionally set its final status. */
  finish(status?: SpanStatus): void;
}

/** The root span of a trace (Android contracts/performance/Transaction): adds a name + sampling flag. */
export interface Transaction extends Span {
  getName(): string;
  isSampled(): boolean;
}

/** A child span on the §8.8 wire. */
export interface SpanWire {
  spanId: string;
  parentSpanId?: string;
  operation: string;
  description?: string;
  status: SpanStatus;
  startTimestampMs: number;
  endTimestampMs?: number;
  durationNanos?: number;
  attributes?: Record<string, unknown>;
}

/** The §8.8 performance transaction wire. */
export interface TransactionWire {
  traceId: string;
  name: string;
  operation: string;
  status: SpanStatus;
  startTimestampMs: number;
  endTimestampMs?: number;
  durationNanos?: number;
  isSnapshot: boolean;
  appVersion?: string;
  appBuild?: string;
  attributes?: Record<string, unknown>;
  spans: SpanWire[];
}

export interface TransactionOptions {
  name: string;
  operation: string;
  description?: string;
  /** Whether the trace is sampled (kept). Default true. */
  sampled?: boolean;
  /** Marks a snapshot transaction (e.g. captured into an incident bundle). Default false. */
  isSnapshot?: boolean;
  appVersion?: string;
  appBuild?: string;
}

export interface CreateTransactionDeps {
  clock: Clock;
  /** Trace id generator; default a random 16-byte hex. */
  newTraceId?: () => string;
  /** Span id generator; default a random 8-byte hex. */
  newSpanId?: () => string;
  /** Called ONCE when the root transaction finishes (child-span finishes do not trigger it). */
  onFinish?: (transaction: Transaction) => void;
}

// --- id generation (runtime-portable: WebCrypto when present, Math.random fallback) ---------------

const randomBytes = (n: number): Uint8Array => {
  const bytes = new Uint8Array(n);
  const webcrypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
    .crypto;
  if (webcrypto?.getRandomValues) {
    webcrypto.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < n; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return bytes;
};

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** A random 16-byte (32 hex char) trace id. */
export const defaultTraceId = (): string => toHex(randomBytes(16));
/** A random 8-byte (16 hex char) span id. */
export const defaultSpanId = (): string => toHex(randomBytes(8));

// --- the model -----------------------------------------------------------------------------------

interface TraceEnv {
  readonly clock: Clock;
  readonly newSpanId: () => string;
  /** The shared per-trace recorder: the root span (index 0) followed by every descendant, in order. */
  readonly spans: SpanImpl[];
}

class SpanImpl implements Span {
  // `protected` (not #) so TransactionImpl can read the recorder + name across the inheritance boundary.
  protected readonly env: TraceEnv;
  protected name: string | undefined;
  readonly #spanId: string;
  readonly #traceId: string;
  readonly #parentSpanId: string | undefined;
  #operation: string;
  #description: string | undefined;
  #status: SpanStatus = 'OK';
  readonly #attributes = new Map<string, unknown>();
  readonly #startTimestampMs: number;
  readonly #startMono: number;
  #endTimestampMs: number | undefined;
  #durationNanos: number | undefined;
  #finished = false;

  constructor(
    env: TraceEnv,
    traceId: string,
    parentSpanId: string | undefined,
    operation: string,
    description: string | undefined,
  ) {
    this.env = env;
    this.#spanId = env.newSpanId();
    this.#traceId = traceId;
    this.#parentSpanId = parentSpanId;
    this.#operation = operation;
    this.#description = description;
    this.#startTimestampMs = env.clock.wallNow();
    this.#startMono = env.clock.monotonicNow();
    env.spans.push(this);
  }

  setName(name: string): this {
    this.name = name;
    return this;
  }
  setDescription(description: string | undefined): this {
    this.#description = description;
    return this;
  }
  setAttribute(key: string, value: unknown): this {
    this.#attributes.set(key, value);
    return this;
  }
  setStatus(status: SpanStatus): this {
    this.#status = status;
    return this;
  }
  startChildSpan(operation: string, description?: string): Span {
    return new SpanImpl(this.env, this.#traceId, this.#spanId, operation, description);
  }
  getSpanId(): string {
    return this.#spanId;
  }
  getTraceId(): string {
    return this.#traceId;
  }
  getStatus(): SpanStatus {
    return this.#status;
  }
  getOperation(): string {
    return this.#operation;
  }
  getDescription(): string | undefined {
    return this.#description;
  }
  getAttributes(): Record<string, unknown> {
    return Object.fromEntries(this.#attributes);
  }
  isFinished(): boolean {
    return this.#finished;
  }
  finish(status?: SpanStatus): void {
    if (this.#finished) return;
    if (status !== undefined) this.#status = status;
    this.#endTimestampMs = this.env.clock.wallNow();
    this.#durationNanos = Math.round((this.env.clock.monotonicNow() - this.#startMono) * 1_000_000);
    this.#finished = true;
  }

  /** Serialize this span to the §8.8 child-span wire (omitting absent optionals). */
  toSpanWire(): SpanWire {
    const wire: SpanWire = {
      spanId: this.#spanId,
      operation: this.#operation,
      status: this.#status,
      startTimestampMs: this.#startTimestampMs,
    };
    if (this.#parentSpanId !== undefined) wire.parentSpanId = this.#parentSpanId;
    if (this.#description !== undefined) wire.description = this.#description;
    if (this.#endTimestampMs !== undefined) wire.endTimestampMs = this.#endTimestampMs;
    if (this.#durationNanos !== undefined) wire.durationNanos = this.#durationNanos;
    if (this.#attributes.size > 0) wire.attributes = Object.fromEntries(this.#attributes);
    return wire;
  }
}

class TransactionImpl extends SpanImpl implements Transaction {
  readonly #sampled: boolean;
  readonly #isSnapshot: boolean;
  readonly #appVersion: string | undefined;
  readonly #appBuild: string | undefined;
  readonly #onFinish: ((transaction: Transaction) => void) | undefined;

  constructor(
    env: TraceEnv,
    traceId: string,
    options: TransactionOptions,
    onFinish: ((transaction: Transaction) => void) | undefined,
  ) {
    super(env, traceId, undefined, options.operation, options.description);
    this.name = options.name;
    this.#sampled = options.sampled ?? true;
    this.#isSnapshot = options.isSnapshot ?? false;
    this.#appVersion = options.appVersion;
    this.#appBuild = options.appBuild;
    this.#onFinish = onFinish;
  }

  getName(): string {
    return this.name ?? '';
  }
  isSampled(): boolean {
    return this.#sampled;
  }
  override finish(status?: SpanStatus): void {
    const alreadyFinished = this.isFinished();
    super.finish(status);
    if (!alreadyFinished) this.#onFinish?.(this); // fire once, after the span is closed
  }

  /** Serialize the whole trace to the §8.8 transaction wire (root fields + non-root spans). */
  toTransactionWire(): TransactionWire {
    const root = this.toSpanWire(); // root span's own fields (spanId/operation/status/timestamps/...)
    const wire: TransactionWire = {
      traceId: this.getTraceId(),
      name: this.getName(),
      operation: root.operation,
      status: root.status,
      startTimestampMs: root.startTimestampMs,
      isSnapshot: this.#isSnapshot,
      spans: this.env.spans.filter((span) => span !== this).map((span) => span.toSpanWire()),
    };
    if (root.endTimestampMs !== undefined) wire.endTimestampMs = root.endTimestampMs;
    if (root.durationNanos !== undefined) wire.durationNanos = root.durationNanos;
    if (this.#appVersion !== undefined) wire.appVersion = this.#appVersion;
    if (this.#appBuild !== undefined) wire.appBuild = this.#appBuild;
    if (root.attributes !== undefined) wire.attributes = root.attributes;
    return wire;
  }
}

/** Start a new transaction (the root of a trace). */
export function createTransaction(
  options: TransactionOptions,
  deps: CreateTransactionDeps,
): Transaction {
  const env: TraceEnv = {
    clock: deps.clock,
    newSpanId: deps.newSpanId ?? defaultSpanId,
    spans: [],
  };
  const traceId = (deps.newTraceId ?? defaultTraceId)();
  return new TransactionImpl(env, traceId, options, deps.onFinish);
}

/** Serialize a transaction (and its spans) to the §8.8 wire shape. */
export function serializeTransaction(transaction: Transaction): TransactionWire {
  return (transaction as TransactionImpl).toTransactionWire();
}
