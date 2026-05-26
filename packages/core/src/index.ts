// @bugsee/core — the SDK kernel (tier 1, design §7/§16): Client, single global scope, event hubs +
// EventEmitter, Interceptor/CaptureProvider/DetectionProvider + extension registry, ring buffers,
// the event/trigger pipeline, and BundleWriter. Built incrementally, test-first.

export { createEventEmitter, type EventEmitter, type Listener } from './event-emitter';
export { createRingBuffer, type RingBuffer } from './ring-buffer';
