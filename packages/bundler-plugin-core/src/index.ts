// @bugsee/bundler-plugin-core — shared bundler-plugin engine. Collects build context and drives the Rust
// `bugsee-cli` (sourcemaps inject + debug-files upload). Consumed by @bugsee/vite-plugin / @bugsee/webpack-plugin.
// See docs/design/source-maps.md.
export {
  defaultDeleteMapFiles,
  type RunFn,
  type UploadSourcemapsOptions,
  type UploadSourcemapsResult,
  uploadSourcemaps,
} from './orchestrate';
export {
  BugseeCliError,
  type EnvRecord,
  type RunBugseeCliOptions,
  resolveBugseeCli,
  runBugseeCli,
  type SpawnFn,
  type SpawnResult,
} from './run-cli';
