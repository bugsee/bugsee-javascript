// The one place `withBugsee` turns its options into a resolved build context: the plugin options merged with the
// environment (and `.env.bugsee-build-plugin`), the app identity, and the Next-specific policy. Resolved ONCE, at
// config-evaluation time, from the project directory: the define baked into the bundle and the identity the upload
// is labelled with come from this single resolution, so they cannot disagree.
import {
  type BugseePluginOptions,
  loadBuildPluginEnv,
  mergeBuildPluginEnv,
  type ResolvedPluginOptions,
  resolveIdentity,
  resolvePluginOptions,
} from '@bugsee/bundler-plugin-core';

/** Options for {@link withBugsee}: everything the bundler plugins take, plus the Next-specific switches. */
export interface WithBugseeOptions extends BugseePluginOptions {
  /**
   * Emit AND upload source maps for the server and edge bundles too. Default `true`.
   *
   * Next only writes server maps with `experimental.serverSourceMaps`; with this on, the webpack server and
   * edge compilations get `devtool: 'source-map'` (set after your own `webpack` function ran, only when you
   * left `devtool` unset), and Turbopack always emits them. Turn it off to symbolicate browser crashes only.
   * This never sets Next's `experimental.serverSourceMaps`, so the server's runtime behaviour is unchanged.
   */
  serverSourceMaps?: boolean;
  /**
   * Delete the server and edge `.map` files after a confirmed upload. Default `false`.
   *
   * Unlike `.next/static` (served to every visitor, so `deleteMaps` removes those), `.next/server` is never
   * served, and a server running with `--enable-source-maps` reads these files at runtime.
   */
  deleteServerMaps?: boolean;
  /**
   * Say nothing about configuration notices (a skipped upload, source maps switched off, a dry run's
   * capture). Failures are still reported through `onError` / the console. Default `false`.
   */
  silent?: boolean;
}

/** What every part of the integration reads. */
export interface BugseeNextContext {
  /** The plugin options after env / env-file / identity resolution. */
  resolved: ResolvedPluginOptions;
  /** Whether server/edge maps are emitted and uploaded. */
  serverSourceMaps: boolean;
  /** Whether server/edge maps are deleted after a confirmed upload. */
  deleteServerMaps: boolean;
  /** The app uses `experimental.sri` (set by `withBugsee` from the Next config it wraps). */
  sri?: boolean;
  /** A notice said once per distinct text (a no-op when `silent`). */
  say(message: string): void;
}

/** Seams for tests. */
export interface ContextDeps {
  env?: Record<string, string | undefined>;
}

/** A short stable key for a notice text (djb2). */
function noticeKey(text: string): string {
  let hash = 5381;
  for (const char of text) {
    hash = ((hash << 5) + hash + char.charCodeAt(0)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** Resolve the integration's context for `projectDir`. Never throws. */
export function createBugseeContext(
  options: WithBugseeOptions,
  projectDir: string,
  deps: ContextDeps = {},
): BugseeNextContext {
  const env = deps.env ?? process.env;
  const said = new Set<string>();
  // `text` already carries the `[bugsee]` prefix: that is what the core hands an `onNotice` sink.
  const emit = (text: string): void => {
    if (options.silent === true || said.has(text)) {
      return;
    }
    said.add(text);
    // Next loads the config in more than one process (the main one and its build workers), so the same notice
    // would print once per process. The environment is inherited by the workers it spawns afterwards, so it
    // carries "already said" across them.
    const key = noticeKey(text);
    const seen = (env.__BUGSEE_NOTICED ?? '').split(',');
    if (seen.includes(key)) {
      return;
    }
    env.__BUGSEE_NOTICED = [...seen.filter(Boolean), key].join(',');
    try {
      (options.onNotice ?? console.warn)(text);
    } catch {
      // A throwing host logger must not cost the build (the same containment the core's notify applies).
    }
  };
  const sink = (message: string): void => emit(`[bugsee] ${message}`);
  const { values, problem } =
    options.disabled === true ? { values: {}, problem: undefined } : loadBuildPluginEnv(projectDir);
  if (problem !== undefined) {
    sink(problem);
  }
  const merged = mergeBuildPluginEnv(env, values);
  const base = resolvePluginOptions(options, merged);
  const identity = resolveIdentity(options, merged, projectDir);
  return {
    resolved: {
      ...base,
      ...identity,
      // The repository the VCS resolver inspects, unless the caller chose one: the project, not the
      // process cwd (which in a monorepo is usually the workspace root).
      projectRoot: base.projectRoot ?? projectDir,
      // Routed through the integration's own sink so `silent` and de-duplication apply to every notice.
      onNotice: emit,
    },
    serverSourceMaps: options.serverSourceMaps ?? true,
    deleteServerMaps: options.deleteServerMaps ?? false,
    say: sink,
  };
}
