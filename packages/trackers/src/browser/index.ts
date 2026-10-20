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
export { hostRead } from './host-read';
export {
  type BatteryEnv,
  type BatteryManagerLike,
  type BatteryState,
  PowerTracker,
  powerTrackerFor,
  resetPowerTracker,
} from './power-tracker';
