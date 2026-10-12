// @bugsee/electron — converges Electron's main (Node), renderer (Chromium) and native (crashReporter)
// layers into ONE Bugsee session. The main process owns the session; renderers stream capture up to it.
// Per-runtime entry points (launchMain / launchRenderer / preload) land in
// subsequent slices; this exposes the shared renderer↔main wire codec.
export {
  type ControlCommand,
  type ControlMessage,
  type DecodedStreamEntry,
  decodeControl,
  decodeStreamEntry,
  encodeControl,
  encodeHello,
  encodeStreamEntry,
  isHello,
} from './protocol';
