import type { BugseeOptionTypes, FileType } from '@bugsee/protocol';
import { serviceToken } from '@bugsee/service';
import type { EventSubscribable } from './emitter';
import type { ReportingRequest } from './reporting';

// The Android-derived extension contracts (design §16.2). Sources (Interceptor / adapters via
// OperationDispatcher) emit to hubs; consumers (CaptureProvider / DetectionProvider) and feature
// modules (Extension) plug in through these seams (§16.3). Type-only; validated by contracts.test-d.ts.
//
// Operation / OperationObserver are unspecified in the design, so they get MINIMAL cross-runtime base
// shapes (adapters refine them), matching the InputEvent approach. Detection submits a
// ReportingRequest (Android parity, reporting.ts) rather than a lightweight hint.

/**
 * A build-injected / framework-adapter operation (DB, HTTP, file, …) fed in via OperationDispatcher
 * for APM and custom observers to consume (§4.1#4, §16). Minimal base; adapters refine `data`.
 */
export interface Operation {
  /** Operation kind, e.g. 'http' | 'db' | 'file' (adapter-defined). */
  type: string;
  /** Wall-clock start time in unix-ms. */
  timestamp: number;
  /** Optional human-readable description. */
  description?: string;
  /** Adapter-specific payload. */
  data?: Record<string, unknown>;
}

export type OperationObserver = (operation: Operation) => void;

/** Bridge for external libs / build-time injection; fans out operations to its own observers (§16.2). */
export interface OperationDispatcher {
  /** Subscribe an observer; returns an unsubscribe function. */
  registerObserver(observer: OperationObserver): () => void;
  /** Feed in an operation (called by middleware / injected code). */
  onOperation(operation: Operation): void;
}

/**
 * A source that owns a runtime hook and emits captured events to its listeners (§16.2). It is a
 * listenable emitter: by extending {@link EventSubscribable} it lets other components subscribe to its
 * processing STAGES (`StageMap` maps stage name → payload — e.g. the network interceptor keys by
 * NetworkStage) through the contract alone, without the concrete impl. Observe-only: the contract
 * exposes the listener side (on/off/once/…), not emit — only the interceptor fires its own stages.
 * Client-independent: it emits via its own emitter, not a hub. Activation is explicit (start/stop) OR
 * driven by subscriber presence; {@link InterceptorBase} provides the reusable implementation.
 */
export interface Interceptor<StageMap = Record<never, never>> extends EventSubscribable<StageMap> {
  /** Component id. */
  name: string;
  /** Explicitly activate (install the runtime hook); subscriber presence also activates. Idempotent. */
  start(): void;
  /** Explicitly deactivate; subscriber presence may keep it active. */
  stop(): void;
}

/**
 * A single captured item (Android BugseeCaptureDataEntry parity). It carries its file type, a
 * timestamp and the structured payload, AND owns its serialization: serialize() produces the stored
 * string form; deserialize() populates THIS (freshly-created) entry from that form (Android-style
 * instance deserialize, mutating `this`). Concrete entry types implement their own format — see
 * CaptureDataEntryBase for the default JSON entry.
 */
export interface CaptureDataEntry {
  /** Which bundle file this entry contributes to. */
  readonly type: FileType;
  /** Wall-clock unix-ms; used for ordering and time bounds. */
  timestamp: number;
  /** The structured payload (what lands in the bundle file). */
  data: unknown;
  /** Serialize this entry to its stored string form. */
  serialize(): string;
  /** Populate this entry from its stored string form (mutates `this`; Android instance deserialize). */
  deserialize(serialized: string): void;
}

/** Creates an empty entry of a given file type for the exporter to deserialize into. */
export type CaptureEntryFactory = (type: FileType) => CaptureDataEntry;

/** A serialized entry as persisted by the store (entry.serialize() output + out-of-band routing/time). */
export interface StoredEntry {
  /** Which bundle file this record belongs to. */
  type: FileType;
  /** Wall-clock unix-ms, kept out-of-band so ordering/time-bounds need no deserialize. */
  timestamp: number;
  /** The entry's serialized string form. */
  serialized: string;
  /**
   * Tenant/owner key for store partitioning, kept out-of-band for the same reason as `timestamp` — a store
   * must route on it without deserializing. Set from the active `RequestContext.owner`; `undefined` on the
   * single-tenant path, where partitioning is a no-op.
   *
   * Exists because Durable Objects for different tenants share one isolate, one client and one capture ring
   * (docs/design/cloudflare-tenant-isolation.md).
   */
  owner?: string;
}

