// `.env.bugsee-build-plugin` — the file the setup wizard writes the app token to (kept out of version control),
// the way Sentry's plugin reads `.env.sentry-build-plugin`. Lookup order for every setting: plugin option, then
// the process environment, then this file. The file only FILLS GAPS: a variable the environment already
// carries is never overridden, and `process.env` itself is never written to. Nothing here may fail a build:
// a missing, unreadable or malformed file is "no values" (plus, when a file WAS found but unusable, one
// non-fatal notice that never contains a value).
//
// Two boundaries keep a stray file from reaching projects it was never written for:
//  - KEYS. Only the app token, version and build are read from the file (`FILE_KEYS`). `BUGSEE_ENDPOINT` and
//    `BUGSEE_CLI_PATH` are deliberately NOT: a file that can set them could redirect every upload, with the
//    token, to another host, or choose which binary runs. They stay environment / plugin-option only.
//  - PLACE. The search starts at the bundler's project directory and walks up only to the repository /
//    workspace root (a directory holding `.git` or `pnpm-workspace.yaml`). With no such root only the
//    project directory itself is read. It never reads in, or above, the home directory, so a leftover
//    `~/.env.bugsee-build-plugin` cannot give a token to every project below it.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { EnvRecord } from './run-cli';

export const BUILD_PLUGIN_ENV_FILE = '.env.bugsee-build-plugin';

/** The only settings the file may supply. */
export const FILE_KEYS: ReadonlySet<string> = new Set([
  'BUGSEE_APP_TOKEN',
  'BUGSEE_APP_VERSION',
  'BUGSEE_APP_BUILD',
]);

const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function unquote(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    // An unterminated quote is kept verbatim rather than guessed at.
    return end > 0 ? value.slice(1, end) : value;
  }
  // Unquoted: an inline comment starts at whitespace + `#`.
  const hash = value.search(/\s#/);
  return (hash === -1 ? value : value.slice(0, hash)).trim();
}

/** Parse dotenv text. Only {@link FILE_KEYS} are kept; malformed lines are skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const match = LINE.exec(line.trim());
    if (match?.[1] !== undefined && FILE_KEYS.has(match[1]) && match[2] !== undefined) {
      out[match[1]] = unquote(match[2]);
    }
  }
  return out;
}

/** What a lookup found. `problem` says why a FOUND file gave nothing (never contains a value). */
export interface EnvFileResult {
  values: Record<string, string>;
  /** Path of the file that was found, when one was. */
  path?: string;
  problem?: string;
}

/** Injectable environment of the lookup, for tests. */
export interface EnvFileLookupOptions {
  cwd?: () => string;
  home?: () => string;
}

const isBoundary = (dir: string): boolean =>
  existsSync(join(dir, '.git')) || existsSync(join(dir, 'pnpm-workspace.yaml'));

/** True for the home directory and everything above it: never searched. */
const atOrAbove = (dir: string, home: string): boolean => {
  const rel = relative(dir, home);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
};

/**
 * Load the NEAREST `.env.bugsee-build-plugin` at or above `root` (the bundler's project directory; the
 * working directory when none is known), within the boundaries described at the top of this file.
 */
export function loadBuildPluginEnv(
  root: string | undefined,
  lookup: EnvFileLookupOptions = {},
): EnvFileResult {
  let dir: string;
  let home: string;
  try {
    dir = resolve(root ?? (lookup.cwd ?? (() => process.cwd()))());
    home = resolve((lookup.home ?? homedir)());
  } catch {
    return { values: {} };
  }
  // Where the walk may end: the nearest repository / workspace root, else the project directory itself.
  let top = dir;
  for (let probe = dir; ; probe = dirname(probe)) {
    if (isBoundary(probe)) {
      top = probe;
      break;
    }
    if (dirname(probe) === probe) {
      break;
    }
  }
  for (let current = dir; ; current = dirname(current)) {
    const path = join(current, BUILD_PLUGIN_ENV_FILE);
    if (atOrAbove(current, home)) {
      // A project that IS the home directory (a container WORKDIR of /root) is never searched: say so
      // rather than silently ignoring a file the user put there on purpose.
      return current === dir && existsSync(path)
        ? {
            values: {},
            path,
            problem: `${path} is in your home directory, which is never searched for ${BUILD_PLUGIN_ENV_FILE}; it was ignored. Set the variables in the environment, or build from a project subdirectory.`,
          }
        : { values: {} };
    }
    if (existsSync(path)) {
      return readEnvFile(path);
    }
    if (current === top || dirname(current) === current) {
      return { values: {} };
    }
  }
}

function readEnvFile(path: string): EnvFileResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'error';
    return { values: {}, path, problem: `${path} could not be read (${code}); it was ignored.` };
  }
  if (text.includes('\u0000') || text.includes('�')) {
    return {
      values: {},
      path,
      problem: `${path} is not UTF-8 text (is it UTF-16 or binary?); it was ignored.`,
    };
  }
  const values = parseEnvFile(text);
  // An empty value (`BUGSEE_APP_TOKEN=`) is not usable either: it would silently disable the plugin.
  const usable = Object.values(values).some((value) => value.trim() !== '');
  if (!usable) {
    return {
      values,
      path,
      problem:
        `${path} was found but holds no usable ${[...FILE_KEYS].join(' / ')} entry ` +
        '(expected UTF-8 `KEY=value` lines with a non-empty value); it was ignored.',
    };
  }
  return { values, path };
}

/**
 * `env` with the file's values filling the keys the environment does not carry. A blank (whitespace-only)
 * variable counts as unset, the same rule the identity resolver applies to the version and build.
 */
export function mergeBuildPluginEnv(env: EnvRecord, file: Record<string, string>): EnvRecord {
  const merged: EnvRecord = { ...env };
  for (const [key, value] of Object.entries(file)) {
    if ((merged[key]?.trim() ?? '') === '') {
      merged[key] = value;
    }
  }
  return merged;
}
