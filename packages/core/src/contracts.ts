import type { FileType } from '@bugsee/protocol';
import type { EventHubs } from './hubs';
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

/** A source that owns runtime hooks and emits to a hub (§16.2). */
export interface Interceptor {
  /** Component id. */
  name: string;
  start(client: Client): void;
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
 * The minimal file-system primitive a file-based runtime supplies (node:fs in @bugsee/node, Deno.* in
 * @bugsee/deno, electron-main) so the file-backed CaptureStore LOGIC can be shared via
 * createFileCaptureStore — only this primitive is platform-specific. Streams are named (one per file
 * type); the store owns the JSONL record encoding. Synchronous: local file-system ops are sync.
 */
export interface FileStorageAdapter {
  /** Append text to the named stream, creating it if absent. */
  append(name: string, data: string): void;
  /** Read the named stream as text, or undefined if it does not exist. */
  read(name: string): string | undefined;
  /** Names of all streams currently present. */
  names(): string[];
  /** Remove the named stream; a no-op if absent. */
  remove(name: string): void;
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
 * Capture-pipeline data source (§16.2). In start(client) it subscribes to its hub, filter+sanitizes
 * each event into a CaptureDataEntry, and pushes it to client.captureAggregator.addEntry(...).
 *
 * NB: this follows Android (BugseeCaptureDataProvider works on CaptureDataEntry objects), not the
 * design doc §16.2 sketch's per-provider `wireFileType`/`filename`/`serialize`. File type lives on
 * CaptureDataEntry.type and serialization lives on the entry itself (serialize/deserialize).
 */
export interface CaptureProvider {
  /** Component id (Android @BugseeCaptureComponentName). */
  name: string;
  // TODO: narrow to `keyof BugseeOptions` once options.ts lands (e.g. 'captureNetwork').
  /** The launch option that gates this provider; when false, the provider is skipped. */
  controllingOption?: string;
  start(client: Client): void;
  stop(): void;
}

/** Decides when to assemble & upload a report (§16.2). */
export interface DetectionProvider {
  name: string;
  // TODO: narrow to `keyof BugseeOptions` once options.ts lands.
  controllingOption?: string;
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
  /** Process-wide pub/sub hubs (§16.2). */
  readonly hubs: EventHubs;
  /** Operation bridge for adapters/build injection (§16.2). */
  readonly operations: OperationDispatcher;
  /** The single data adapter providers push captured entries to (§7.7). */
  readonly captureAggregator: CaptureAggregator;
  /** Register a capture data source (Android addProvider). */
  addCaptureProvider(provider: CaptureProvider): void;
  /** Register a report trigger. */
  addDetectionProvider(provider: DetectionProvider): void;
}
