// @bugsee/node — Node platform (tier 2, design §5): http(s) transport, node:fs storage, uncaught/
// unhandledRejection detection, console/network capture. Built test-first per
// docs/implementation-standards.md.

// F-6: the `HttpTransport` primitive (+ its request/response option shapes) — used internally by the
// `transport` launch option (launch.ts) but never re-exported, forcing a consumer wiring a custom
// transport (a proxy, a queueing shim, a test double) into an unsafe `as never` cast to satisfy the
// type checker. Type-only: no runtime footprint, no new dependency surface.
export type { HttpRequestOptions, HttpResponse, HttpTransport } from '@bugsee/core';
// Re-exported so the backend adapters can contain their OWN pre-request work (header reads, route
// extraction, the application-supplied `user` callback) without each taking a direct @bugsee/core
// dependency. That work runs outside `runServerRequest` and the engine structurally cannot guard it.
export { guarded, neverThrow } from '@bugsee/core';

// R-7/F4: the request-scoped active-span store for bare-`@bugsee/node` consumers wiring APM by
// hand. One store per context source: the stash key is process-global (realm convergence), so two
// live stores over the same source alias on it. The launch builds and owns one; hand-wirers must
// share (not mint per controller) theirs the same way.
export {
  createRequestScopedActiveSpanStore,
  type RequestScopedActiveSpanStoreOptions,
} from './active-span-store';
export {
  type CpuProfile,
  type CpuProfiler,
  type CpuProfilerOptions,
  createCpuProfiler,
  type ProfilerSession,
} from './cpu-profiler';
export type { CapturedDataStore } from './data-location';
export {
  createUncaughtExceptionProvider,
  createUnhandledRejectionProvider,
  type ProcessEvents,
} from './detection-providers';
export {
  buildNodeEnvironment,
  type NodeEnvironmentInput,
  realSystemProbe,
  type SystemProbe,
} from './environment';
export {
  createEventLoopWatchdog,
  type EventLoopWatchdog,
  type EventLoopWatchdogDeps,
  evaluateHang,
  type HangLevel,
  type HangThresholds,
} from './event-loop-watchdog';
export {
  type FetchHandler,
  type FetchRequestLike,
  type FetchResponseLike,
  wrapFetchHandler,
} from './fetch-server-wrap';
export {
  createGuardedSystemMetricsSampler,
  type GuardedSystemMetricsDeps,
  type PerfHooks,
} from './guarded-system-metrics';
export {
  createHangDetectionProvider,
  type HangDetectionProviderDeps,
} from './hang-detection-provider';
export {
  createNodeHttpInterceptor,
  type HttpModule,
  type NodeHttpInterceptorOptions,
  type NodeHttpTarget,
} from './http-interceptor';
export {
  createHttpServerInterceptor,
  type HttpServerInterceptor,
  type HttpServerInterceptorOptions,
  type HttpServerTarget,
  type ServerInstallable,
} from './http-server-interceptor';
export type { InstanceIdentity } from './instance-layout';
export {
  type Bugsee,
  type BugseeLaunchOptions,
  type LaunchInternals,
  type LaunchResult,
  launch,
  launchCore,
  type NodeRuntime,
} from './launch';
export { PROFILING_OPTION_DEFINITIONS, ProfilingOption } from './options';
export {
  createProfilingController,
  type ProfilingController,
  type ProfilingControllerDeps,
} from './profiling-controller';
export {
  createNodeRequestContextStore,
  type RequestContextStore,
  RequestContextStoreToken,
} from './request-context-store';
export {
  defaultShouldReport,
  getActiveServerSpan,
  openServerContext,
  openServerRequest,
  runServerRequest,
  type ServerInstrumentOptions,
  type ServerRequestInfo,
  type ServerRequestSpan,
  startServerSpan,
} from './server-instrument';
export { createNodeSystemEventsSource } from './system-events';
export { createNodeSystemMetricsSampler, type NodeSystemMetricsDeps } from './system-metrics';
