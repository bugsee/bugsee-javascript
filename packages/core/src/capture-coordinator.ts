import type { CaptureProvider, CaptureProviderInit, OptionsContainer } from './contracts';

// Capture-provider lifecycle manager (design §16.3, Android BugseeCaptureCoordinator parity). Holds
// the capture-pipeline init (hubs/operations/aggregator) and injects it into each provider ONCE at
// registration (Android constructs providers with the init); then start(options) starts every
// enabled provider for the launch (the provider subscribes to its hub and buffers entries), stop()
// stops the started ones, and providers may be added after start. The trigger-time buffer→serialize
// wiring lives in the event pipeline (§7.7).
//
// Deterministic by design: a throwing provider.start propagates. The Client wraps start() to honor
// the "launch never throws" guarantee (§15.1).

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

export function createCaptureCoordinator(init: CaptureProviderInit): CaptureCoordinator {
  const providers: CaptureProvider[] = [];
  const started = new Set<CaptureProvider>();
  let session: Session | null = null;

  const startProvider = (provider: CaptureProvider, active: Session): void => {
    if (provider.controllingOption === undefined || active.gate(provider.controllingOption)) {
      provider.start(active.options);
      started.add(provider);
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
        provider.stop();
      }
      started.clear();
      session = null;
    },
  };
}
