// @bugsee/node — Node platform (tier 2, design §5): http(s) transport, node:fs storage, uncaught/
// unhandledRejection detection, console/network capture. Built test-first per
// docs/implementation-standards.md.

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
  createNodeHttpInterceptor,
  type HttpModule,
  type NodeHttpInterceptorOptions,
  type NodeHttpTarget,
} from './http-interceptor';
export { createNodeSystemEventsSource } from './system-events';
export { createNodeSystemMetricsSampler, type NodeSystemMetricsDeps } from './system-metrics';
