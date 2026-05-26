import type { AttributeValue, NameExtensionMapping } from '@bugsee/types';
import { createCaptureAggregator } from './capture-aggregator';
import { createCaptureCoordinator } from './capture-coordinator';
import type { Client } from './contracts';
import { createDetectionCoordinator } from './detection-coordinator';
import { createEnvironment } from './environment';
import { createExtensionRegistry } from './extension-registry';
import { createEventHubs } from './hubs';
import { createOperationDispatcher } from './operation-dispatcher';

// The Client facade (design §7.1) — the runtime-agnostic composition root that wires the kernel
// together. Built in slices; this slice covers the registration seams (§16.3) and identity/attribute
// delegation to the single global Environment (§7.2; Bugsee has no scope abstraction). Capture entry
// points, lifecycle, and report assembly land in subsequent slices. Platform specifics
// (EnvironmentEnvelope factory, BugseeApi/BundleUploader, DOM methods) are injected by the platform
// packages, not built here.

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
}

export function createClient(): BugseeClient {
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
  };
}
