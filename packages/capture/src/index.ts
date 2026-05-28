// @bugsee/capture — cross-runtime capture sources + runtime-agnostic providers (design §16, shared
// tier-3). Universal interceptors (console/fetch/…) own a global hook and emit to a core hub; the
// runtime-agnostic CaptureProviders consume those hubs. Platform packages compose this and add only
// their runtime-specific sources (XHR, node:http, error/rejection globals).

export {
  type ConsoleInterceptorOptions,
  type ConsoleStageMap,
  createConsoleInterceptor,
  formatConsoleArgs,
} from './console-interceptor';
export {
  createFetchInterceptor,
  type FetchInterceptorOptions,
  type FetchTarget,
} from './fetch-interceptor';
export { createLogCaptureProvider } from './log-provider';
export { createNetworkInterceptor } from './network-interceptor';
export { createNetworkCaptureProvider, type NetworkSource } from './network-provider';
export {
  createXhrInterceptor,
  type XhrInterceptorOptions,
  type XhrTarget,
} from './xhr-interceptor';
