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
  const stopQuietly = (provider: CaptureProvider): void => {
    try {
      provider.stop();
    } catch {
      /* best-effort; the start failure (if any) is the one reported */
    }
  };
  const providers: CaptureProvider[] = [];
  const started = new Set<CaptureProvider>();
  let session: Session | null = null;

  const startProvider = (provider: CaptureProvider, active: Session): void => {
    try {
      // The gate is inside the guard too: a throwing option gate costs that provider, not the whole start.
      if (provider.controllingOption !== undefined && !active.gate(provider.controllingOption)) {
        return;
      }
      provider.start(active.options);
      if (session !== active) {
        // Stopped (and maybe relaunched) while this provider was starting: it must not be recorded against the
        // dead session, so release it now.
        stopQuietly(provider);
        return;
      }
      started.add(provider);
    } catch (error) {
      // Unwind BEFORE reporting: a reporter may stop and relaunch, and a stale stop afterwards would unhook the
      // provider the new session just started.
      stopQuietly(provider); // it may be half started: release whatever it attached
      report(error);
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
      const active: Session = { options, gate: isEnabled };
      session = active;
      for (const provider of providers) {
        // A reporter (or provider) may have stopped this coordinator mid-start: the session is gone, so stop here
        // rather than start providers on a dead session.
        if (session !== active) break;
        startProvider(provider, active);
      }
    },

    stop(): void {
      // Detach the session first and report only AFTER every stop() has run: a reporter that relaunches would
      // otherwise have its fresh providers stopped by this (stale) loop.
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
      for (const error of errors) report(error);
    },
  };
}
