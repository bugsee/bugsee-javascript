// `@bugsee/trackers/browser` entry. Platform tracker implementations that need DOM/Web-API APIs live under
// src/browser/ and are exported from here. The portable root entry must never import from this directory.
export {
  type ApplicationEnv,
  type ApplicationEvents,
  type ApplicationState,
  ApplicationTracker,
  applicationTrackerFor,
  resetApplicationTracker,
} from './application-tracker';
export {
  type ConnectivityEvents,
  type ConnectivityHost,
  type ConnectivityState,
  ConnectivityTracker,
  connectivityTrackerFor,
  type NetworkInfo,
  resetConnectivityTracker,
} from './connectivity-tracker';
export {
  DEFAULT_PERMISSION_NAMES,
  type EnvironmentEnv,
  type EnvironmentEvents,
  type EnvironmentHints,
  type EnvironmentSnapshot,
  type EnvironmentTimers,
  EnvironmentTracker,
  environmentTrackerFor,
  type LanguageInfo,
  NORMAL_QUOTA_FROM_BYTES,
  type PermissionStateName,
  type PermissionStates,
  PRIVATE_QUOTA_BELOW_BYTES,
  type PrivateModeResult,
  resetEnvironmentTracker,
  type TimeZoneInfo,
} from './environment-tracker';
export { hostRead } from './host-read';
export {
  type BatteryEnv,
  type BatteryManagerLike,
  type BatteryState,
  PowerTracker,
  powerTrackerFor,
  resetPowerTracker,
} from './power-tracker';
export {
  type HeapReading,
  type HeapState,
  type ProcessEnv,
  type ProcessEvents,
  type ProcessTimers,
  ProcessTracker,
  type ProcessTrackerEnv,
  processTrackerFor,
  resetProcessTracker,
  type UserIdleState,
} from './process-tracker';
export {
  resetStorageTracker,
  type StorageEnv,
  type StorageEstimate,
  type StorageManagerLike,
  type StorageTimers,
  StorageTracker,
  type StorageTrackerEnv,
  storageTrackerFor,
} from './storage-tracker';
export {
  type ColorSchemeState,
  type DisplayModeName,
  type DisplayModeState,
  type MediaQueryListLike,
  type OrientationState,
  type ReducedMotionState,
  resetUiTracker,
  type ScreenSizeState,
  type UiEnv,
  type UiSchedulerLike,
  type UiStage,
  type UiStages,
  type UiStateStage,
  UiTracker,
  uiTrackerFor,
  type ViewportState,
} from './ui-tracker';
