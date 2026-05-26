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
 * The single data adapter every provider feeds (Android BugseeCaptureAggregator parity): it accepts
 * entries, buffers them per file-type (the in-memory store in bundle mode), and forwards to the data
 * store. snapshot() atomically drains for the trigger path (§7.7).
 */
export interface CaptureAggregator {
  /** Accept one entry, routing it to its file-type buffer. */
  addEntry(entry: CaptureDataEntry): void;
  /** Accept many entries. */
  addEntries(entries: readonly CaptureDataEntry[]): void;
  /** Atomically take and clear all buffered entries, grouped by file type (trigger snapshot). */
  snapshot(): Map<FileType, CaptureDataEntry[]>;
  /** Drop all buffered entries. */
  clear(): void;
}

/**
 * Capture-pipeline data source (§16.2). In start(client) it subscribes to its hub, filter+sanitizes
 * each event into a CaptureDataEntry, and pushes it to client.captureAggregator.addEntry(...).
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
