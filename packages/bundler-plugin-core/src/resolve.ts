// SM-A3 — user-facing plugin option resolution + the guarded upload entry. Merges explicit plugin options
// with environment variables, applies defaults, and decides whether the plugin is active (a token is
// required; a build without one is a no-op rather than an error). Pure + injectable for testing.

import {
  uploadSourcemaps as defaultUploadSourcemaps,
  type UploadSourcemapsResult,
} from './orchestrate';
import type { EnvRecord } from './run-cli';
import { resolveVcsMetadata as defaultResolveVcsMetadata, type VcsMetadata } from './vcs';

/** User-facing options for the Bugsee bundler plugin. */
export interface BugseePluginOptions {
  /** Bugsee app token. Falls back to `BUGSEE_APP_TOKEN`. Required to upload; absent ⇒ the plugin no-ops. */
  appToken?: string;
  /** App version. Falls back to `BUGSEE_APP_VERSION`, else `0.0.0`. */
  appVersion?: string;
  /** Build number. Falls back to `BUGSEE_APP_BUILD`, else `0`. */
  appBuild?: string;
  /** API endpoint override. Falls back to `BUGSEE_ENDPOINT`. */
  endpoint?: string;
  /** Delete client `.map`s after upload. Default `true`. */
  deleteMaps?: boolean;
  /** Run bugsee-cli with `--dry-run` (no upload, no deletion). */
  dryRun?: boolean;
  /**
   * Upload source maps WITHOUT their embedded `sourcesContent` (bugsee-cli >= 0.7.11). Default
   * `false`.
   *
   * The map's `sourcesContent` is your source verbatim, and it is what lets a symbolicated crash show
   * source lines. Stripping it keeps file/line/column resolution and drops the snippet, for teams who
   * would rather their code did not leave the build machine. The maps on disk are not modified.
   */
  stripSourcesContent?: boolean;
  /** Disable the plugin entirely (e.g. dev builds). */
  disabled?: boolean;
  /**
   * FAIL the build when the source-map upload fails. Default `false` (Wave 7).
   *
   * A telemetry side effect must not be able to break a production deploy: before this, an expired token,
   * a transient network error or a `bugsee-cli` missing from PATH aborted the user's build with no escape
   * hatch. Teams that would rather stop on a failed upload opt in.
   */
  failOnError?: boolean;
  /** Where a contained failure is reported. Default: a console warning naming the plugin. */
  onError?: (error: unknown) => void;
  /**
   * Capture the build's VCS metadata (commit SHA, branch, repo) via `bugsee-cli vcs-metadata`.
   * Default `true`.
   *
   * The commit is what lets the backend show a frame's ORIGINAL source when the uploaded map carries no
   * `sourcesContent` — it fetches the file from the repository connected to the app. Capture costs two
   * short-lived subprocesses (`bugsee-cli vcs-metadata` and a `git diff` dirtiness probe) per OUTPUT
   * DIRECTORY, and degrades to nothing at all outside a repository.
   */
  vcs?: boolean;
  /** Explicit commit SHA for this build. Falls back to `BUGSEE_BUILD_COMMIT`. Overrides detection. */
  commit?: string;
  /** Report a commit even when the working tree has uncommitted changes. Default `false`. */
  allowDirtyCommit?: boolean;
  /** Repository root the VCS resolver inspects. Defaults to the build's cwd, resolved lazily. */
  projectRoot?: string;
  /**
   * Where user-actionable NOTICES go — a malformed `commit`, a SHA dropped because the tree was dirty,
   * and (on `dryRun`) what was captured. Default: a `console.warn` naming the plugin.
   *
   * Separate from {@link BugseePluginOptions.onError}, which reports contained FAILURES and always
   * receives an `Error`. These are plain strings about configuration, not failures.
   */
  onNotice?: (message: string) => void;
}

