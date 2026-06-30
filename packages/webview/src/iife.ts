// The IIFE entry for the SELF-CONTAINED injectable single-string build (docs/design/webview-bridge.md D7/§9).
// Native ships this bundle as a resource and injects it at document-start; the bundler's `globalName` turns these
// named exports into the `BugseeWebView` global, and the native bootstrap activates the SDK from native-pushed
// config via `BugseeWebView.launch(appToken, options)`. This is a THIN entry — npm/ESM consumers import the
// package root (`@bugsee/webview` → index.ts) instead; only the injectable build uses this entry so its surface
// (and thus the global) stays minimal.
// `VERSION` is re-exported from the single source of truth (`launch.ts` `SDK_VERSION`, also the handshake
// `sdkVersion` default) so the global's version can never drift from what the SDK actually reports.
export { launch, SDK_VERSION as VERSION } from './launch';
