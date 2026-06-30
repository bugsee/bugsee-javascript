// @bugsee/webview — the advanced JS SDK for embedded native WebViews (Android-first).
// docs/design/webview-bridge.md. It reuses @bugsee/browser capture but swaps the CaptureStore for a
// HostBridgeCaptureStore that streams each entry across the WebView boundary to the hosting native Bugsee SDK
// (native is the ring buffer + the bundler). `launch(appToken, options)` returns the started client; it opens a
// `hello` handshake, streams console→log + network capture across the bridge, and exposes `__bugsee_bridge`
// for native→JS control (incl. a synchronous secure-area `snapshot()` pull). Obscuring (D10 — secure-area pixel
// masking rects) is built in so the advanced SDK fully replaces the legacy masking script. Redaction provenance
// (D3) + the IIFE build + the e2e conformance harness land in later slices.
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
  createObscuringChannel,
  type ObscuringChannel,
  type ObscuringChannelOptions,
} from './obscuring-channel';
export {
  collectSecureAreas,
  createObscuringSource,
  type MutationObserverCtor,
  type ObscuringSource,
  type SecureDocument,
  type SecureWindow,
} from './obscuring-source';
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
  type ReportMessage,
  reportMessage,
  type SecureArea,
  type SecureMessage,
  secureMessage,
  type TraceRef,
} from './protocol';
export {
  createWebViewReportPipeline,
  type WebViewReportPipeline,
  type WebViewReportPipelineOptions,
} from './webview-report-pipeline';
