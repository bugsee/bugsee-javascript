import type { CaptureProvider, Client } from './contracts';

// Capture-provider lifecycle manager (design §16.3, Android BugseeCaptureCoordinator parity).
// Starts each registered provider whose controllingOption is enabled (the provider then subscribes
// to its hub and buffers entries), stops the started ones, and supports adding providers after
// start. The trigger-time buffer→serialize wiring lives in the event pipeline (§7.7).
//
// Deterministic by design: a throwing provider.start propagates. The Client wraps start() to honor
// the "launch never throws" guarantee (§15.1).

/** Returns whether a launch option (by key) is enabled. */
export type OptionGate = (option: string) => boolean;

export interface CaptureCoordinator {
  /** Register a provider (unique name). If already running, the provider is started immediately. */
  addProvider(provider: CaptureProvider): void;
  /** Start every enabled registered provider. Throws if already started. */
  start(client: Client, isEnabled: OptionGate): void;
  /** Stop all started providers; idempotent. */
  stop(): void;
  /** A copy of the registered providers. */
  readonly providers: readonly CaptureProvider[];
}

interface Session {
  client: Client;
  gate: OptionGate;
}

export function createCaptureCoordinator(): CaptureCoordinator {
  const providers: CaptureProvider[] = [];
  const started = new Set<CaptureProvider>();
  let session: Session | null = null;

  const startProvider = (provider: CaptureProvider, active: Session): void => {
    if (provider.controllingOption === undefined || active.gate(provider.controllingOption)) {
      provider.start(active.client);
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
      if (session !== null) {
        startProvider(provider, session);
      }
    },

    start(client: Client, isEnabled: OptionGate): void {
      if (session !== null) {
        throw new Error('CaptureCoordinator is already started');
      }
      session = { client, gate: isEnabled };
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
