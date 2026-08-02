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
import { fileURLToPath } from 'node:url';

export type RuntimeName = 'node' | 'bun' | 'deno';

export interface RuntimeTarget {
  name: RuntimeName;
  /** Resolved executable (absolute path or a PATH command), or undefined when unavailable. */
  bin: string | undefined;
  /** Args inserted before the entry path. */
  baseArgs: string[];
  /** Absolute path to this runtime's entry file. */
  entry: string;
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
    },
    {
      name: 'bun',
      bin: resolveBin(['bun', join(homedir(), '.bun', 'bin', 'bun')]),
      baseArgs: [],
      entry: entryPath('entry-bun.ts'),
    },
    {
      name: 'deno',
      bin: resolveBin(['deno', join(homedir(), '.deno', 'bin', 'deno')]),
      baseArgs: ['run', '-A', '--node-modules-dir=manual', '--sloppy-imports'],
      entry: entryPath('entry-deno.ts'),
    },
  ];
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
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
    | 'privacy',
  extraEnv: Record<string, string> = {},
): Promise<ProcessResult> {
  if (target.bin === undefined) {
    return Promise.reject(new Error(`runtime ${target.name} is unavailable`));
  }
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(target.bin as string, [...target.baseArgs, target.entry], {
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
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
