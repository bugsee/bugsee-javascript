import type { OptionGate } from './capture-coordinator';
import type { Client, DetectionProvider } from './contracts';
import type { ReportingRequest } from './reporting';

// Detection-provider lifecycle manager (Android BugseeDetectionCoordinator parity).
// Mirrors the capture coordinator, but each provider's start receives a `report` callback: the
// coordinator wires it to a single onReport sink (the pipeline's report-assembly entry).
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

export function createDetectionCoordinator(
  onError?: (error: unknown) => void,
): DetectionCoordinator {
  // ISOLATED, like the capture coordinator: a throwing provider is reported and best-effort stopped, and never
  // prevents the providers after it from starting or stopping.
  const report = (error: unknown): void => {
    try {
      onError?.(error);
    } catch {
      /* the reporter itself failed */
    }
  };
  const providers: DetectionProvider[] = [];
  const started = new Set<DetectionProvider>();
  let session: Session | null = null;

  const startProvider = (provider: DetectionProvider, active: Session): void => {
    if (provider.controllingOption === undefined || active.gate(provider.controllingOption)) {
      try {
        provider.start(active.client, active.onReport);
        started.add(provider);
      } catch (error) {
        report(error);
        try {
          provider.stop();
        } catch {
          /* best-effort; the start failure is the one reported */
        }
      }
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
        try {
          provider.stop();
        } catch (error) {
          report(error);
        }
      }
      started.clear();
      session = null;
    },
  };
}
