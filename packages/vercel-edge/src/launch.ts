import { fetchTransport } from '@bugsee/browser-utils';
import {
  createConsoleInterceptor,
  createLogCaptureProvider,
  installNetworkCapture,
} from '@bugsee/capture';
import {
  type BugseeClient,
  type CaptureStore,
  CaptureStoreToken,
  type Clock,
  COMMON_OPTION_DEFINITIONS,
  createBugseeApi,
  createBundleUploader,
  createClient,
  createMemoryCaptureStore,
  createPartitionedCaptureStore,
  createServiceContainer,
  createUploadPipeline,
  defineService,
  getCarrierClient,
  getOrCreateInterceptor,
  getServiceManifests,
  type HttpRequestOptions,
  type HttpResponse,
  type HttpTransport,
  type RequestContext,
  resolveLaunchOptions,
  resolveMaxPartitions,
  type Scheduler,
  serviceToken,
  setCarrierClient,
  TransportToken,
} from '@bugsee/core';
import { BugseeOption, type PlatformType } from '@bugsee/protocol';
import { createEdgeUnhandledRejectionProvider, type EdgeGlobalEvents } from './detection';
import { buildEdgeEnvironment } from './environment';
import {
  createEdgeRequestContextStore,
  type EdgeContextStoreLogger,
  type EdgeRequestContextStore,
  type RunScopedStore,
} from './request-context-store';

// The edge composition root (docs/design/edge-runtime.md E4) — the fetch/memory analog of node's launch(),
// stripped for a V8 isolate: NO node:*/DOM, NO durable bundle queue / crash-recovery / IndexedDB (the isolate
// is ephemeral → memory-only), NO window/process detection. It assembles the runtime-agnostic kernel
// (createClient) with the WinterCG fetch transport + an in-memory capture store + the edge environment + the
// run()-only ALS context store, then wires console→log + network (fetch; xhr/ws/sse self-skip absent globals).
// Capture is INCIDENT-DRIVEN: nothing uploads until logException/crash; the upload then completes inside the
// request's `ctx.waitUntil(client.flush())` (the fetch-handler wrapper, E5). The edge context store is
// registered under EdgeContextStoreToken so the wrapper can open a per-request context via `run()`.

const SDK_VERSION = '0.0.0';
const DEFAULT_ENDPOINT = 'https://api.bugsee.com';
// Edge capture buffer ceiling (design §966: 10 MB on browser/edge).
const DEFAULT_MAX_DATA_SIZE_MB = 10;
// Mirrors the partitioned store's own default; kept here so the per-partition budget can be derived.
const DEFAULT_MAX_TENANT_PARTITIONS = 8;

const EDGE_OPTION_DEFINITIONS = [
  ...COMMON_OPTION_DEFINITIONS,
  { friendly: 'maxDataSize', key: BugseeOption.MaxDataSize, default: DEFAULT_MAX_DATA_SIZE_MB },
];

/** DI token for the edge request-context store — the fetch-handler wrapper (E5) resolves it to open a
 *  per-request context via `run()` (the same instance is also registered as the core ContextProvider). */
export const EdgeContextStoreToken = serviceToken<EdgeRequestContextStore>(
  'edge-request-context-store',
);

