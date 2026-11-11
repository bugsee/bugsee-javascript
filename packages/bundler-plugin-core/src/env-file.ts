// `.env.bugsee-build-plugin` — the file the setup wizard writes the app token to (git-ignored), the way
// Sentry's plugin reads `.env.sentry-build-plugin`. Lookup order for every BUGSEE_* setting: plugin option,
// then the process environment, then this file. The file only FILLS GAPS: a variable already set in the
// environment (even to an empty string) is never overridden, and `process.env` itself is never written to.
// Nothing here may fail a build: a missing, unreadable or malformed file is simply "no values".
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { EnvRecord } from './run-cli';

export const BUILD_PLUGIN_ENV_FILE = '.env.bugsee-build-plugin';

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

/** Parse dotenv text. Only `BUGSEE_*` keys are kept; malformed lines are skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line.trim());
    if (match?.[1]?.startsWith('BUGSEE_') && match[2] !== undefined) {
      out[match[1]] = unquote(match[2]);
    }
  }
  return out;
}

/**
 * Load the NEAREST `.env.bugsee-build-plugin` at or above `root` (the bundler's project directory; the
 * working directory when none is known). The first file found wins; an unreadable one is skipped.
 */
export function loadBuildPluginEnv(
  root: string | undefined,
  cwd: () => string = () => process.cwd(),
): Record<string, string> {
  let dir: string;
  try {
    dir = resolve(root ?? cwd());
  } catch {
    return {};
  }
  for (;;) {
    try {
      return parseEnvFile(readFileSync(join(dir, BUILD_PLUGIN_ENV_FILE), 'utf8'));
    } catch {
      // missing / a directory / unreadable: keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return {};
    }
    dir = parent;
  }
}

/** `env` with the file's values filling only the keys `env` does not have at all. */
export function mergeBuildPluginEnv(env: EnvRecord, file: Record<string, string>): EnvRecord {
  const merged: EnvRecord = { ...env };
  for (const [key, value] of Object.entries(file)) {
    if (!(key in merged)) {
      merged[key] = value;
    }
  }
  return merged;
}
