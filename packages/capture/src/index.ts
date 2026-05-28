// @bugsee/capture — cross-runtime capture sources + runtime-agnostic providers (design §16, shared
// tier-3). Universal interceptors (console/fetch/…) own a global hook and emit to a core hub; the
// runtime-agnostic CaptureProviders consume those hubs. Platform packages compose this and add only
// their runtime-specific sources (XHR, node:http, error/rejection globals).

export {
  type ConsoleInterceptorOptions,
  createConsoleInterceptor,
  formatConsoleArgs,
} from './console-interceptor';
export { createLogCaptureProvider } from './log-provider';
