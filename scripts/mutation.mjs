#!/usr/bin/env node
// Run Stryker mutation testing against ONE workspace package.
//
//   pnpm test:mutation util
//   pnpm test:mutation capture
//
// Why a script rather than a per-package config: the vitest runner plugin lives only in the workspace
// ROOT node_modules (pnpm keeps package installs isolated), and Stryker resolves both plugins and the
// `mutate` globs relative to the working directory. Running from the package directory with the shared
// root config gives correct globs; the config's `plugins` entry reaches back up to the root install.
//
// Deliberately not wired into `pnpm test` or CI. A full mutation run costs minutes per package, and the
// binding discipline is the per-entity mutator loop at authoring time. This is the periodic audit.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = process.argv[2];

if (!pkg) {
  console.error('usage: pnpm test:mutation <package-dir>   (e.g. `pnpm test:mutation util`)');
  process.exit(1);
}

const cwd = resolve(root, 'packages', pkg);
if (!existsSync(cwd)) {
  console.error(`no such package directory: packages/${pkg}`);
  process.exit(1);
}

// The shared config excludes `src/index.ts`, because in almost every package here it is a pure re-export
// barrel and mutating it only adds noise. In a few it is the ENTIRE implementation — @bugsee/babel-plugin-
// component-annotate is one file — and there the exclusion leaves Stryker with nothing to mutate, which it
// reports as an opaque crash rather than "no files matched". Those packages were silently un-auditable by
// the documented command. Detect the case and keep index.ts in the set.
function sourceFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFilesUnder(full));
    else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test-d.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

const srcDir = join(cwd, 'src');
const mutable = existsSync(srcDir)
  ? sourceFilesUnder(srcDir).filter((f) => f !== join(srcDir, 'index.ts'))
  : [];
const extraArgs = [];
if (mutable.length === 0) {
  console.log(
    `[mutation] packages/${pkg} has no source outside src/index.ts — mutating index.ts as well.`,
  );
  extraArgs.push('--mutate', 'src/**/*.ts,!src/**/*.test.ts,!src/**/*.test-d.ts,!src/**/*.d.ts');
}

const result = spawnSync(
  'pnpm',
  [
    'exec',
    'stryker',
    'run',
    resolve(root, 'stryker.config.json'),
    ...extraArgs,
    ...process.argv.slice(3),
  ],
  { cwd, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
