// @bugsee/browser
// Browser platform: fetch transport, IndexedDB storage, window error handlers, stack-trace parser,
// and the launch() composition root. Tier 2. See docs/design/sdk-design.md §5.
export {
  createUnhandledRejectionProvider,
  createWindowErrorProvider,
  type WindowEvents,
} from './detection-providers';
export {
  type BrowserEnvironmentInput,
  type BrowserProbe,
  BrowserProbeToken,
  buildBrowserEnvironment,
  realBrowserProbe,
} from './environment';
export {
  type BrowserInputEnv,
  createBrowserInputSource,
  describeTarget,
  type TargetDescriptor,
} from './input-source';
export {
  type Bugsee,
  type BugseeLaunchOptions,
  type LaunchInternals,
  type LaunchResult,
  launch,
  launchCore,
} from './launch';
export {
  createBrowserNavigationSource,
  type NavigationDetail,
  type NavigationEnv,
  type NavigationSource,
  type NavigationType,
} from './navigation-source';
export { parseStack } from './stack';
export { type BrowserSystemEventsEnv, createBrowserSystemEventsSource } from './system-events';
export { type BrowserTracesEnv, createBrowserSystemTracesSampler } from './system-metrics';
export {
  createDomSnapshot,
  createViewtreeSnapshotSource,
  type DomSnapshotEnv,
  type ViewNode,
} from './viewtree';
