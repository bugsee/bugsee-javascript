// @bugsee/angular/sourcemaps — upload the source maps of an Angular build. Node-only: it is a build-time entry
// and is never imported by the runtime entry (`@bugsee/angular`), so it cannot reach a browser bundle.
export { type CliIo, HELP, parseArgs, runCli } from './cli';
export {
  type AngularOutput,
  type ResolveAngularOutputOptions,
  resolveAngularOutput,
} from './output';
export {
  type AngularUploadDeps,
  type AngularUploadOptions,
  type AngularUploadResult,
  uploadAngularSourcemaps,
} from './upload';
