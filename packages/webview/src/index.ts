// @bugsee/webview — the advanced JS SDK for embedded native WebViews (Android-first).
// docs/design/webview-bridge.md. It reuses @bugsee/browser capture but swaps the CaptureStore for a
// HostBridgeCaptureStore that streams each entry across the WebView boundary to the hosting native Bugsee SDK
// (native is the ring buffer + the bundler). This entry point currently exports the data-streaming core
// (versioned protocol + the Android host-bridge channel + the streaming capture store); launch() lands next.
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