export interface ResolvedPluginOptions {
  /** Whether the plugin should act (a token is present and it isn't disabled). */
  enabled: boolean;
  appToken: string;
  appVersion: string;
  appBuild: string;
  endpoint: string | undefined;
  deleteMaps: boolean;
  dryRun: boolean;
  stripSourcesContent: boolean;
  /** Whether a failed upload should abort the build. Default false. */
  failOnError: boolean;
  /** Failure sink for the contained path. */
  onError?: (error: unknown) => void;
  /** Whether to capture the build's VCS metadata. Default true. */
  vcs: boolean;
  /** Explicit commit SHA override (unvalidated here; `resolveVcsMetadata` is the single validator). */
  commit: string | undefined;
  /** Whether a dirty working tree may still report a commit. Default false. */
  allowDirtyCommit: boolean;
  /**
   * Repository root the VCS resolver inspects; `undefined` means "the build's cwd", resolved LAZILY at
   * collection time.
   *
   * Deliberately not defaulted here. This function runs synchronously from `bugseeUnpluginFactory` at
   * config-evaluation time, outside every containment layer — not in `runPluginUpload`, not in
   * `uploadSourcemaps`, not gated on `failOnError`. `process.cwd()` THROWS (`ENOENT … uncwd`) when the
   * process's working directory has been unlinked, which a build script that recreates its own directory
   * really does, so calling it here would fail the build from a plugin whose whole contract is that it
   * cannot — and would do so even for a fully disabled plugin.
   */
  projectRoot: string | undefined;
  /** Notice sink; `undefined` means the default console warning. */
  onNotice: ((message: string) => void) | undefined;
}

/** Merge plugin options with env vars, apply defaults, and decide whether the plugin is active. */
/** In-flight uploads, keyed by output directory (Wave 7.5). Entries are removed as each run settles. */
const runsByDir = new Map<string, Promise<UploadSourcemapsResult | undefined>>();

export function resolvePluginOptions(
  options: BugseePluginOptions,
  env: EnvRecord,
): ResolvedPluginOptions {
  const appToken = options.appToken ?? env.BUGSEE_APP_TOKEN ?? '';
  return {
    enabled: !options.disabled && appToken !== '',
    appToken,
    appVersion: options.appVersion ?? env.BUGSEE_APP_VERSION ?? '0.0.0',
    appBuild: options.appBuild ?? env.BUGSEE_APP_BUILD ?? '0',
    endpoint: options.endpoint ?? env.BUGSEE_ENDPOINT,
    deleteMaps: options.deleteMaps ?? true,
    dryRun: options.dryRun ?? false,
    stripSourcesContent: options.stripSourcesContent ?? false,
    failOnError: options.failOnError ?? false,
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
    vcs: options.vcs ?? true,
    // Passed through RAW. `resolveCommitOverride` is the single place a commit value is validated, so a
    // malformed `BUGSEE_BUILD_COMMIT` is rejected once, in one place, rather than in two that can drift.
    commit: options.commit ?? env.BUGSEE_BUILD_COMMIT,
    allowDirtyCommit: options.allowDirtyCommit ?? false,
    projectRoot: options.projectRoot,
    onNotice: options.onNotice,
  };
}

/** Run the upload for a resolved config against a build output dir — a no-op when the plugin is disabled. */
export async function runPluginUpload(
  resolved: ResolvedPluginOptions,
  outDir: string,
  deps: {
    uploadSourcemaps?: typeof defaultUploadSourcemaps;
    resolveVcs?: typeof defaultResolveVcsMetadata;
  } = {},
): Promise<UploadSourcemapsResult | undefined> {
  if (!resolved.enabled) {
    return undefined;
  }
  // One pipeline per output DIRECTORY (Wave 7.5). `writeBundle` fires once per OUTPUT, so a multi-output
  // config whose entries resolve to the same directory — `[{ dir: 'dist' }, { file: 'dist/legacy.js' }]`,
  // both `dist` — used to start two concurrent pipelines over one tree, with one deleting maps (step 3)
  // while the other was still reading them (steps 1-2). A concurrent caller JOINS the in-flight run and
  // gets its result; the entry is released on settle, so `vite build --watch` still uploads every rebuild.
  const inFlight = runsByDir.get(outDir);
  if (inFlight !== undefined) {
    return inFlight;
  }
  const uploadSourcemaps = deps.uploadSourcemaps ?? defaultUploadSourcemaps;
  const run = collectVcs(resolved, deps.resolveVcs).then((vcs) =>
    uploadSourcemaps({
      outDir,
      appToken: resolved.appToken,
      appVersion: resolved.appVersion,
      appBuild: resolved.appBuild,
      endpoint: resolved.endpoint,
      deleteMaps: resolved.deleteMaps,
      dryRun: resolved.dryRun,
      stripSourcesContent: resolved.stripSourcesContent,
      failOnError: resolved.failOnError,
      ...(resolved.onError !== undefined ? { onError: resolved.onError } : {}),
      // Omitted, not sent empty: absence is how the backend tells "no VCS context" from "known empty".
      ...(vcs !== undefined ? { vcs } : {}),
    }),
  );
  // The ORIGINAL promise is stored, so a joiner sees the same outcome — including the same failure. The
  // cleanup rides a separate, already-handled chain: storing `run.finally(…)` instead would create a
  // DERIVED promise that nobody awaits, and a failed run would surface as an unhandled rejection.
  //
  // `finally`, not `then`: a failed run must free the slot too, or every later build of that directory
  // would be blocked by a corpse.
  //
  // ORDERING NOTE (measured, not assumed): the slot is freed BEFORE a caller awaiting `run` resumes —
  // `await runPluginUpload(...)` observes `slot-freed -> caller-resumed`. That is what makes a
  // sequential caller (watch mode) find the slot free on its next call. It holds because this function
  // is `async` and so adds a thenable-adoption tick; the non-async variant reverses the two, leaving
  // the slot still held when the caller resumes. Not the pure refactor it looks like.
  runsByDir.set(outDir, run);
  void run
    .catch(() => undefined)
    .finally(() => {
      runsByDir.delete(outDir);
    });
  return run;
}

