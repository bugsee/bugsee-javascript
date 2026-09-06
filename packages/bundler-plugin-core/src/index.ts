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
  bugseeEsbuildPlugin,
  bugseeRollupPlugin,
  bugseeRspackPlugin,
  bugseeUnplugin,
  bugseeUnpluginFactory,
  type OutputLike,
  resolveOutputDir,
} from './plugin';
export {
  type BugseePluginOptions,
  type ResolvedPluginOptions,
  resolvePluginOptions,
  runPluginUpload,
} from './resolve';
export {
  BugseeCliError,
  type EnvRecord,
  type RunBugseeCliOptions,
  resolveBugseeCli,
  runBugseeCli,
  type SpawnFn,
  type SpawnResult,
  spawnProcess,
} from './run-cli';
export {
  isWorkingTreeDirty,
  type ResolveVcsMetadataOptions,
  resolveCommitOverride,
  resolveVcsMetadata,
  type VcsMetadata,
} from './vcs';
