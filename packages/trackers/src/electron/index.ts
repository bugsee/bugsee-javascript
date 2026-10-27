// `@bugsee/trackers/electron` entry. Platform tracker implementations that need Electron main-process APIs live under
// src/electron/ and are exported from here. Electron is never imported: the `app`, `powerMonitor`, `screen` and
// `BrowserWindow` objects are injected as structural sources (`ElectronAppSource`, `PowerMonitorSource`, `ScreenSource`,
// `BrowserWindowSource`), so this entry has no dependency on `electron` or the DOM. The portable root entry must never
// import from this directory.

export {
  type ApplicationAppSource,
  type BrowserWindowSource,
  type ElectronApplicationEnv,
  type ElectronApplicationEvents,
  ElectronApplicationTracker,
  electronApplicationTrackerFor,
  resetElectronApplicationTracker,
} from './application-tracker';
export {
  type DisplayInfo,
  type ElectronDisplayEnv,
  type ElectronDisplayEvents,
  ElectronDisplayTracker,
  electronDisplayTrackerFor,
  type MappedDisplay,
  mapDisplay,
  resetElectronDisplayTracker,
  type ScreenSource,
} from './display-tracker';
export { type ElectronGpu, mapGpuInfo } from './gpu-info';
export {
  type ElectronPowerEnv,
  type ElectronPowerEvents,
  ElectronPowerTracker,
  type ElectronThermalState,
  electronPowerTrackerFor,
  type PowerMonitorSource,
  resetElectronPowerTracker,
} from './power-tracker';
export {
  type AppProcessMetric,
  type ChildProcessGone,
  type ElectronAppSource,
  type ElectronProcessEnv,
  type ElectronProcessEvents,
  ElectronProcessTracker,
  type ElectronProcessTrackerEnv,
  electronProcessTrackerFor,
  type GpuInfoType,
  resetElectronProcessTracker,
} from './process-tracker';
