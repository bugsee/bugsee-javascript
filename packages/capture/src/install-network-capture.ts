import type { CaptureProvider, Interceptor } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import { createFetchInterceptor, type FetchTarget } from './fetch-interceptor';
import { createNetworkInterceptor } from './network-interceptor';
import { createNetworkCaptureProvider, type NetworkSource } from './network-provider';
import { createSseInterceptor } from './sse-interceptor';
import { createWebSocketInterceptor } from './web-socket-interceptor';
import { createWebTransportInterceptor } from './web-transport-interceptor';
import { createXhrInterceptor } from './xhr-interceptor';

// One-call network capture wiring: build every cross-runtime network sub-interceptor (fetch / xhr /
// websocket / sse / webtransport), aggregate them under the NetworkInterceptor umbrella, and create the
// networkProvider subscribed to it. Each sub self-skips when its global is absent, so this is safe on
// any runtime — no detection needed here. Platform-specific sources (e.g. Node's node:http) are folded
// in via `additionalSources`. The provider is registered with the client (captureNetwork-gated; its
// subscription activates the umbrella → the available subs); the returned umbrella is the single source
// other consumers (APM, user code) subscribe to for ALL network events.

type NetworkUmbrella = Interceptor<Record<NetworkStage, NetworkEvent>>;

export interface InstallNetworkCaptureOptions {
  /** Wall-clock source shared by the sub-interceptors; injectable. Default each uses Date.now. */
  now?: () => number;
  /** SDK self-isolation predicate for request/response transports (fetch/xhr). Default X-Bugsee-Internal. */
  isInternal?: (url: string, requestHeaders: Record<string, string>) => boolean;
  /** Override the fetch target (a custom/library fetch, or for tests). Default globalThis.fetch. */
  fetchTarget?: FetchTarget;
  /** Extra platform-specific network sources to aggregate (e.g. Node's node:http interceptor). */
  additionalSources?: readonly NetworkSource[];
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
  const sources: NetworkUmbrella[] = [
    createFetchInterceptor({
      ...httpOpts,
      ...(options.fetchTarget !== undefined ? { target: options.fetchTarget } : {}),
    }),
    createXhrInterceptor(httpOpts),
    createWebSocketInterceptor(nowOpt),
    createSseInterceptor(nowOpt),
    createWebTransportInterceptor(nowOpt),
  ];
  const interceptor = createNetworkInterceptor(...sources, ...(options.additionalSources ?? []));
  return { interceptor, provider: createNetworkCaptureProvider(interceptor) };
}
