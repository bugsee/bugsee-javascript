import { type BugseeClient, ClockToken, type FilterStore, FiltersToken } from '@bugsee/core';
import {
  createPerformanceCaptureProvider,
  type PerformanceCaptureProvider,
} from './capture-provider';
import { createPerformanceController, type PerformanceApi } from './controller';
import type { TransactionWire } from './span';
import { applySpanFilter } from './span-filter';
import { createTransactionStore, type TransactionStore } from './transaction-store';

// The @bugsee/performance extension shell (design §0.6/§16). There is no addExtension lifecycle on the
// client yet, so the launch / umbrella wires it directly: build it, call setup(client) to register the
// ext('performance') API (the controller, over the injected clock + a shared store), and stop() to tear
// it down. setup takes the FULL BugseeClient (not the core minimal `Client` contract) deliberately — it
// needs getService(ClockToken) + registerExt, which the minimal Client lacks; reconcile when an
// addExtension lifecycle lands (the minimal Client would have to grow those, or Extension.setup widen).
// The active span API + transaction buffering are live now; the web-vitals capture, the bundle
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
  /**
   * Record an EXTERNALLY-finished transaction (one that did not go through `startTransaction().finish()`
   * — e.g. the Node `app.start` startup transaction or a consumed OTel span assembled into a §8.8
   * transaction). Dual-writes to BOTH sinks — the continuous-upload store AND the incident-bundle capture
   * ring — mirroring what the controller's onFinish does for head-sampled transactions, so these reach
   * `performance.json` too. A no-op on the ring before setup() (the provider does not exist yet).
   */
  recordExternal(transaction: TransactionWire): void;
  /** Tear down (no long-lived resources yet — observers/uploader teardown lands with those slices). */
  stop(): void;
}

export function createPerformanceExtension(
  options: PerformanceExtensionOptions = {},
): PerformanceExtension {
  const store =
    options.store ?? createTransactionStore({ maxTransactions: options.maxTransactions });
  // The `performance` capture provider — routes finished transactions into the capture ring (the bundle's
  // performance.json), alongside the store's continuous /v2 upload. Created in setup() once the client is
  // available; `recordExternal` also feeds it (hence the closure-scoped handle).
  let provider: PerformanceCaptureProvider | undefined;
  // The redaction seam, resolved at setup(). `recordExternal` is documented as callable BEFORE setup,
  // so this stays undefined until then and the filter simply does not run yet — there is no client to
  // have configured one on.
  let filters: FilterStore | undefined;
  const filterTransaction = (transaction: TransactionWire): TransactionWire | null =>
    applySpanFilter(transaction, filters?.span ?? null, (error) => filters?.onError(error));
  return {
    name: 'performance',
    store,
    setup(client) {
      const clock = client.getService(ClockToken);
      filters = client.getService(FiltersToken);
      provider = createPerformanceCaptureProvider();
      const api = createPerformanceController({
        clock,
        store,
        onFinished: (wire) => provider?.record(wire),
        filterTransaction,
        ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {}),
        ...(options.appBuild !== undefined ? { appBuild: options.appBuild } : {}),
        ...(options.sampler !== undefined ? { sampler: options.sampler } : {}),
      });
      client.addCaptureProvider(provider); // started immediately (the client is already launched)
      client.registerExt('performance', api);
    },
    recordExternal(transaction) {
      // Filtered HERE as well as in the controller: this is the path a consumed OpenTelemetry span takes,
      // which is the one that arrives carrying `db.statement`, GenAI prompts and HTTP bodies verbatim.
      const filtered = filterTransaction(transaction);
      if (filtered === null) {
        return;
      }
      store.add(filtered); // continuous /v2 (+ OTLP tee) upload
      provider?.record(filtered); // incident-bundle performance.json
    },
    stop() {},
  };
}
