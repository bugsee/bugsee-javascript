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
   * `sourcesContent` — it fetches the file from the repository connected to the app. Capture costs one
   * short-lived subprocess per build and degrades to nothing at all outside a repository.
   */
  vcs?: boolean;
  /** Explicit commit SHA for this build. Falls back to `BUGSEE_BUILD_COMMIT`. Overrides detection. */
  commit?: string;
  /** Report a commit even when the working tree has uncommitted changes. Default `false`. */
  allowDirtyCommit?: boolean;
  /** Repository root the VCS resolver inspects. Defaults to the build's cwd, resolved lazily. */
  projectRoot?: string;
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
}

/** Merge plugin options with env vars, apply defaults, and decide whether the plugin is active. */
/** In-flight uploads, keyed by output directory (Wave 7.5). Entries are removed as each run settles. */
const runsByDir = new Map<string, Promise<UploadSourcemapsResult | undefined>>();

/**
 * In-flight VCS collections, keyed by project root.
 *
 * `writeBundle` fires once per OUTPUT and an SSR build emits several (SvelteKit client+server, Nuxt,
 * Next), so without this each one forks `bugsee-cli vcs-metadata` AND `git diff` concurrently for an
 * identical answer. Released on settle rather than cached permanently, so a commit made during a
 * `--watch` session is picked up by the next rebuild instead of being frozen at session start.
 */
const vcsByRoot = new Map<string, Promise<VcsMetadata | undefined>>();

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
    failOnError: options.failOnError ?? false,
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
    vcs: options.vcs ?? true,
    // Passed through RAW. `resolveCommitOverride` is the single place a commit value is validated, so a
    // malformed `BUGSEE_BUILD_COMMIT` is rejected once, in one place, rather than in two that can drift.
    commit: options.commit ?? env.BUGSEE_BUILD_COMMIT,
    allowDirtyCommit: options.allowDirtyCommit ?? false,
    projectRoot: options.projectRoot,
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
  // ORDERING NOTE: the slot is freed on a chain that settles AFTER a caller awaiting `run` resumes, so a
  // sequential caller (watch mode) always finds the slot free by its next call. That holds because this
  // function is `async` and so adds a thenable-adoption tick; making it non-async would reorder the two
  // and is not the pure refactor it looks like.
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
  const inFlight = vcsByRoot.get(projectRoot);
  if (inFlight !== undefined) {
    return inFlight;
  }
  const collection = (async (): Promise<VcsMetadata | undefined> => {
    try {
      return await resolveVcs({
        projectRoot,
        enabled: true,
        ...(resolved.commit !== undefined ? { commit: resolved.commit } : {}),
        allowDirtyCommit: resolved.allowDirtyCommit,
        onNotice: (message: string) => {
          // Routed to the plugin's own sink so a host can capture it; the default names the plugin,
          // matching every other diagnostic this package emits.
          (resolved.onError ?? ((m: unknown) => console.warn(String(m))))(`[bugsee] ${message}`);
        },
        // EMPTY on purpose. The env was already consulted by `resolvePluginOptions` above, and letting
        // the resolver fall back to `process.env` would let an ambient BUGSEE_BUILD_COMMIT defeat an
        // injected env — the very duplication the note on `commit` says is being avoided.
        env: {},
      });
    } catch {
      return undefined;
    }
  })();
  vcsByRoot.set(projectRoot, collection);
  // Already-handled (the IIFE cannot reject), so this frees the slot without creating an orphan.
  void collection.finally(() => {
    vcsByRoot.delete(projectRoot);
  });
  return collection;
}
