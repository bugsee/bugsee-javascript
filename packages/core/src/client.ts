import type { LogLevel } from '@bugsee/protocol';
import type { AttributeValue, LogLevelName, NameExtensionMapping } from '@bugsee/types';
import { createCaptureAggregator } from './capture-aggregator';
import { createCaptureCoordinator } from './capture-coordinator';
import { type Clock, createSystemClock } from './clock';
import type { Client } from './contracts';
import { createDetectionCoordinator } from './detection-coordinator';
import { createEnvironment } from './environment';
import { createExtensionRegistry } from './extension-registry';
import { createEventHubs, type LogEvent } from './hubs';
import { createOperationDispatcher } from './operation-dispatcher';

// The Client facade (design §7.1) — the runtime-agnostic composition root that wires the kernel
// together. Built in slices: registration seams (§16.3) + identity/attribute delegation to the
// single global Environment (§7.2), and the manual capture entry points (this slice), which build a
// CaptureDataEntry and push it to the aggregator (breadcrumbs/logs/events/traces are all just data
// streams). Lifecycle, logException's trigger, and report assembly land in subsequent slices;
// platform specifics (EnvironmentEnvelope factory, BugseeApi/BundleUploader, DOM) are injected.

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
}

export interface CreateClientOptions {
  /** Time source; injectable for tests. Default createSystemClock(). */
  clock?: Clock;
}

export function createClient(options: CreateClientOptions = {}): BugseeClient {
  const clock = options.clock ?? createSystemClock();
  const environment = createEnvironment();
  const hubs = createEventHubs();
  const operations = createOperationDispatcher();
  const captureAggregator = createCaptureAggregator();
  const captureCoordinator = createCaptureCoordinator();
  const detectionCoordinator = createDetectionCoordinator();
  const extensionRegistry = createExtensionRegistry();

  return {
    hubs,
    operations,
    captureAggregator,

    addCaptureProvider: captureCoordinator.addProvider,
    addDetectionProvider: detectionCoordinator.addProvider,

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
  };
}
