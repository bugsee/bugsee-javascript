import type { OptionGate } from './capture-coordinator';
import type { Client, DetectionProvider } from './contracts';
import type { ReportingRequest } from './reporting';

// Detection-provider lifecycle manager (design §16.3, Android BugseeDetectionCoordinator parity).
// Mirrors the capture coordinator, but each provider's start receives a `report` callback: the
// coordinator wires it to a single onReport sink (the pipeline's report-assembly entry, §7.7).
// Re-entrancy/queue guarding of submitted requests belongs to the pipeline, not here.

export type ReportListener = (request: ReportingRequest) => void;

export interface DetectionCoordinator {
  /** Register a provider (unique name). If already running, the provider is started immediately. */
  addProvider(provider: DetectionProvider): void;
  /** Start every enabled provider, wiring each provider's report callback to onReport. Throws if started. */
  start(client: Client, isEnabled: OptionGate, onReport: ReportListener): void;
  /** Stop all started providers; idempotent. */
  stop(): void;
  /** A copy of the registered providers. */
  readonly providers: readonly DetectionProvider[];
}

interface Session {
  client: Client;
  gate: OptionGate;
  onReport: ReportListener;
}

export function createDetectionCoordinator(): DetectionCoordinator {
  const providers: DetectionProvider[] = [];
  const started = new Set<DetectionProvider>();
  let session: Session | null = null;

  const startProvider = (provider: DetectionProvider, active: Session): void => {
    if (provider.controllingOption === undefined || active.gate(provider.controllingOption)) {
      provider.start(active.client, active.onReport);
      started.add(provider);
    }
  };

  return {
    get providers() {
      return [...providers];
    },

    addProvider(provider: DetectionProvider): void {
      if (providers.some((p) => p.name === provider.name)) {
        throw new Error(`Detection provider "${provider.name}" is already registered`);
      }
      providers.push(provider);
      if (session !== null) {
        startProvider(provider, session);
      }
    },

    start(client: Client, isEnabled: OptionGate, onReport: ReportListener): void {
      if (session !== null) {
        throw new Error('DetectionCoordinator is already started');
      }
      session = { client, gate: isEnabled, onReport };
      for (const provider of providers) {
        startProvider(provider, session);
      }
    },

    stop(): void {
      for (const provider of started) {
        provider.stop();
      }
      started.clear();
      session = null;
    },
  };
}
