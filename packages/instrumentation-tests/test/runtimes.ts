// Runtime discovery + process launch for the e2e harness. Each target runs the SAME scenario module
// through a different real runtime binary, importing that runtime's own SDK package:
//   node → tsx (TS loader) + entry-node (@bugsee/node)
//   bun  → bun (native TS)  + entry-bun  (@bugsee/bun)
//   deno → deno (native TS) + entry-deno (@bugsee/deno); needs --node-modules-dir=manual to use pnpm's
//          node_modules and --sloppy-imports for our extensionless relative imports.
// A runtime whose binary is absent is reported unavailable so the runner can skip (and log) it rather
// than fail — node (via the always-present tsx devDep) is the one guaranteed target.
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export type RuntimeName = 'node' | 'bun' | 'deno';

export interface RuntimeTarget {
  name: RuntimeName;
  /** Resolved executable (absolute path or a PATH command), or undefined when unavailable. */
  bin: string | undefined;
  /** Args inserted before the entry path. */
  baseArgs: string[];
  /** Absolute path to this runtime's entry file (imports the runtime's OWN platform package). */
  entry: string;
  /**
   * Absolute path to the UMBRELLA entry (Wave 3b.1) — the same file for every runtime, importing
   * `@bugsee/bugsee` the way a customer installs it. What varies is which runtime loads it, and therefore
   * which `exports` condition the umbrella resolves through.
   */
  umbrellaEntry: string;
}

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const entryPath = (file: string): string => join(pkgRoot, 'app', file);

/** First candidate that runs `--version` (or whose `versionArgs` succeed). */
function resolveBin(
  candidates: string[],
  versionArgs: string[] = ['--version'],
): string | undefined {
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, versionArgs, { stdio: 'ignore' });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

const tsxBin = join(pkgRoot, '..', '..', 'node_modules', '.bin', 'tsx');

/** All three targets, with availability resolved. */
export function runtimeTargets(): RuntimeTarget[] {
  return [
    {
      name: 'node',
      bin: resolveBin([tsxBin], ['--version']),
      baseArgs: [],
      entry: entryPath('entry-node.ts'),
      umbrellaEntry: entryPath('entry-umbrella.ts'),
    },
    {
      name: 'bun',
      bin: resolveBin(['bun', join(homedir(), '.bun', 'bin', 'bun')]),
      baseArgs: [],
      entry: entryPath('entry-bun.ts'),
      umbrellaEntry: entryPath('entry-umbrella.ts'),
    },
    {
      name: 'deno',
      bin: resolveBin(['deno', join(homedir(), '.deno', 'bin', 'deno')]),
      baseArgs: ['run', '-A', '--node-modules-dir=manual', '--sloppy-imports'],
      entry: entryPath('entry-deno.ts'),
      umbrellaEntry: entryPath('entry-umbrella.ts'),
    },
  ];
}

/**
 * The runtime's OWN version, read from its binary (Wave 3b.1).
 *
 * Needed because Bun and Deno both expose a `process.versions.node` for compatibility, so "not the node
 * version" is not a usable assertion — comparing against the HARNESS's node version passes by accident
 * whenever the compat version merely differs from it. This gives the exact value to expect.
 */
export function runtimeOwnVersion(target: RuntimeTarget): string {
  if (target.name === 'node') {
    return process.versions.node; // the harness and the child run the same node
  }
  const bin = target.bin as string;
  const out = execFileSync(bin, ['--version'], { encoding: 'utf8' });
  // bun prints `1.3.14`; deno prints `deno 2.8.3 (stable, …)` across several lines.
  const first = out.split('\n')[0] ?? '';
  return (/(\d+\.\d+\.\d+[^\s(]*)/.exec(first)?.[1] ?? first).trim();
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the child had to be killed because it never exited (only set when a timeout was given). */
  timedOut?: boolean;
}

/** Spawn one scenario in the target runtime; resolve when it exits. `extraEnv` parameterizes a scenario
 * (e.g. a shared dataDir + the phase for the multi-instance recovery test). */
export function runScenarioProcess(
  target: RuntimeTarget,
  collectorUrl: string,
  scenario:
    | 'main'
    | 'crash'
    | 'server'
    | 'multi-instance'
    | 'disk-recovery'
    | 'worker'
    | 'propagation'
    | 'privacy'
    | 'exit-clean'
    | 'reject'
    | 'native-server',
  extraEnv: Record<string, string> = {},
  /** Kill the child and report `timedOut` if it has not exited by then. Used by the process-lifecycle
   *  scenarios, where "exits on its own" IS the assertion — without it a pinned process just stalls. */
  timeoutMs?: number,
  /** Which entry to boot: the runtime's own platform package (default) or the umbrella (Wave 3b.1). */
  entry: 'platform' | 'umbrella' = 'platform',
): Promise<ProcessResult> {
  if (target.bin === undefined) {
    return Promise.reject(new Error(`runtime ${target.name} is unavailable`));
  }
  const entryPathToRun = entry === 'umbrella' ? target.umbrellaEntry : target.entry;
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(target.bin as string, [...target.baseArgs, entryPathToRun], {
      cwd: pkgRoot,
      env: {
        ...process.env,
        BUGSEE_E2E_COLLECTOR: collectorUrl,
        BUGSEE_E2E_SCENARIO: scenario,
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    let timedOut = false;
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs);
    child.on('error', reject);
    child.on('exit', (exitCode) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}
