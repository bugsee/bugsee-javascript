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
  const stopQuietly = (provider: DetectionProvider): void => {
    try {
      provider.stop();
    } catch {
      /* best-effort; the start failure (if any) is the one reported */
    }
  };
  const providers: DetectionProvider[] = [];
  const started = new Set<DetectionProvider>();
  let session: Session | null = null;

  const startProvider = (provider: DetectionProvider, active: Session): void => {
    try {
      // The gate is inside the guard too: a throwing option gate costs that provider, not the whole start.
      if (provider.controllingOption !== undefined && !active.gate(provider.controllingOption)) {
        return;
      }
      provider.start(active.client, active.onReport);
      if (session !== active) {
        stopQuietly(provider); // stopped (maybe relaunched) while starting: do not record it on the dead session
        return;
      }
      started.add(provider);
    } catch (error) {
      stopQuietly(provider); // unwind BEFORE reporting, so a relaunching reporter is not undone
      report(error);
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
      const active: Session = { client, gate: isEnabled, onReport };
      session = active;
      for (const provider of providers) {
        if (session !== active) break; // stopped mid-start (e.g. by a reporter): do not start on a dead session
        startProvider(provider, active);
      }
    },

    stop(): void {
      const running = [...started];
      started.clear();
      session = null;
      const errors: unknown[] = [];
      for (const provider of running) {
        try {
          provider.stop();
        } catch (error) {
          errors.push(error);
        }
      }
      for (const error of errors) report(error); // after every stop(): a relaunching reporter is not undone
    },
  };
}
