// @bugsee/trackers — the foundation the domain trackers are built on. It sits BELOW @bugsee/core (core
// imports and re-exports it) and depends on nothing but @bugsee/util, never on core.
//
// Runtime layout: THIS root entry is runtime-portable — no DOM, no node:*, no electron imports; runtime
// APIs arrive only through injected env objects and guarded globalThis casts. Platform-specific tracker
// implementations live behind the reserved subpath entries `./browser`, `./node` and `./electron`
// (src/<runtime>/), and only those may use DOM / node:* / electron APIs.
export type { Interceptor } from './contracts';
export {
  createMultiKeyEmitter,
  type EventListener,
  type EventSubscribable,
  type MultiKeyEmitter,
  MultiKeyEmitterBase,
} from './emitter';
export { InterceptorBase } from './interceptor-base';
export { createTrackerRegistry, type TrackerRegistry } from './tracker-registry';