/**
 * The live, partitioned capture store (Android CapturePartManager paradigm). Records are routed into
 * the current 1-second PART; `tick(nowMs)` rotates the current part and evicts parts outside the
 * recording window (so the live store is always ~the last maxRecordingTime seconds); `snapshot()`
 * freezes the current in-window records into a CaptureSnapshot for export, divorced from the rolling
 * window — capture keeps writing + GC'ing while the snapshot is read, then released. Runtime-specific:
 * in-memory (lambda/edge), on disk (Node/Bun via chunk-dirs), IndexedDB (browser). `add` is
 * fire-and-forget — it must never block or throw the capture path.
 */
export interface CaptureStore {
  /** Route a serialized record into the current part. Non-blocking; failures are the store's concern. */
  add(record: StoredEntry): void;
  /**
   * Close the current part, open a new one, and evict parts outside the recording window. Called
   * ~every second with the current wall-clock ms (driven by the Client; edge/lambda may skip it).
   */
  tick(nowMs: number): void;
  /** Freeze the current in-window records into a snapshot for export; the live store keeps rolling. */
  snapshot(): CaptureSnapshot;
  /** Discard all live records. */
  clear(): void;
}

// Service token for the capture store: core owns the contract; the platform supplies the impl (in-memory
// / file / IndexedDB) and the client registers the resolved store, resolvable process-wide.
export const CaptureStoreToken = serviceToken<CaptureStore>('captureStore');

/**
 * A frozen, read-once view of captured records (Android snapshot parity), divorced from the live
 * store's rolling window so capture continues during export. Read it (stream one-by-one, or drainAll
 * grouped by file type), then release() to delete its frozen copy once the bundle is built.
 */
export interface CaptureSnapshot {
  /** Stream the snapshot's records one-by-one (oldest-to-newest across parts). */
  stream(): AsyncIterableIterator<StoredEntry>;
  /** Read all snapshot records grouped by file type. */
  drainAll(): Promise<Map<FileType, StoredEntry[]>>;
  /** Delete the snapshot's frozen copy; called after the bundle is built. */
  release(): void;
}

/**
 * The single data adapter every provider feeds (Android BugseeCaptureAggregator parity). Data flows
 * ONE direction: accept an entry → transform (entry.serialize()) → route the record to the
 * CaptureStore. Read-back is deliberately NOT here — it belongs to CaptureExporter.
 */
export interface CaptureAggregator {
  /** Accept one entry: serialize it and route the record to the store. */
  addEntry(entry: CaptureDataEntry): void;
  /** Accept many entries. */
  addEntries(entries: readonly CaptureDataEntry[]): void;
  /** Drop all stored records. */
  clear(): void;
}

/**
 * Reads captured data back for export (Android CaptureExporter parity). Internally it takes a
 * CaptureSnapshot of the store, deserializes its records (via a per-type CaptureEntryFactory) and
 * returns them streaming (one-by-one) or all-at-once (grouped by file type), then releases the
 * snapshot — the live store keeps rolling throughout (no drain-on-read).
 */
export interface CaptureExporter {
  /** Snapshot the store, stream deserialized entries one-by-one, then release the snapshot. */
  stream(): AsyncIterableIterator<CaptureDataEntry>;
  /** Snapshot the store, read + deserialize all entries grouped by file type, then release (§7.7). */
  drain(): Promise<Map<FileType, CaptureDataEntry[]>>;
}

/**
 * The capture-pipeline dependencies a CaptureProvider needs for its whole lifetime (Android
 * BugseeCaptureDataProviderInit parity): the operation bridge and the aggregator it pushes entries
 * to. Supplied ONCE via {@link CaptureProvider.init} at registration — NOT at start — so
 * start(options) is free to (re)configure behavior per launch without re-wiring deps. Source events
 * arrive by subscribing to interceptors directly (there is no hub), so a provider is wired to its
 * source(s) separately. Deliberately a subset of {@link Client} that EXCLUDES the registration seams.
 */
