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
export {
  type InstallNetworkCaptureOptions,
  installNetworkCapture,
  type NetworkCapture,
} from './install-network-capture';
export { createLogCaptureProvider } from './log-provider';
export { createNetworkInterceptor } from './network-interceptor';
export { createNetworkCaptureProvider, type NetworkSource } from './network-provider';
export {
  createRequestDecoratorRegistry,
  type OutgoingRequest,
  type RequestDecoratable,
  type RequestDecorator,
  type RequestDecoratorRegistry,
} from './request-decorator';
export {
  createSseInterceptor,
  type SseInterceptorOptions,
  type SseTarget,
} from './sse-interceptor';
export {
  createSystemEventsProvider,
  type SystemEvent,
  type SystemEventSource,
  type SystemEventsProviderOptions,
} from './system-events-provider';
export {
  createSystemTracesProvider,
  type SystemTracesProviderOptions,
  type TraceSample,
} from './system-traces-provider';
export {
  createTraceparentDecorator,
  type ParsedTraceparent,
  parseTraceparent,
  type TraceContextSource,
  type TraceparentDecoratorOptions,
} from './traceparent';
export {
  type BugseeTraceState,
  decodeBugseeState,
  encodeBugseeState,
  parseTracestate,
  serializeTracestate,
  setTracestateEntry,
  type TracestateEntry,
} from './tracestate';
export {
  createUserEventsProvider,
  type UserEvent,
  type UserEventSource,
  type UserEventsProviderOptions,
} from './user-events-provider';
export {
  createWebSocketInterceptor,
  type WebSocketInterceptorOptions,
  type WebSocketTarget,
} from './web-socket-interceptor';
export {
  createWebTransportInterceptor,
  type WebTransportInterceptorOptions,
  type WebTransportTarget,
} from './web-transport-interceptor';
export {
  createXhrInterceptor,
  type XhrInterceptorOptions,
  type XhrTarget,
} from './xhr-interceptor';
