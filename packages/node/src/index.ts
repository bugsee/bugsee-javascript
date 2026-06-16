// @bugsee/node — Node platform (tier 2, design §5): http(s) transport, node:fs storage, uncaught/
// unhandledRejection detection, console/network capture. Built test-first per
// docs/implementation-standards.md.

export {
  type CpuProfile,
  type CpuProfiler,
  type CpuProfilerOptions,
  createCpuProfiler,
  type ProfilerSession,
} from './cpu-profiler';
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
