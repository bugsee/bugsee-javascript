// @bugsee/capture — cross-runtime capture sources + runtime-agnostic providers (design §16, shared
// tier-3). Universal interceptors (console/fetch/…) own a global hook and emit to a core hub; the
// runtime-agnostic CaptureProviders consume those hubs. Platform packages compose this and add only
// their runtime-specific sources (XHR, node:http, error/rejection globals).

// `absolutizeUrl`/`resolveBaseUrl`/`UrlBaseGlobals` (./absolutize-url) are an internal helper of
// network-provider.ts (imported directly, not via this barrel) — no external consumer, not re-exported
// (R3-13).
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
// `InputSource`/`InputProviderOptions` (./input-provider) are structural-typing helpers with no external
// consumer — callers pass a value that satisfies `InputSource` (e.g. browser's `BrowserInputSource`)
// without ever naming the type, and no caller passes provider options. Not re-exported (R3-13).
// `createInputProvider`/`InputEventDetail` ARE genuinely cross-package (browser + webview both consume
// them) and stay.
export { createInputProvider, type InputEventDetail } from './input-provider';
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
// `createSendBeaconInterceptor`/`SendBeaconInterceptorOptions`/`SendBeaconTarget` (./send-beacon-interceptor)
// are wired internally by install-network-capture.ts (imported directly, not via this barrel) — every
// platform reaches sendBeacon capture only through `installNetworkCapture()`, never by constructing the
// interceptor itself. No external consumer, not re-exported (R3-13).
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