export interface CaptureProviderInit {
  /** Operation bridge for adapters/build injection (§16.2). */
  readonly operations: OperationDispatcher;
  /** The single data adapter the provider pushes captured entries to (§7.7). */
  readonly captureAggregator: CaptureAggregator;
}

/**
 * A read-only launch-options bag (Android OptionsContainer parity) passed to start(options) so a
 * component (re)configures its behavior per launch — e.g. network body-size limits, log level —
 * rather than re-initializing its dependencies. `get` returns the configured value, or the caller's
 * `fallback` when the key is absent; `has` reports presence. (Forward-compatible: keys/values become
 * `keyof BugseeOptions` once options.ts lands.)
 */
export interface OptionsContainer {
  /** Read a launch option by key, falling back to `fallback` when the key is absent. */
  get<T>(key: string, fallback: T): T;
  /** Whether a launch option is present. */
  has(key: string): boolean;
}

/**
 * The canonical launch-option identifier that gates a provider — a `BugseeOption.*` value (or an
 * extension's `*Option.*`, declaration-merged into `@bugsee/protocol`'s `BugseeOptionTypes`). Typed
 * as a literal union over the known identifiers for editor autocomplete + self-documentation, yet
 * still accepts any string: production providers assign a typed `BugseeOption` constant (so the
 * identifier is already checked at the source), and the coordinator resolves it by a runtime string
 * lookup in the option gate — so extension/platform-defined identifiers plug in without coupling this
 * core contract to a closed, per-compilation-unit key union.
 */
export type ControllingOption = keyof BugseeOptionTypes | (string & Record<never, never>);

/**
 * Capture-pipeline data source (§16.2), Android BugseeCaptureDataProvider parity. Lifecycle splits
 * dependency wiring from per-launch configuration:
 * - init(init): ONCE at registration — capture the pipeline deps (hubs/operations/aggregator).
 * - start(options): per launch — (re)configure from launch options, subscribe to its hub, and
 *   filter+sanitize each event into a CaptureDataEntry pushed to the aggregator. May be cycled
 *   (stop→start) across launches without re-init.
 * - stop(): unsubscribe / release hooks (the subscription, not a detached aggregator, is the gate).
 *
 * NB: this follows Android (works on CaptureDataEntry objects), not the design doc §16.2 sketch's
 * per-provider `wireFileType`/`filename`/`serialize`. File type lives on CaptureDataEntry.type and
 * serialization lives on the entry itself (serialize/deserialize).
 */
export interface CaptureProvider {
  /** Component id (Android @BugseeCaptureComponentName). */
  name: string;
  /** The launch option that gates this provider; when its option is false, the provider is skipped. */
  controllingOption?: ControllingOption;
  /** One-time: receive the capture-pipeline dependencies (Android constructor-init). */
  init(init: CaptureProviderInit): void;
  /** (Re)configure from launch options and begin capturing; may be cycled across launches. */
  start(options: OptionsContainer): void;
  stop(): void;
}

/** Decides when to assemble & upload a report (§16.2). */
export interface DetectionProvider {
  name: string;
  /** The launch option that gates this detector; when its option is false, the detector is skipped. */
  controllingOption?: ControllingOption;
  /** On detection, build a ReportingRequest and submit it via `report` (Android parity). */
  start(client: Client, report: (request: ReportingRequest) => void): void;
  stop(): void;
}

/** Feature module — registers providers, hub listeners, services, buffers, hooks (§16.2). */
export interface Extension {
  readonly name: string;
  setup(client: Client): void;
  stop(): void;
}

/**
 * The provider/extension-facing kernel surface (§16.3 registration seams). This is intentionally a
 * MINIMAL subset of the full §7.1 Client and is grown to the complete public API when the Client
 * implementation lands (task 8). The contracts above pass it to start()/setup().
 */
export interface Client {
  /** Operation bridge for adapters/build injection (§16.2). */
  readonly operations: OperationDispatcher;
  /** The single data adapter providers push captured entries to (§7.7). */
  readonly captureAggregator: CaptureAggregator;
  /** Register a capture data source (Android addProvider). */
  addCaptureProvider(provider: CaptureProvider): void;
  /** Register a report trigger. */
  addDetectionProvider(provider: DetectionProvider): void;
}