export interface BugseeEdgeLaunchOptions {
  /**
   * The run()-scoped async store backing per-request context. Default: probe `globalThis.AsyncLocalStorage`,
   * degrading to a single-slot fallback when absent.
   *
   * **Supply this on Cloudflare Workers.** `globalThis.AsyncLocalStorage` does NOT exist on `workerd` under
   * any compatibility flag — it is reachable only as an export of `node:async_hooks` — so the probe always
   * misses there and per-request context silently degrades (verified on real workerd; docs/review/
   * cloudflare.md SEV1 #3). This tier cannot import `node:async_hooks` itself without breaking bundles for
   * deployments that lack `nodejs_compat`, so the store is injected instead:
   *
   * ```ts
   * import { AsyncLocalStorage } from 'node:async_hooks';
   * launch(env.BUGSEE_TOKEN, { asyncLocalStorage: new AsyncLocalStorage() });
   * ```
   */
  asyncLocalStorage?: RunScopedStore<RequestContext>;
  /**
   * Keep each TENANT's capture in its own partition, so an incident uploads only the faulting tenant's
   * data. Set by `@bugsee/cloudflare`, where many Durable Objects for different customers share one
   * isolate and therefore one capture ring — the leak proven on real workerd
   * (docs/review/cloudflare.md SEV1 #2, docs/design/cloudflare-tenant-isolation.md).
   *
   * Default false: Vercel Edge and plain fetch handlers are single-tenant, and partitioning there would be
   * overhead with nothing to separate.
   */
  partitionCaptureByTenant?: boolean;
  /**
   * Max TENANT partitions retained when `partitionCaptureByTenant` is on (default 8). The `maxDataSize`
   * budget is DIVIDED across `maxTenantPartitions + 1` rings (the +1 is the unattributed default), so total
   * capture memory stays within `maxDataSize` no matter how many tenants appear.
   *
   * Dividing rather than replicating is deliberate: giving every partition the full budget put 9 x 10 MB
   * against a 128 MB Workers isolate — a measured 116 MB heap ceiling, leaving ~12 MB for the customer's own
   * code (docs/review/session-changes-review.md SEV1 #2).
   */
  maxTenantPartitions?: number;
  /** API origin (no trailing slash). Default https://api.bugsee.com. */
  endpoint?: string;
  /** SDK version reported in the environment. Default the package version. */
  sdkVersion?: string;
  /** app.package_id / app.version / app.build. */
  appId?: string;
  appVersion?: string;
  appBuild?: string;

  /** Capture console output as logs. Default true. */
  captureLogs?: boolean;
  /** Capture network (fetch; xhr/ws/sse/webtransport self-skip where the global is absent). Default true. */
  captureNetwork?: boolean;
  /** Capture request/response bodies (bounded read). Default true. */
  captureNetworkBodies?: boolean;
  /** Max captured request/response body size in bytes. Default 20480. */
  maxNetworkBodySize?: number;
  /** Capture a body even when its Content-Type is missing/blank. Default false. */
  captureNetworkBodyWithoutType?: boolean;
  /** Detect global `unhandledrejection` (floating-promise rejections). Default true. */
  detectCrashes?: boolean;

  /** Rolling recording window in seconds. Default 60. */
  maxRecordingTime?: number;
  /** Max captured data kept in the rolling buffer, in megabytes. Default 10. */
  maxDataSize?: number;
  /** Internal-error sink (provider-start / operation failures). Default no-op. */
  onError?: (error: unknown) => void;

  // Edge platform identity — vercel-edge passes 'edge-light'; @bugsee/cloudflare passes 'workers'.
  /** environment.platform.type. Default 'edge-light'. */
  platformType?: PlatformType;
  /** environment.platform.version. Default '' (edge exposes none). */
  runtimeVersion?: string;

  // Injectable seams (advanced / tests).
  /** HTTP primitive. Default the WinterCG fetch transport. */
  transport?: HttpTransport;
  /** Time source. Default the system clock. */
  clock?: Clock;
  /** Scheduler for the capture-store tick. Default global timers. */
  scheduler?: Scheduler;
  /** Capture store override. Default in-memory. */
  captureStore?: CaptureStore;
  /** Diagnostic logger for the context-store "AsyncLocalStorage unavailable" warning. */
  logger?: EdgeContextStoreLogger;
  /** Global event target for `unhandledrejection` detection; injectable for tests. Default `globalThis`. */
  globalTarget?: EdgeGlobalEvents;
  /** Carrier host for the per-isolate singleton; injectable for tests. Default `globalThis`. */
  carrier?: object;
}

/** The launched edge client — the public edge SDK surface. */
export type Bugsee = BugseeClient;

