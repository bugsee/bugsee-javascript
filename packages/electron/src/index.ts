// @bugsee/electron — converges Electron's main (Node), renderer (Chromium) and native (crashReporter)
// layers into ONE Bugsee session. The main process owns the session; renderers stream capture up to it.
// See docs/design/electron.md. Per-runtime entry points (launchMain / launchRenderer / preload) land in
// subsequent slices; this exposes the shared renderer↔main wire codec.
export {
  type DecodedStreamEntry,
  decodeStreamEntry,
  encodeStreamEntry,
} from './protocol';
