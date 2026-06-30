// @bugsee/webview — the advanced JS SDK for embedded native WebViews (Android-first).
// docs/design/webview-bridge.md. It reuses @bugsee/browser capture but swaps the CaptureStore for a
// HostBridgeCaptureStore that streams each entry across the WebView boundary to the hosting native Bugsee SDK
// (native is the ring buffer + the bundler). `launch(appToken, options)` returns the started client; it opens a
// `hello` handshake, streams console→log + network capture across the bridge, and exposes `__bugsee_bridge`
// for native→JS control. Full-parity capture + the control commands + obscuring land in later slices.
export {
  createHostBridge,
  DEFAULT_MAX_BUFFER,
  type HostBridge,
} from './host-bridge';
export {
  createHostBridgeCaptureStore,
  type HostBridgeCaptureStoreOptions,
} from './host-bridge-capture-store';
export {
  type BridgeControl,
  type BridgeControlConfig,
  createBridgeControl,
} from './host-bridge-control';
export { type Bugsee, type BugseeWebViewLaunchOptions, launch } from './launch';
export {
  type BatchMessage,
  type BridgeMessageKind,
  type ByeMessage,
  batchMessage,
  byeMessage,
  type ControlConfig,
  type ControlMessage,
  type EntryMessage,
  encode,
  entryMessage,
  type HelloMessage,
  helloMessage,
  PROTOCOL_VERSION,
  parseControl,
  type TraceRef,
} from './protocol';
