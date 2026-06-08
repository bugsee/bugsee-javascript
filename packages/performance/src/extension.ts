import { type BugseeClient, ClockToken } from '@bugsee/core';
import { createPerformanceController, type PerformanceApi } from './controller';
import { createTransactionStore, type TransactionStore } from './transaction-store';

// The @bugsee/performance extension shell (design §0.6/§16). There is no addExtension lifecycle on the
// client yet, so the launch / umbrella wires it directly: build it, call setup(client) to register the
// ext('performance') API (the controller, over the injected clock + a shared store), and stop() to tear
// it down. The active span API + transaction buffering are live now; the web-vitals capture, the bundle
// performance.json emission, and the continuous /v2/performance/transactions upload land in later slices.

declare module '@bugsee/types' {
  interface NameExtensionMapping {
    performance: PerformanceApi;
  }
}

export interface PerformanceExtensionOptions {
  appVersion?: string;
  appBuild?: string;
  /** Head sampling decision (built from performanceSampleRate by the launch). Default: sample all. */
  sampler?: () => boolean;
  /** Buffer capacity before FIFO eviction. Default 100. */
  maxTransactions?: number;
  /** Injectable transaction buffer (tests, or a launch that wires its own drains). */
  store?: TransactionStore;
}

export interface PerformanceExtension {
  readonly name: 'performance';
  /** The transaction buffer, exposed so the launch can drain it into the bundle / continuous upload. */
  readonly store: TransactionStore;
  /** Register the ext('performance') API on the (full) client. */
  setup(client: BugseeClient): void;
  /** Tear down (no long-lived resources yet — observers/uploader teardown lands with those slices). */
  stop(): void;
}

export function createPerformanceExtension(
  options: PerformanceExtensionOptions = {},
): PerformanceExtension {
  const store =
    options.store ?? createTransactionStore({ maxTransactions: options.maxTransactions });
  return {
    name: 'performance',
    store,
    setup(client) {
      const clock = client.getService(ClockToken);
      const api = createPerformanceController({
        clock,
        store,
        ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {}),
        ...(options.appBuild !== undefined ? { appBuild: options.appBuild } : {}),
        ...(options.sampler !== undefined ? { sampler: options.sampler } : {}),
      });
      client.registerExt('performance', api);
    },
    stop() {},
  };
}
