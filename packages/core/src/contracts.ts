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
 * The configurable storage backend the aggregator routes serialized records to (Android
 * CaptureFileStorage parity). Runtime-specific: in-memory (lambda/edge), on disk (Node/Bun),
 * IndexedDB (browser). `add` is fire-and-forget — it must never block or throw the capture path.
 * The reads (used only by CaptureExporter) drain raw serialized records, NOT deserialized entries.
 */
export interface CaptureStore {
  /** Persist a serialized record under its file type. Non-blocking; failures are the store's concern. */
  add(record: StoredEntry): void;
  /** Drain stored records one-by-one then clear — memory-light for disk/IDB (Android stream reader). */
  stream(): AsyncIterableIterator<StoredEntry>;
  /** Drain all stored records into memory grouped by file type, then clear. */
  drainAll(): Promise<Map<FileType, StoredEntry[]>>;
  /** Discard all stored records without reading them. */
  clear(): void;
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
 * Reads stored records back, deserializes them (via a per-type CaptureEntryFactory) and returns them
 * in the requested format (Android CaptureExporter / CaptureDataEntryStreamReader parity): stream()
 * one-by-one (default, memory-light) or drain() all-at-once grouped by file type. Both consume
 * (clear) the underlying store.
 */
export interface CaptureExporter {
  /** Stream deserialized entries one-by-one (then the store is cleared). */
  stream(): AsyncIterableIterator<CaptureDataEntry>;
  /** Read + deserialize all stored entries grouped by file type, then clear (§7.7 trigger snapshot). */
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