// Tag every SDK request with X-Bugsee-Internal so the network capture self-skips the SDK's own traffic.
const internalTagged =
  (transport: HttpTransport): HttpTransport =>
  (url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> =>
    transport(url, { ...options, headers: { ...options.headers, 'x-bugsee-internal': '1' } });

/** Launch the edge SDK. A per-isolate singleton (a repeat call is ignored). Returns the started client. */
export function launchEdge(appToken: string, options: BugseeEdgeLaunchOptions = {}): Bugsee {
  const sdkVersion = options.sdkVersion ?? SDK_VERSION;
  const baseUrl = options.endpoint ?? DEFAULT_ENDPOINT;
  const carrier = options.carrier;

  const alreadyLaunched = getCarrierClient<Bugsee>(carrier);
  if (alreadyLaunched !== undefined) {
    options.onError?.(
      new Error(
        'Bugsee.launch() called more than once in this isolate; the repeat call is ignored',
      ),
    );
    // A repeat launch that ASKED for tenant partitioning gets the first client's store, which may not
    // partition — e.g. `launchEdge(token)` ran first (it is re-exported by @bugsee/cloudflare) and a
    // Durable Object's lazy launcher then reuses it. The generic message above does not name that
    // consequence, and silence here is how the cross-tenant leak comes back (review pass 2, SEV3 #3).
    if (options.partitionCaptureByTenant === true) {
      // Guarded: this runs inside launch() against a client we did not create — it may lack the service,
      // be mid-teardown, or be a foreign object someone else placed on the carrier. A throw here would
      // break launch() itself, and the SDK crashing the host app at startup is far worse than the missing
      // warning it replaces.
      let existing: { owners?: () => string[] } | undefined;
      try {
        const store = (alreadyLaunched as unknown as { getService?: (t: unknown) => unknown })
          .getService;
        existing = store?.call(alreadyLaunched, CaptureStoreToken) as
          | { owners?: () => string[] }
          | undefined;
      } catch {
        existing = undefined; // unknown store kind → warn, which is the safe direction
      }
      if (existing?.owners === undefined) {
        options.onError?.(
          new Error(
            'Bugsee: this launch requested per-tenant isolation but an earlier launch in this isolate ' +
              'created a NON-partitioned client, which is reused. On Cloudflare that means one Durable ' +
              "Object incident can upload another tenant's capture. Launch via @bugsee/cloudflare first, " +
              'or do not call launchEdge directly.',
          ),
        );
      }
    }
    return alreadyLaunched;
  }

  const resolved = resolveLaunchOptions(
    options as unknown as Record<string, unknown>,
    EDGE_OPTION_DEFINITIONS,
  );

  const services = createServiceContainer();
  services.addService(
    defineService(TransportToken, () => internalTagged(options.transport ?? fetchTransport)),
  );
  const transport = services.getProvider(TransportToken).getImmediate();
  const api = createBugseeApi(transport, { baseUrl, appToken, sdkVersion });
  const uploader = createBundleUploader(transport);
  const uploadPipeline = createUploadPipeline({ api, uploader });

  const getEnvironment = () =>
    buildEdgeEnvironment({
      sdkVersion,
      platformType: options.platformType ?? 'edge-light',
      ...(options.runtimeVersion !== undefined ? { runtimeVersion: options.runtimeVersion } : {}),
      options: resolved.canonical,
      ...(options.appId !== undefined ? { appId: options.appId } : {}),
      ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {}),
      ...(options.appBuild !== undefined ? { appBuild: options.appBuild } : {}),
    });

  const maxRecordingTime = resolved.options.get(BugseeOption.Duration, 60);
  const maxDataSize = resolved.options.get(BugseeOption.MaxDataSize, DEFAULT_MAX_DATA_SIZE_MB);
  const memoryStoreOptions = {
    maxRecordingTimeMs: maxRecordingTime * 1000,
    maxDataSizeBytes: maxDataSize * 1024 * 1024,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  };
  const partitionByTenant = options.partitionCaptureByTenant === true;
  // The SAME coercion the store applies, so the divisor below and the store's bound can never disagree.
  const maxTenantPartitions = resolveMaxPartitions(options.maxTenantPartitions);
  // A caller-supplied store WINS over the partitioning switch — and that silently reinstates the
  // cross-tenant leak, so say so rather than failing open quietly.
  if (partitionByTenant && options.captureStore !== undefined) {
    options.onError?.(
      new Error(
        'Bugsee: partitionCaptureByTenant was requested but an explicit captureStore was supplied, so ' +
          'per-tenant isolation is NOT active. On Cloudflare this means one Durable Object incident can ' +
          "upload another tenant's capture. Omit captureStore, or partition it yourself.",
      ),
    );
  }
  const captureStore =
    options.captureStore ??
    (partitionByTenant
      ? // One ring PER TENANT, with the byte budget DIVIDED across them (+1 for the unattributed default)
        // so total capture memory never exceeds maxDataSize. Partition count is LRU-bounded in the store.
        createPartitionedCaptureStore({
          createPartition: () =>
            createMemoryCaptureStore({
              ...memoryStoreOptions,
              maxDataSizeBytes: Math.max(
                1,
                Math.floor(memoryStoreOptions.maxDataSizeBytes / (maxTenantPartitions + 1)),
              ),
            }),
          maxPartitions: maxTenantPartitions,
          ...(options.onError !== undefined ? { onError: options.onError } : {}),
        })
      : createMemoryCaptureStore(memoryStoreOptions));

  // The run()-only edge context store: registered under EdgeContextStoreToken (for E5's wrapper) AND passed as
  // the core ContextProvider (so captures within a request get the contextId/trace stamps).
  const contextStore = createEdgeRequestContextStore({
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.asyncLocalStorage !== undefined ? { storage: options.asyncLocalStorage } : {}),
  });
  services.addService(defineService(EdgeContextStoreToken, () => contextStore));

  const client = createClient({
    isEnabled: resolved.isEnabled,
    launchOptions: resolved.options,
    services,
    uploadPipeline,
    appToken,
    getEnvironment,
    captureStore,
    contextProvider: contextStore,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.scheduler !== undefined ? { scheduler: options.scheduler } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });

  for (const manifest of getServiceManifests(carrier)) {
    manifest(client);
  }

  // Capture providers: console→log + network. The network umbrella's leaves (fetch/xhr/ws/sse/webtransport)
  // self-skip when their global is absent — on edge only `fetch` is present, so only it activates.
  const consoleInterceptor = getOrCreateInterceptor(
    'console',
    () => createConsoleInterceptor(),
    carrier,
  );
  client.addCaptureProvider(createLogCaptureProvider(consoleInterceptor));
  const captureBodies = resolved.options.get(BugseeOption.CaptureNetworkBodies, true);
  const maxBodyBytes = resolved.options.get(BugseeOption.CaptureNetworkBodySizeLimit, 20480);
  const network = installNetworkCapture({ carrier, captureBodies, maxBodyBytes });
  client.addCaptureProvider(network.provider);

  // Detection: the `unhandledrejection` safety net (gated by `detectCrashes` via its controllingOption). It
  // self-skips where the global target has no addEventListener (a non-edge runtime).
  client.addDetectionProvider(
    createEdgeUnhandledRejectionProvider(options.globalTarget ?? (globalThis as EdgeGlobalEvents)),
  );

  client.launch();

  // The public client. stop() clears the per-isolate carrier slot so a later launch() starts fresh.
  const stopCore = client.stop;
  const publicClient: Bugsee = {
    ...client,
    stop(timeout?: number): Promise<boolean> {
      setCarrierClient(undefined, carrier);
      return stopCore(timeout);
    },
  };
  setCarrierClient(publicClient, carrier);
  return publicClient;
}
