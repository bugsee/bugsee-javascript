import type { LogLevel } from '@bugsee/protocol';
import type { AttributeValue, LogLevelName, NameExtensionMapping } from '@bugsee/types';
import { createCaptureAggregator } from './capture-aggregator';
import { createCaptureCoordinator, type OptionGate } from './capture-coordinator';
import { type Clock, createSystemClock } from './clock';
import type { CaptureStore, Client } from './contracts';
import { createDetectionCoordinator } from './detection-coordinator';
import { createEnvironment } from './environment';
import { createExtensionRegistry } from './extension-registry';
import { createEventHubs, type LogEvent } from './hubs';
import { createMemoryCaptureStore } from './memory-capture-store';
import { createOperationDispatcher } from './operation-dispatcher';
import type { UploadPipeline } from './transport';
import type { TriggerPipeline } from './trigger-pipeline';

// The Client facade (design §7.1) — the runtime-agnostic composition root that wires the kernel
// together. Built in slices: registration seams (§16.3) + identity/attribute delegation to the
// single global Environment (§7.2), manual capture entry points (push CaptureDataEntry to the
// aggregator), and lifecycle (launch/stop/flush). The report-assembly trigger + upload pipelines are
// injected (built by the platform tier from BugseeApi/BundleUploader + the report assembler);
// logException's trigger and the assembler itself land in the next slice.

/** A breadcrumb payload (design §10). */
export interface Breadcrumb {
  type?: string;
  category?: string;
  message?: string;
  level?: LogLevelName;
  data?: Record<string, unknown>;
  timestamp: number;
}

/** addBreadcrumb input: timestamp is optional (the Client stamps it from the clock). */
export type BreadcrumbInput = Omit<Breadcrumb, 'timestamp'> & { timestamp?: number };

/** The public client surface, extending the provider-facing {@link Client} (grown per slice). */
export interface BugseeClient extends Client {
  registerExt<K extends keyof NameExtensionMapping>(name: K, api: NameExtensionMapping[K]): void;
  ext<K extends keyof NameExtensionMapping>(name: K): NameExtensionMapping[K];

  setUserIdentifier(id: string): void;
  getUserIdentifier(): string | null;
  clearUserIdentifier(): void;

  setAttribute(key: string, value: AttributeValue): void;
  getAttribute(key: string): AttributeValue | undefined;
  clearAttribute(key: string): void;
  clearAllAttributes(): void;
  getAllAttributes(): Record<string, AttributeValue>;

  // Manual capture entry points (Android parity, §7.1). Each pushes a CaptureDataEntry.
  addBreadcrumb(breadcrumb: BreadcrumbInput): void;
  log(message: string, level?: LogLevel | LogLevelName, timestamp?: number): void;
  event(name: string, params?: Record<string, unknown>): void;
  trace(name: string, value: unknown): void;

  // Lifecycle (§7.1).
  /** Start capture + detection. Idempotent — a second call while launched is ignored. */
  launch(): void;
  isLaunched(): boolean;
  /** Stop capture + detection and drain pending uploads. Resolves true if drained within `timeout`. */
  stop(timeout?: number): Promise<boolean>;
  /** Drain pending uploads. Resolves true if drained within `timeout`. */
  flush(timeout?: number): Promise<boolean>;
}

export interface CreateClientOptions {
  /** Time source; injectable for tests. Default createSystemClock(). */
  clock?: Clock;
  /** Capture storage backend (disk/IndexedDB on platform tiers). Default in-memory. */
  captureStore?: CaptureStore;
  /** Which capture/detection options are enabled (gates the coordinators). Default: all enabled. */
  isEnabled?: OptionGate;
  /** Upload pipeline (built by the platform from BugseeApi/BundleUploader); enables flush/stop drain. */
  uploadPipeline?: UploadPipeline;
  /** Trigger pipeline (assembles + uploads reports); detection submissions route here. */
  triggerPipeline?: TriggerPipeline;
}

export function createClient(options: CreateClientOptions = {}): BugseeClient {
  const clock = options.clock ?? createSystemClock();
  const isEnabled = options.isEnabled ?? (() => true);
  const environment = createEnvironment();
  const hubs = createEventHubs();
  const operations = createOperationDispatcher();
  const captureAggregator = createCaptureAggregator(
    options.captureStore ?? createMemoryCaptureStore(),
  );
  const captureCoordinator = createCaptureCoordinator();
  const detectionCoordinator = createDetectionCoordinator();
  const extensionRegistry = createExtensionRegistry();
  let launched = false;

  // The provider/extension-facing surface (§16.3) passed to providers at start().
  const context: Client = {
    hubs,
    operations,
    captureAggregator,
    addCaptureProvider: captureCoordinator.addProvider,
    addDetectionProvider: detectionCoordinator.addProvider,
  };

  return {
    ...context,

    registerExt: extensionRegistry.registerExt,
    ext: extensionRegistry.ext,

    setUserIdentifier: environment.setUserIdentifier,
    getUserIdentifier: environment.getUserIdentifier,
    clearUserIdentifier: environment.clearUserIdentifier,

    setAttribute: environment.setAttribute,
    getAttribute: environment.getAttribute,
    clearAttribute: environment.clearAttribute,
    clearAllAttributes: environment.clearAllAttributes,
    getAllAttributes: environment.getAllAttributes,

    addBreadcrumb(breadcrumb: BreadcrumbInput): void {
      const timestamp = breadcrumb.timestamp ?? clock.wallNow();
      captureAggregator.addEntry({
        type: 'breadcrumbs',
        timestamp,
        data: { ...breadcrumb, timestamp },
      });
    },

    log(message: string, level: LogLevel | LogLevelName = 'info', timestamp?: number): void {
      const ts = timestamp ?? clock.wallNow();
      const entry: LogEvent = { timestamp: ts, level, source: 'logger', message };
      captureAggregator.addEntry({ type: 'log', timestamp: ts, data: entry });
    },

    event(name: string, params?: Record<string, unknown>): void {
      const timestamp = clock.wallNow();
      captureAggregator.addEntry({
        type: 'events.user',
        timestamp,
        data: { timestamp, name, ...(params !== undefined ? { params } : {}) },
      });
    },

    trace(name: string, value: unknown): void {
      const timestamp = clock.wallNow();
      captureAggregator.addEntry({
        type: 'traces.user',
        timestamp,
        data: { timestamp, name, value },
      });
    },

    isLaunched(): boolean {
      return launched;
    },

    launch(): void {
      if (launched) {
        return;
      }
      launched = true;
      captureCoordinator.start(context, isEnabled);
      detectionCoordinator.start(context, isEnabled, (request) => {
        void options.triggerPipeline?.report(request);
      });
    },

    stop(timeout?: number): Promise<boolean> {
      if (!launched) {
        return Promise.resolve(true);
      }
      launched = false;
      captureCoordinator.stop();
      detectionCoordinator.stop();
      return options.uploadPipeline?.flush(timeout) ?? Promise.resolve(true);
    },

    flush(timeout?: number): Promise<boolean> {
      return options.uploadPipeline?.flush(timeout) ?? Promise.resolve(true);
    },
  };
}
