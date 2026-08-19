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
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

const result = spawnSync(
  'pnpm',
  ['exec', 'stryker', 'run', resolve(root, 'stryker.config.json'), ...process.argv.slice(3)],
  { cwd, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
