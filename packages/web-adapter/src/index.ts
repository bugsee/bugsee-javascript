// @bugsee/web-adapter — shared plumbing for the web framework adapters (tier 4). See
// docs/design/frontend-adapters.md §7 (the depth pass).
export type { Bugsee } from '@bugsee/browser';
export {
  type AdapterClientOptions,
  type AdapterMechanism,
  type ReportErrorOptions,
  type RouteNamingOptions,
  reportError,
  resolveClient,
  setRouteName,
} from './adapter';