/**
 * Collect the build's VCS metadata, absorbing every failure.
 *
 * A commit SHA is a *nice-to-have* enrichment of a source-map upload; the maps themselves are the point.
 * So a resolver that threw must not stop the upload, let alone the build.
 */
async function collectVcs(
  resolved: ResolvedPluginOptions,
  resolveVcs: typeof defaultResolveVcsMetadata = defaultResolveVcsMetadata,
): Promise<VcsMetadata | undefined> {
  if (!resolved.vcs) {
    // Short-circuited HERE as well as inside the resolver, so a disabled feature resolves no cwd,
    // spawns nothing and cannot fail for any reason at all.
    return undefined;
  }
  // `process.cwd()` is reached only now — inside the try, on the contained path. See the note on
  // `ResolvedPluginOptions.projectRoot`.
  let projectRoot: string;
  try {
    projectRoot = resolved.projectRoot ?? process.cwd();
  } catch {
    return undefined;
  }
  try {
    const vcs = await resolveVcs({
      projectRoot,
      enabled: true,
      ...(resolved.commit !== undefined ? { commit: resolved.commit } : {}),
      allowDirtyCommit: resolved.allowDirtyCommit,
      onNotice: notify(resolved),
      // EMPTY on purpose. The env was already consulted by `resolvePluginOptions` above, and letting
      // the resolver fall back to `process.env` would let an ambient BUGSEE_BUILD_COMMIT defeat an
      // injected env — the very duplication the note on `commit` says is being avoided.
      env: {},
    });
    if (resolved.dryRun) {
      // The documented way to confirm capture works. Without it a dry run prints nothing about the
      // VCS metadata at all, which for a CAPTURE-ONLY feature leaves a user no way to tell whether it
      // did anything — the plugin discards `uploadSourcemaps`' return value.
      notify(resolved)(
        vcs === undefined
          ? 'no VCS metadata was captured for this build'
          : `captured VCS metadata: ${JSON.stringify(vcs)}`,
      );
    }
    return vcs;
  } catch {
    return undefined;
  }
}

/**
 * The plugin's notice sink: a user-actionable message, distinct from a contained FAILURE.
 *
 * Deliberately NOT `onError`. That option is documented as "where a contained failure is reported" and
 * everywhere else receives an `Error`, so hosts do `e.message`, `e.stack`, `e instanceof Error`, or
 * fail their pipeline on a non-empty list. Feeding a plain informational string about a dirty working
 * tree into it would break all four.
 */
function notify(resolved: ResolvedPluginOptions): (message: string) => void {
  return (message) => {
    const text = `[bugsee] ${message}`;
    try {
      if (resolved.onNotice !== undefined) {
        resolved.onNotice(text);
        return;
      }
      console.warn(text);
    } catch {
      // GUARDED HERE, not only inside the resolver. The resolver wraps its own `notice()` calls, but
      // the dry-run diagnostic above calls this sink DIRECTLY, inside the try whose catch discards the
      // metadata — so a throwing host logger cost the caller the whole VcsMetadata object rather than
      // one message, which is the exact trade the resolver's contract says never to make.
    }
  };
}
