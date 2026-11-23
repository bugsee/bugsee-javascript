#!/usr/bin/env node
// `bugsee-sourcemaps-doctor` — the command-line face of `diagnoseBuildOutput`.
//
//   bugsee-sourcemaps-doctor <dir> [--json] [--strict] [--project-root <dir>] [--max-map-mb <n>] [--no-env]
//
// Exit codes: 0 ok, 1 warnings only with --strict, 2 errors (or a usage error).
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { diagnoseBuildOutput, doctorExitCode, formatDoctorReport } from './doctor';
import type { EnvRecord } from './run-cli';

export const DOCTOR_USAGE = `Usage: bugsee-sourcemaps-doctor <build-output-dir> [options]

Audits a build output directory for everything that stops Bugsee from symbolicating a crash.

Options:
  --json                 Print the machine-readable report (schemaVersion 1) instead of text.
  --strict               Exit 1 when there are warnings (and no errors).
  --project-root <dir>   Where .env.bugsee-build-plugin and package.json are looked up (default: cwd).
  --max-map-mb <n>       Flag source maps larger than n MiB (default 50).
  --no-env               Skip the token / version / build / NODE_ENV checks.
  --deployed             The directory is (about to be) served: leftover .map files become a warning.
  --ignore <id>          Drop a check ID from the report; repeatable.
  --                     End of options (a directory may start with a dash after it).
  -h, --help             Show this help.

Exit codes: 0 ok, 1 warnings only (with --strict), 2 errors.`;

export interface DoctorCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: EnvRecord;
}

/** Run the CLI in-process: returns the exit code, writes only through `io`. */
export async function runDoctorCli(argv: readonly string[], io: DoctorCliIo): Promise<number> {
  let dir: string | undefined;
  let json = false;
  let strict = false;
  let skipEnv = false;
  let deployed = false;
  let onlyPositionals = false;
  const ignore: string[] = [];
  let projectRoot: string | undefined;
  let maxMapBytes: number | undefined;
  const usage = (message: string): number => {
    io.stderr(`${message}\n\n${DOCTOR_USAGE}\n`);
    return 2;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (onlyPositionals) {
      if (dir !== undefined) {
        return usage(`Unexpected argument ${arg}`);
      }
      dir = arg;
    } else if (arg === '--') {
      onlyPositionals = true;
    } else if (arg === '-h' || arg === '--help') {
      io.stdout(`${DOCTOR_USAGE}\n`);
      return 0;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg === '--no-env') {
      skipEnv = true;
    } else if (arg === '--deployed') {
      deployed = true;
    } else if (arg === '--project-root' || arg === '--max-map-mb' || arg === '--ignore') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) {
        return usage(`${arg} needs a value`);
      }
      if (arg === '--project-root') {
        projectRoot = value;
      } else if (arg === '--ignore') {
        ignore.push(value);
      } else {
        const mb = Number(value);
        if (!Number.isFinite(mb) || mb <= 0) {
          return usage(`--max-map-mb needs a positive number, got "${value}"`);
        }
        maxMapBytes = mb * 1024 * 1024;
      }
    } else if (arg.startsWith('-')) {
      return usage(`Unknown option ${arg}`);
    } else if (dir === undefined) {
      dir = arg;
    } else {
      return usage(`Unexpected argument ${arg}`);
    }
  }
  if (dir === undefined) {
    return usage('Missing the build output directory');
  }
  const report = await diagnoseBuildOutput(dir, {
    env: io.env,
    skipEnv,
    deployed,
    ignore,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    ...(maxMapBytes !== undefined ? { maxMapBytes } : {}),
  });
  io.stdout(`${json ? JSON.stringify(report, null, 2) : formatDoctorReport(report)}\n`);
  return doctorExitCode(report, strict);
}

/* v8 ignore start -- process entry point: the logic above is what is tested */
const self = process.argv[1];
if (self !== undefined && realpathSync(self) === realpathSync(fileURLToPath(import.meta.url))) {
  runDoctorCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`bugsee-sourcemaps-doctor: ${String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
/* v8 ignore stop */
