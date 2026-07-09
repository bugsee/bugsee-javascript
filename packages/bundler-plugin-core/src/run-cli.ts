// SM-A1 — resolve + spawn the Rust `bugsee-cli` binary. The plugins never reimplement the CLI; they shell out
// to it (the @sentry/cli model). Spawning is behind an injectable seam so the orchestration is unit-testable
// without a real binary. Token/endpoint are passed via env vars (not argv) to keep secrets out of process lists.
import { spawn as nodeSpawn } from 'node:child_process';

export type EnvRecord = Record<string, string | undefined>;

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: EnvRecord },
) => Promise<SpawnResult>;

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
 * Resolve the `bugsee-cli` binary: an explicit `BUGSEE_CLI_PATH` override wins, otherwise the bare name
 * `bugsee-cli` (found on PATH — which includes `node_modules/.bin` under npm/pnpm scripts, where the
 * cargo-dist `@bugsee/bugsee-cli` package installs it).
 */
export function resolveBugseeCli(env: EnvRecord = process.env): string {
  const override = env.BUGSEE_CLI_PATH;
  if (override !== undefined && override.trim() !== '') {
    return override;
  }
  return 'bugsee-cli';
}

/* v8 ignore start -- thin node:child_process adapter; the injectable SpawnFn seam is what tests exercise. */
const defaultSpawn: SpawnFn = (command, args, options) =>
  new Promise<SpawnResult>((resolve, reject) => {
    const child = nodeSpawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
/* v8 ignore stop */

/** Run `bugsee-cli <args…>`, resolving the binary and forwarding token/endpoint via env. Throws on non-zero. */
export async function runBugseeCli(
  args: string[],
  options: RunBugseeCliOptions = {},
): Promise<SpawnResult> {
  const env = options.env ?? process.env;
  const binary = (options.resolveBinary ?? resolveBugseeCli)(env);
  const spawn = options.spawn ?? defaultSpawn;

  const childEnv: EnvRecord = { ...env };
  if (options.token !== undefined) {
    childEnv.BUGSEE_APP_TOKEN = options.token;
  }
  if (options.endpoint !== undefined) {
    childEnv.BUGSEE_ENDPOINT = options.endpoint;
  }

  const result = await spawn(binary, args, { cwd: options.cwd, env: childEnv });
  if (result.code !== 0) {
    throw new BugseeCliError(
      `bugsee-cli ${args.join(' ')} failed (exit ${result.code})`,
      result.code,
      result.stderr,
    );
  }
  return result;
}
