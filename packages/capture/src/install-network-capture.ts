import { type CaptureProvider, getOrCreateInterceptor, type Interceptor } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import { createFetchInterceptor, type FetchTarget } from './fetch-interceptor';
import { createNetworkInterceptor } from './network-interceptor';
import { createNetworkCaptureProvider, type NetworkSource } from './network-provider';
import { createSseInterceptor } from './sse-interceptor';
import { createWebSocketInterceptor } from './web-socket-interceptor';
import { createWebTransportInterceptor } from './web-transport-interceptor';
import { createXhrInterceptor, type XhrTarget } from './xhr-interceptor';

// One-call network capture wiring: build every cross-runtime network sub-interceptor (fetch / xhr /
// websocket / sse / webtransport), aggregate them under the NetworkInterceptor umbrella, and create the
// networkProvider subscribed to it. Each sub self-skips when its global is absent, so this is safe on
// any runtime — no detection needed here. Platform-specific sources (e.g. Node's node:http) are folded
// in via `additionalSources`. The provider is registered with the client (captureNetwork-gated; its
// subscription activates the umbrella → the available subs); the returned umbrella is the single source
// other consumers (APM, user code) subscribe to for ALL network events.
//
// Each leaf is obtained through the process Carrier (getOrCreateInterceptor, keyed by interceptor
// name), so duplicated module copies converge on ONE instance per leaf and a runtime global is patched
// exactly once (#47). Consequently the FIRST installer's leaf options (now/isInternal/fetchTarget)
// win — a later call reuses the existing singletons and its options for an already-built leaf are
// ignored. The umbrella + provider stay per-install (they consume the shared leaves).

type NetworkUmbrella = Interceptor<Record<NetworkStage, NetworkEvent>>;

export interface InstallNetworkCaptureOptions {
  /** Wall-clock source shared by the sub-interceptors; injectable. Default each uses Date.now. */
  now?: () => number;
  /** SDK self-isolation predicate for request/response transports (fetch/xhr). Default X-Bugsee-Internal. */
  isInternal?: (url: string, requestHeaders: Record<string, string>) => boolean;
  /** Override the fetch target (a custom/library fetch, or for tests). Default globalThis.fetch. */
  fetchTarget?: FetchTarget;
  /** Override the XMLHttpRequest target (a custom impl, or for tests). Default globalThis.XMLHttpRequest. */
  xhrTarget?: XhrTarget;
  /** Extra platform-specific network sources to aggregate (e.g. Node's node:http interceptor). */
  additionalSources?: readonly NetworkSource[];
  /** Carrier host for the leaf singletons; injectable for tests. Default the real `globalThis`. */
  carrier?: object;
  /** Capture response bodies (bounded read) in the request interceptors. Default true (interceptor default). */
  captureBodies?: boolean;
  /** Max response-body bytes read before stopping (bounded). Default 20480 (interceptor default). */
  maxBodyBytes?: number;
}

export interface NetworkCapture {
  /** The umbrella network source — subscribe once for ALL network events. */
  interceptor: NetworkUmbrella;
  /** The network capture provider — register with the client to record `network` entries. */
  provider: CaptureProvider;
}

export function installNetworkCapture(options: InstallNetworkCaptureOptions = {}): NetworkCapture {
  const nowOpt = options.now !== undefined ? { now: options.now } : {};
  const httpOpts = {
    ...nowOpt,
    ...(options.isInternal !== undefined ? { isInternal: options.isInternal } : {}),
  };
  // Body-capture policy shared by the request/response interceptors (fetch + xhr).
  const bodyOpts = {
    ...(options.captureBodies !== undefined ? { captureBodies: options.captureBodies } : {}),
    ...(options.maxBodyBytes !== undefined ? { maxBodyBytes: options.maxBodyBytes } : {}),
  };
  // Each leaf is a process-global singleton on the carrier (one patch per global, module-dup safe).
  // Passing options.carrier === undefined falls back to getOrCreateInterceptor's globalThis default.
  const carrier = options.carrier;
  const leaf = (name: string, make: () => NetworkUmbrella): NetworkUmbrella =>
    getOrCreateInterceptor<Record<NetworkStage, NetworkEvent>>(name, make, carrier);
  const sources: NetworkUmbrella[] = [
    leaf('fetch', () =>
      createFetchInterceptor({
        ...httpOpts,
        ...(options.fetchTarget !== undefined ? { target: options.fetchTarget } : {}),
        ...bodyOpts,
      }),
    ),
    leaf('xhr', () =>
      createXhrInterceptor({
        ...httpOpts,
        ...bodyOpts,
        ...(options.xhrTarget !== undefined ? { target: options.xhrTarget } : {}),
      }),
    ),
    leaf('websocket', () => createWebSocketInterceptor(nowOpt)),
    leaf('sse', () => createSseInterceptor(nowOpt)),
    leaf('webtransport', () => createWebTransportInterceptor(nowOpt)),
  ];
  const interceptor = createNetworkInterceptor(...sources, ...(options.additionalSources ?? []));
  return { interceptor, provider: createNetworkCaptureProvider(interceptor) };
}
