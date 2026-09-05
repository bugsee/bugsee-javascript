// SM-A4 — capture the build's VCS metadata (primarily the commit SHA) so the backend can fetch a frame's
// ORIGINAL source from the customer's connected repository when the uploaded source map carries no
// `sourcesContent`. See docs/design/source-maps.md §9.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO:
//
// 1. It does not reimplement CI/git detection. `bugsee-cli vcs-metadata` is the CANONICAL resolver — its
//    output shape is contractually byte-compatible with the Android Gradle plugin's `VcsMetadataResolver`
//    and the appserver's `sanitizeVcs`, and the iOS agent + the fastlane plugin were both deleted in favour
//    of shelling out to it. A fourth implementation, in JavaScript, is exactly the divergence that
//    consolidation removed. So we SPAWN it, per the package's D0 (plugins collect context; the CLI is the
//    engine).
// 2. It does not re-validate or re-shape the resolver's output. The fields are passed through opaquely, so
//    a provider added on the backend does not need a matching release here to survive the trip. The one
//    value we DO validate is the caller's own `commit` override, which is untrusted input typed by a human.
//
// What it ADDS on top of the CLI is the one case the canonical resolver has no notion of: a DIRTY WORKING
// TREE. A commit SHA only describes the built source if the built source was the commit.
import type { EnvRecord, RunBugseeCliOptions, SpawnFn, SpawnResult } from './run-cli';
import { runBugseeCli, spawnProcess } from './run-cli';

/**
 * The VCS metadata wire shape, snake_case because it IS the wire — `bugsee-cli vcs-metadata` emits it and
 * the appserver's `VcsMetadataSchema` stores it verbatim (`build.vcs.*`). Renaming a field here is a
 * cross-repo coordination event, not a local style choice.
 *
 * Every field is optional and simply absent when unknown, which is how the backend distinguishes "unknown"
 * from "known empty".
 */
export interface VcsMetadata {
  provider?: string;
  commit_sha?: string;
  base_sha?: string;
  branch?: string;
  base_branch?: string;
  pr_number?: number;
  repo?: string;
  /** Forward-compatible: fields the resolver gains are carried through untouched. */
  [key: string]: unknown;
}

/**
 * The appserver's own commit-SHA shape guard, verbatim (`build.vcs-helper.js` `validSha`, and the same
 * regex again on `VcsMetadataSchema.commit_sha` and in the `get_build_by_commit` tool). A value that
 * cannot pass this is one the backend would drop on arrival, so rejecting it here turns a silent
 * server-side discard into something the build log can say out loud.
 */
const COMMIT_SHA_RE = /^[0-9a-fA-F]{7,64}$/;

/**
 * Wall-clock budget for `bugsee-cli vcs-metadata`, in ms.
 *
 * Deliberately far below the 120 s upload budget: this is a metadata probe that forks `git rev-parse` at
 * worst, and it runs on the critical path of every production build. A network-mounted or enormous
 * repository must cost the build a few seconds and then be given up on, never the upload timeout.
 */
export const VCS_TIMEOUT_MS = 15_000;

/** Wall-clock budget for the `git diff` dirtiness probe, in ms. Same reasoning, smaller job. */
export const DIRTY_TIMEOUT_MS = 10_000;

/** `git diff --quiet` reports "there is a difference" as exit 1; 0 is "no difference". */
const GIT_DIFF_CLEAN = 0;
const GIT_DIFF_DIRTY = 1;

/**
 * Resolve the caller's explicit commit override — the plugin `commit` option, else `BUGSEE_BUILD_COMMIT`.
 *
 * Returns the trimmed SHA, or `undefined` when absent OR malformed. Malformed is deliberately NOT an
 * error: a telemetry side effect must not break a production deploy, and the resolver below still runs.
 */
export function resolveCommitOverride(
  explicit: string | undefined,
  env: EnvRecord,
): string | undefined {
  const raw = explicit ?? env.BUGSEE_BUILD_COMMIT;
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return COMMIT_SHA_RE.test(trimmed) ? trimmed : undefined;
}

