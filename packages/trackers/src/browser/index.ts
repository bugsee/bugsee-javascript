// `@bugsee/trackers/browser` entry. Platform tracker implementations that need DOM/Web-API APIs live under
// src/browser/ and are exported from here. The portable root entry must never import from this directory.
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
