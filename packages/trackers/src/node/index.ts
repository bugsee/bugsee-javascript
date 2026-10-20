// `@bugsee/trackers/node` entry. Platform tracker implementations that need node:* APIs (shared by Node, Bun and
// Deno, which expose a node-compatible surface) live under src/node/ and are exported from here. The portable root
// entry and the browser entry must never import from this directory.
export {
  createGcSource,
  type GcEntry,
  type GcInterval,
  type GcSource,
  type ObserverCtor,
} from './gc-observer';
export {
  createGuardedElu,
  createGuardedEventLoopSource,
  type DelayHistogram,
  type Elu,
  type EventLoopSource,
  eluUnavailable,
  type PerfHooks,
  realPerfHooks,
} from './guarded-event-loop';
export {
  type ProcessEnv,
  type ProcessEvents,
  type ProcessMemory,
  type ProcessTimers,
  ProcessTracker,
  type ProcessTrackerEnv,
  processTrackerFor,
  resetProcessTracker,
} from './process-tracker';
export {
  createAvailableMemoryReader,
  createMemoryLimitReader,
  createV8HeapReader,
  type V8HeapStats,
} from './runtime-readers';
export {
  type DiskReading,
  resetStorageTracker,
  type StatFs,
  type StatFsResult,
  type StorageEnv,
  type StorageEvents,
  type StorageTimers,
  StorageTracker,
  type StorageTrackerEnv,
  storageTrackerFor,
} from './storage-tracker';
