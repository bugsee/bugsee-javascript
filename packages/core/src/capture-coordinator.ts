import type { CaptureProvider, CaptureProviderInit, OptionsContainer } from './contracts';

// Capture-provider lifecycle manager (Android BugseeCaptureCoordinator parity). Holds
// the capture-pipeline init (hubs/operations/aggregator) and injects it into each provider ONCE at
// registration (Android constructs providers with the init); then start(options) starts every
// enabled provider for the launch (the provider subscribes to its hub and buffers entries), stop()
// stops the started ones, and providers may be added after start. The trigger-time buffer→serialize
// wiring lives in the event pipeline.
//
// ISOLATED by design: a throwing provider.start/stop is reported (`onError`) and contained — it is best-effort
// stopped (it may have attached part of itself before throwing) and never prevents the providers after it from
// starting or stopping. One provider's hostile environment must not cost the customer every other capture.

/** Returns whether a launch option (by key) is enabled. */
export type OptionGate = (option: string) => boolean;

export interface CaptureCoordinator {
  /**
   * Register a provider (unique name) and init() it with the pipeline deps. If already running, the
   * provider is also started immediately (when enabled).
   */
  addProvider(provider: CaptureProvider): void;
  /** Start every enabled registered provider with the launch options. Throws if already started. */
  start(options: OptionsContainer, isEnabled: OptionGate): void;
  /** Stop all started providers; idempotent. */
  stop(): void;
  /** A copy of the registered providers. */
  readonly providers: readonly CaptureProvider[];
}

interface Session {
  options: OptionsContainer;
  gate: OptionGate;
}

export function createCaptureCoordinator(
  init: CaptureProviderInit,
  onError?: (error: unknown) => void,
): CaptureCoordinator {
  const report = (error: unknown): void => {
    try {
      onError?.(error);
    } catch {
      /* the reporter itself failed */
    }
  };
  const providers: CaptureProvider[] = [];
  const started = new Set<CaptureProvider>();
  let session: Session | null = null;

  const startProvider = (provider: CaptureProvider, active: Session): void => {
    if (provider.controllingOption === undefined || active.gate(provider.controllingOption)) {
      try {
        provider.start(active.options);
        started.add(provider);
      } catch (error) {
        report(error);
        try {
          provider.stop(); // it may be half started: release whatever it attached
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

    addProvider(provider: CaptureProvider): void {
      if (providers.some((p) => p.name === provider.name)) {
        throw new Error(`Capture provider "${provider.name}" is already registered`);
      }
      providers.push(provider);
      // Init once, at registration — deps are wired before any start, independent of enablement.
      provider.init(init);
      if (session !== null) {
        startProvider(provider, session);
      }
    },

    start(options: OptionsContainer, isEnabled: OptionGate): void {
      if (session !== null) {
        throw new Error('CaptureCoordinator is already started');
      }
      session = { options, gate: isEnabled };
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
