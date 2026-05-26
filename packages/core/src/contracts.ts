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
 * A single captured item a provider produces (Android BugseeCaptureDataEntry parity). The aggregator
 * routes it to the bundle file named by `type`; `data` is the wire-shaped payload (e.g. a
 * NetworkEvent or LogEvent). Serialization is the entry's/export step's concern, not the provider's.
 */
export interface CaptureDataEntry {
  /** Which bundle file this entry contributes to. */
  type: FileType;
  /** Wall-clock unix-ms; used for ordering and time bounds. */
  timestamp: number;
  /** The wire payload for this entry. */
  data: unknown;
}

/**
 * The configurable storage backend the aggregator supplies entries to (Android CaptureFileStorage
 * parity). Large entries (e.g. network bodies) shouldn't be memory-only, so the backend is
 * runtime-specific: in-memory (lambda/edge), on disk (Node/Bun), IndexedDB (browser). `add` is
 * fire-and-forget — it must never block or throw the capture path; `drain` is async (disk/IDB reads).
 */
export interface CaptureStore {
  /** Persist an entry under its file type. Non-blocking; failures are the store's own concern. */
  add(entry: CaptureDataEntry): void;
  /**
   * Default export read: stream stored entries one-by-one (grouped by file type), then clear. Memory-
   * light — a disk/IndexedDB backend reads lazily without loading everything (Android
   * CaptureDataEntryStreamReader.readEntry parity).
   */
  stream(): AsyncIterableIterator<CaptureDataEntry>;
  /**
   * All-at-once export read: read every stored entry into memory grouped by file type, then clear.
   * For small data / edge-lambda where a single bulk extraction is simplest.
   */
  drain(): Promise<Map<FileType, CaptureDataEntry[]>>;
  /** Discard all stored entries without reading them. */
  clear(): void;
}

/**
 * The single data adapter every provider feeds (Android BugseeCaptureAggregator parity): it accepts
 * entries and supplies them to the configurable CaptureStore, then reads them back for export at
 * trigger time — streaming (default, one-by-one) or snapshot (all-at-once). Reads are async so
 * disk/IndexedDB backends fit.
 */
export interface CaptureAggregator {
  /** Accept one entry, supplying it to the store. */
  addEntry(entry: CaptureDataEntry): void;
  /** Accept many entries. */
  addEntries(entries: readonly CaptureDataEntry[]): void;
  /** Default export: stream stored entries one-by-one (grouped by file type), then clear. */
  stream(): AsyncIterableIterator<CaptureDataEntry>;
  /** All-at-once: read + clear all stored entries grouped by file type (§7.7 trigger snapshot). */
  snapshot(): Promise<Map<FileType, CaptureDataEntry[]>>;
  /** Drop all stored entries. */
  clear(): void;
}

/**
 * Capture-pipeline data source (§16.2). In start(client) it subscribes to its hub, filter+sanitizes
 * each event into a CaptureDataEntry, and pushes it to client.captureAggregator.addEntry(...).
 *
 * NB: this follows Android (BugseeCaptureDataProvider works on entries; CaptureExporter serializes
 * centrally), not the design doc §16.2 sketch's per-provider `wireFileType`/`filename`/`serialize`.
 * File type lives on CaptureDataEntry.type and serialization is centralized in bundle-assembler.
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