/**
 * Is the working tree at `dir` different from `HEAD`?
 *
 * `true` dirty · `false` clean · `undefined` UNKNOWN (not a repository, no commits yet, no `git` on PATH,
 * a git that hung or was killed). Unknown is a distinct answer from dirty on purpose — see the gate in
 * {@link resolveVcsMetadata}.
 *
 * `git diff --quiet HEAD --` is the whole probe: comparing against `HEAD` (rather than the index) means a
 * STAGED-but-uncommitted change counts as dirty too, and it deliberately ignores UNTRACKED files — an
 * untracked file changes nothing about the source of any committed file, so counting it would disable the
 * feature on almost every real working checkout. The trailing `--` stops a path/revision ambiguity.
 *
 * `git` is PATH-resolved rather than pinned, for the same reason bugsee-cli's resolver does it: Homebrew,
 * asdf/mise and NixOS users have no `/usr/bin/git`, and pinning would silently disable this everywhere.
 */
export async function isWorkingTreeDirty(
  dir: string,
  spawn: SpawnFn = spawnProcess,
  timeoutMs: number = DIRTY_TIMEOUT_MS,
): Promise<boolean | undefined> {
  const controller = new AbortController();
  // ONE timer for both jobs: it aborts the child (which is what actually kills a hung `git`) and
  // resolves the race arm that stops US waiting on a spawn that ignores the signal. Two timers left a
  // pending closure per probe — harmless but accumulating once per rebuild under `--watch`.
  let onTimeout!: () => void;
  const timedOut = new Promise<undefined>((resolve) => {
    onTimeout = () => {
      controller.abort();
      // Resolving, not rejecting, keeps the timeout on the same "unknown" path as every other failure.
      resolve(undefined);
    };
  });
  const timer = setTimeout(onTimeout, timeoutMs);
  timer.unref?.(); // never keep the build's process alive on a dirtiness probe
  try {
    const result = await Promise.race([
      spawn('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: dir, signal: controller.signal }),
      timedOut,
    ]);
    if (result === undefined) {
      return undefined;
    }
    if (result.code === GIT_DIFF_CLEAN) {
      return false;
    }
    return result.code === GIT_DIFF_DIRTY ? true : undefined;
  } catch {
    // No git binary, an aborted child, a spawn that rejected — all of it is "we cannot tell".
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Injectable `bugsee-cli` runner, matching `runBugseeCli`. */
type RunCli = (args: string[], options: RunBugseeCliOptions) => Promise<SpawnResult>;

export interface ResolveVcsMetadataOptions {
  /** Directory the resolver inspects. Should be the project root (where `.git` lives). */
  projectRoot: string;
  /** Turn resolution off entirely. Default `true` (on). */
  enabled?: boolean;
  /** Explicit commit SHA, overriding whatever the resolver finds. */
  commit?: string;
  /** Environment consulted for `BUGSEE_BUILD_COMMIT`. Default `process.env`. */
  env?: EnvRecord;
  /**
   * Report a commit SHA even when the working tree is dirty. Default `false`.
   *
   * Off by default because the failure it prevents is silent and misleading: the backend would fetch the
   * committed version of a file and display those lines as the crashing frame's source. Wrong code shown
   * confidently is worse than no code shown.
   */
  allowDirtyCommit?: boolean;
  /** Injectable `bugsee-cli` runner (default {@link runBugseeCli}). */
  run?: RunCli;
  /** Injectable dirtiness probe (default {@link isWorkingTreeDirty}). */
  checkDirty?: (dir: string) => Promise<boolean | undefined>;
  /**
   * Where a user-actionable notice goes. Default: silence.
   *
   * Only the two cases a user can DO something about are reported — a malformed override they typed, and
   * a SHA dropped because their tree was dirty. Everything else (no repo, no `git`, an old CLI) is the
   * ordinary state of a build that simply has no VCS context, and warning about it on every build would
   * be noise.
   */
  onNotice?: (message: string) => void;
}

/**
 * Collect the build's VCS metadata. Returns `undefined` when nothing could be determined — never throws,
 * and never fails a build.
 */
export async function resolveVcsMetadata(
  options: ResolveVcsMetadataOptions,
): Promise<VcsMetadata | undefined> {
  const { projectRoot } = options;
  const notice = options.onNotice ?? ((): void => undefined);
  const env = options.env ?? process.env;
  const rawCommit = options.commit ?? env.BUGSEE_BUILD_COMMIT;
  const override = resolveCommitOverride(options.commit, env);
  if (rawCommit !== undefined && override === undefined) {
    // The claim that this is "something the build log can say out loud" is only true if it is said.
    notice(
      `ignoring the configured commit ${JSON.stringify(rawCommit)}: expected 7-64 hex characters, ` +
        'so the backend would have discarded it. No commit will be recorded for this build.',
    );
  }
  if (options.enabled === false) {
    // Detection off still honours a commit the caller stated explicitly: "do not shell out, I will tell
    // you the SHA myself" is a reasonable reading, and silently discarding it is not.
    return override !== undefined ? { commit_sha: override } : undefined;
  }
  const run = options.run ?? runBugseeCli;

  const resolved = await runResolver(run, projectRoot);
  const metadata: VcsMetadata = { ...resolved };

  if (override !== undefined) {
    // An explicit SHA skips the dirty gate: the caller asserted this specific commit describes this
    // specific build, which is the whole point of the escape hatch (a CI that builds from an artifact
    // rather than a checkout has no working tree to judge).
    metadata.commit_sha = override;
  } else if (metadata.commit_sha !== undefined && options.allowDirtyCommit !== true) {
    const checkDirty = options.checkDirty ?? isWorkingTreeDirty;
    let isDirty: boolean | undefined;
    try {
      isDirty = await checkDirty(projectRoot);
    } catch {
      isDirty = undefined; // a probe that threw tells us nothing; see below
    }
    // ONLY a definite `true` drops the SHA. `undefined` keeps it, because "we could not tell" is the
    // normal state of the most common deployment there is — a CI container with no `git` binary and no
    // `.git` directory, whose SHA came from the CI provider's env var and is entirely trustworthy.
    if (isDirty === true) {
      delete metadata.commit_sha;
      // `base_sha` is the same kind of claim about the same tree, so it goes with it.
      delete metadata.base_sha;
      notice(
        'the working tree has uncommitted changes to tracked files, so no commit was recorded for ' +
          'this build (the original source shown for a crash frame would not have matched what was ' +
          'built). Commit the changes, or pass allowDirtyCommit: true to record it anyway.',
      );
    }
  }

  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

/** Spawn the canonical resolver and parse its stdout. Any failure at all resolves to `{}`. */
async function runResolver(run: RunCli, projectRoot: string): Promise<VcsMetadata> {
  let stdout: string;
  try {
    const result = await run(['vcs-metadata', '--working-dir', projectRoot], {
      // No token is PASSED: `vcs-metadata` performs no network I/O, so it needs no credentials. (The
      // child still inherits the ambient environment, which is the same binary's own anyway.)
      cwd: projectRoot,
      timeoutMs: VCS_TIMEOUT_MS,
    });
    stdout = result.stdout;
  } catch {
    // Not installed, an old CLI without the subcommand, a non-zero exit, a timeout. The plugin's whole
    // contract is that build tooling degrades to doing nothing rather than failing the build.
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {};
  }
  // A plain object is the only shape the contract allows. The two arms that CHANGE the outcome are the
  // array (typeof 'object', spreads into numeric keys) and the string (spreads into per-character keys);
  // `null`/number/boolean spread to `{}` and would be filtered by the emptiness check below anyway, so
  // they are named here for intent, not for effect — the tests say the same.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as VcsMetadata;
}
