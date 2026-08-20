// SM-A1 — resolve + spawn the Rust `bugsee-cli` binary. The plugins never reimplement the CLI; they shell out
// to it (the @sentry/cli model). Spawning is behind an injectable seam so the orchestration is unit-testable
// without a real binary. Token/endpoint are passed via env vars (not argv) to keep secrets out of process lists.
import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';

export type EnvRecord = Record<string, string | undefined>;

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: EnvRecord; signal?: AbortSignal },
) => Promise<SpawnResult>;

/** Default wall-clock budget for one `bugsee-cli` invocation (Wave 7.4). */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The options handed to `node:child_process.spawn` — a pure function so they can be ASSERTED.
 *
 * They are this package's security surface, and they used to be an inline literal inside a
 * `/* v8 ignore *\/`'d adapter, which is how the review's `shell: true` mutation survived the whole suite.
 * `shell: true` on a command line carrying user-supplied paths is the single most dangerous change
 * possible here, so it is now something a test can see.
 */
export function spawnOptionsFor(options: { cwd?: string; env?: EnvRecord; signal?: AbortSignal }): {
  cwd?: string;
  env?: EnvRecord;
  signal?: AbortSignal;
  stdio: [string, string, string];
} {
  return {
    cwd: options.cwd,
    env: options.env,
    // NEVER a shell: the argv carries user-supplied output paths.
    // stdin is `ignore` so the child can never consume the build's input; both output streams are captured
    // for the error message.
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
}

export interface RunBugseeCliOptions {
  /** Sent as `BUGSEE_APP_TOKEN` (the CLI reads it as `--app-token`). */
  token?: string;
  /** Sent as `BUGSEE_ENDPOINT` (the CLI reads it as `--endpoint`). */
  endpoint?: string;
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Injectable spawn (defaults to a node:child_process wrapper). */
  spawn?: SpawnFn;
  /** Injectable binary resolver (defaults to {@link resolveBugseeCli}). */
  resolveBinary?: (env: EnvRecord) => string;
  /** Base environment (defaults to `process.env`). */
  env?: EnvRecord;
  /**
   * Wall-clock budget for the child, in ms. Default 120 000 (Wave 7.4).
   *
   * Without one, the promise settled only on the child's `close`/`error`, so a CLI blocked on a hanging TCP
   * connect — reachable purely through a misconfigured `endpoint` on a firewalled CI network — left the
   * build pending until the CI job's own global timeout, with no diagnostic.
   */
  timeoutMs?: number;
}

/** A non-zero `bugsee-cli` exit; carries the exit code + captured stderr. */
export class BugseeCliError extends Error {
  readonly code: number;
  readonly stderr: string;
  constructor(message: string, code: number, stderr: string) {
    super(message);
    this.name = 'BugseeCliError';
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Resolve the `bugsee-cli` launcher: an explicit `BUGSEE_CLI_PATH` override wins, otherwise the
 * launcher script inside the installed `@bugsee/bugsee-cli` package, resolved from THIS module.
 *
 * It used to return the bare name `bugsee-cli` and rely on PATH. `@bugsee/bugsee-cli` is a dependency
 * of this package, not of the consuming project, so under pnpm its bin is never linked into that
 * project's root `node_modules/.bin` — a real consumer's build failed with ENOENT, and it only ever
 * worked inside this monorepo because the binary happened to be on PATH there. Resolving through
 * `require.resolve` is independent of PATH, of the package manager's layout, and of which script the
 * build was started from.
 *
 * `BUGSEE_CLI_PATH` remains the escape hatch for locked-down/offline CI that blocks the download.
 */
export function resolveBugseeCli(
  env: EnvRecord = process.env,
  /** Injectable module resolution, so the not-installed fallback below is reachable in a test. */
  resolveModule: (specifier: string) => string = (specifier) =>
    createRequire(import.meta.url).resolve(specifier),
): string {
  const override = env.BUGSEE_CLI_PATH;
  if (override !== undefined && override.trim() !== '') {
    return override;
  }
  try {
    // The package's `bin` entry — a small node launcher that execs the downloaded platform binary.
    return resolveModule('@bugsee/bugsee-cli/run-bugsee-cli.js');
  } catch {
    // Not installed (a consumer who deliberately pruned it, or an exotic layout): fall back to PATH
    // so an explicitly-provisioned binary still works, rather than failing outright here.
    return 'bugsee-cli';
  }
}

/**
 * The exit code reported for a child that was TERMINATED rather than exited (`close` gives `code: null`).
 *
 * It used to be mapped to `0` — the shell's success code. A `bugsee-cli` killed by the Linux OOM killer on
 * a large source-map tree, or by a cancelled CI job's SIGTERM, therefore looked like a completed upload:
 * `uploadSourcemaps` treated it as CONFIRMED and went on to step 3, deleting the client `.map` files. The
 * only copy of the mapping, destroyed for symbols that were never delivered — with a green build.
 */
const SIGNAL_EXIT_CODE = -1;

const defaultSpawn: SpawnFn = (command, args, options) =>
  new Promise<SpawnResult>((resolve, reject) => {
    const child = nodeSpawn(command, args, spawnOptionsFor(options) as never);
    let stdout = '';
    let stderr = '';
    /* v8 ignore next 2 -- `stdio: [_, 'pipe', 'pipe']` always gives us both streams; the `?.` only
       satisfies the nullable child_process types. */
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === null) {
        // Keep whatever the child managed to say, and name the signal — otherwise the failure is a bare
        // exit code with no cause anywhere in the build log.
        resolve({
          code: SIGNAL_EXIT_CODE,
          stdout,
          stderr: `${stderr}bugsee-cli was terminated by signal ${String(signal)}\n`,
        });
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });

/** Run `bugsee-cli <args…>`, resolving the binary and forwarding token/endpoint via env. Throws on non-zero. */
export async function runBugseeCli(
  args: string[],
  options: RunBugseeCliOptions = {},
): Promise<SpawnResult> {
  const env = options.env ?? process.env;
  const binary = (options.resolveBinary ?? resolveBugseeCli)(env);
  // The resolved default is the package's node launcher, a `.js` file. Running it through
  // `process.execPath` rather than executing it directly keeps this working on Windows, where a
  // `.js` file is not spawnable and there is no `.cmd` shim for a transitive dependency's bin.
  const isScript = binary.endsWith('.js');
  const command = isScript ? process.execPath : binary;
  const commandArgs = isScript ? [binary, ...args] : args;
  const spawn = options.spawn ?? defaultSpawn;

  const childEnv: EnvRecord = { ...env };
  if (options.token !== undefined) {
    childEnv.BUGSEE_APP_TOKEN = options.token;
  }
  if (options.endpoint !== undefined) {
    childEnv.BUGSEE_ENDPOINT = options.endpoint;
  }

  // The watchdog lives HERE rather than in the spawn adapter, so it is in the layer tests can drive. The
  // signal is what actually kills the child — rejecting alone would leave an orphan holding its handles.
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.(); // never keep the build's process alive on our account

  let result: SpawnResult;
  try {
    result = await spawn(command, commandArgs, {
      cwd: options.cwd,
      env: childEnv,
      signal: controller.signal,
    });
  } catch (error) {
    throw timedOut
      ? new Error(`bugsee-cli ${args.join(' ')} timed out after ${timeoutMs}ms`)
      : error;
  } finally {
    clearTimeout(timer);
  }

  if (result.code !== 0) {
    throw new BugseeCliError(
      `bugsee-cli ${args.join(' ')} failed (exit ${result.code})`,
      result.code,
      result.stderr,
    );
  }
  return result;
}
