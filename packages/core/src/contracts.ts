import type { FileType, SourceType } from '@bugsee/protocol';
import type { SeverityName } from '@bugsee/types';
import type { EventHubs } from './hubs';

// The Android-derived extension contracts (design §16.2). Sources (Interceptor / adapters via
// OperationDispatcher) emit to hubs; consumers (CaptureProvider / DetectionProvider) and feature
// modules (Extension) plug in through these seams (§16.3). Type-only; validated by contracts.test-d.ts.
//
// Several supporting types the design references are left unspecified there (Operation,
// OperationObserver, TriggerHint); they are given MINIMAL cross-runtime base shapes here (the
// adapter/detection tiers refine them), matching the InputEvent approach.

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

/**
 * What a DetectionProvider passes to report assembly to explain why a report is being triggered
 * (§7.7 trigger path). Minimal base; event-level fields come exclusively from the hint (§7.2).
 */
export interface TriggerHint {
  /** Maps to request.json `source.type`. */
  source: SourceType;
  /** Report severity; downstream applies a default when omitted. */
  severity?: SeverityName;
  summary?: string;
  description?: string;
  /** Originating error/value when triggered by an exception. */
  error?: unknown;
}

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

/** Capture-pipeline data source — one per wire file-type (§16.2). */
export interface CaptureProvider<T = unknown> {
  /** Component id (Android @BugseeCaptureComponentName). */
  name: string;
  /** The wire file-type this provider contributes to the bundle. */
  wireFileType: FileType;
  /** Default in-bundle filename for the contributed file. */
  filename: string;
  // TODO: narrow to `keyof BugseeOptions` once options.ts lands (e.g. 'captureNetwork').
  /** The launch option that gates this provider; when false, the provider is skipped. */
  controllingOption?: string;
  start(client: Client): void;
  stop(): void;
  /** Serialize the provider's ring-buffer entries into a bundle file (§7.7 trigger). */
  serialize(entries: T[]): Uint8Array | string;
}

/** Decides when to assemble & upload a report (§16.2). */
export interface DetectionProvider {
  name: string;
  // TODO: narrow to `keyof BugseeOptions` once options.ts lands.
  controllingOption?: string;
  start(client: Client, trigger: (hint: TriggerHint) => void): void;
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
  /** Register a capture data source (Android addProvider). */
  addCaptureProvider(provider: CaptureProvider): void;
  /** Register a report trigger. */
  addDetectionProvider(provider: DetectionProvider): void;
}
