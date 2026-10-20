// @bugsee/browser
// Browser platform: fetch transport, IndexedDB storage, window error handlers, stack-trace parser,
// and the launch() composition root.

// The built-in network redaction, for composing with a custom `setNetworkEventFilter` (the
// directly imported platform package exposes the same value surface as the umbrella entries).
export { type DefaultNetworkSanitizer, getDefaultNetworkSanitizer } from '@bugsee/capture';
// Public report-attachment input type, so `UploadOptions.attachments` / `ReportHandler.before` code types without reaching into core.
export type { ReportAttachmentInput } from '@bugsee/core';
// Lifecycle events: the event-name constants + listener type for `setLifecycleEventsListener`.
// Helper form of writing `report.userAttachments` from `ReportHandler.before` (Android `Report.addAttachment`).
export {
  addReportAttachment,
  BugseeStatus,
  LifecycleEvents,
  type LifecycleEventsListener,
  type LifecycleEventType,
} from '@bugsee/core';
export {
  type ApplicationEnv,
  type ApplicationEvents,
  type ApplicationState,
  ApplicationTracker,
  applicationTrackerFor,
} from '@bugsee/trackers/browser';
export { COMPONENT_ATTRIBUTE, componentNameFromElement } from './component-name';
export {
  createUnhandledRejectionProvider,
  createWindowErrorProvider,
  type WindowEvents,
} from './detection-providers';
export {
  type DeviceIdAsyncStore,
  type DeviceIdCookieStorage,
  type DeviceIdEnv,
  type DeviceIdLocalStorage,
  generateDeviceId,
  isValidDeviceId,
  peekBrowserDeviceId,
  realDeviceIdEnv,
  resetBrowserDeviceIdCache,
  resolveBrowserDeviceId,
} from './device-id';
export {
  type BrowserEnvironmentInput,
  type BrowserProbe,
  BrowserProbeToken,
  buildBrowserEnvironment,
  realBrowserProbe,
} from './environment';
export { boundMatchMedia, hostGlobal, hostRead } from './host-global';
export {
  type BlackoutBindable,
  type BrowserInputEnv,
  bindInputBlackout,
  createBrowserInputSource,
  describeTarget,
  type TargetDescriptor,
} from './input-source';
export {
  createBrowserInteractionSource,
  type InteractionDetail,
  type InteractionEnv,
  type InteractionSource,
} from './interaction-source';
export {
  type Bugsee,
  type BugseeLaunchOptions,
  getStatus,
  type LaunchInternals,
  type LaunchResult,
  launch,
  launchCore,
  relaunch,
} from './launch';
export {
  type MetaTraceContinuation,
  type MetaTraceEnv,
  readMetaTraceContinuation,
} from './meta-trace';
export {
  createBrowserNavigationSource,
  type NavigationDetail,
  type NavigationEnv,
  type NavigationSource,
  type NavigationType,
} from './navigation-source';
export {
  DEFAULT_REPORT_DIALOG_STRINGS,
  type ReportDialogOptions,
  type ReportDialogStrings,
} from './report-dialog';
export { parseStack } from './stack';
export { type BrowserSystemEventsEnv, createBrowserSystemEventsSource } from './system-events';
export { chargingToWire } from './system-trace-values';
export {
  type BrowserTraceEnv,
  browserTraceEnvFrom,
  createBrowserSystemTraceProducers,
  defaultBrowserTraceEnv,
} from './trace-producers';
export {
  createUiBreadcrumbProvider,
  createUiBreadcrumbSource,
  type UiBreadcrumbEnv,
  type UiBreadcrumbSource,
} from './ui-breadcrumb-source';
// The browser-family OS/browser identification, exported so the worker tier (which has the same
// `navigator` and the same problem) derives its OS the same way rather than growing a second parser.
export {
  detectBrowser,
  detectOs,
  type Identity,
  normalizeUaDataPlatform,
  parseBrowserFromUserAgent,
  parseOsFromUserAgent,
  UNKNOWN_OS,
} from './user-agent';
// The localStorage key prefix of the opt-in persisted user identifier (`<prefix><appToken>`), so tests and
// tooling that inspect the storage do not hard-code the string.
export { USER_IDENTIFIER_KEY_PREFIX } from './user-identifier-store';
export {
  createDomSnapshot,
  createViewtreeSnapshotSource,
  type DomSnapshotEnv,
  type ViewNode,
} from './viewtree';
