// @bugsee/browser
// Browser platform: fetch transport, IndexedDB storage, window error handlers, stack-trace parser,
// and the launch() composition root. Tier 2. See docs/design/sdk-design.md §5.
export {
  createUnhandledRejectionProvider,
  createWindowErrorProvider,
  type WindowEvents,
} from './detection-providers';
export {
  type BrowserEnvironmentInput,
  type BrowserProbe,
  BrowserProbeToken,
  buildBrowserEnvironment,
  realBrowserProbe,
} from './environment';
export { parseStack } from './stack';
