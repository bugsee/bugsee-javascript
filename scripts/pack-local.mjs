#!/usr/bin/env node
// Pack every buildable @bugsee package into .local-registry/ as a stable-named tarball, so the
// sample applications in samples/ can install the SDK exactly the way a customer will: from a
// published artifact (dist + publishConfig exports), not from the workspace source tree.
//
// This is deliberate pre-publish verification. `packages/*` resolve `.` -> `./src/index.ts` inside
// the monorepo; only `publishConfig.exports` (applied by `pnpm pack`) points at `dist`. Installing a
// sample from a tarball is therefore the ONLY way to exercise the artifact we are about to ship:
// the exports map, the dual ESM/CJS output, and the declared runtime dependencies.
//
//   node scripts/pack-local.mjs              # build everything, then pack everything
//   node scripts/pack-local.mjs --no-build   # pack only (dist must already exist)
//   node scripts/pack-local.mjs --only @bugsee/react,@bugsee/browser
//
// Writes .local-registry/<name>.tgz plus .local-registry/overrides.json — the `pnpm.overrides` block
// every sample needs so that TRANSITIVE @bugsee deps (packed as version "0.0.0", which does not exist
// on npm) resolve to the local tarballs too.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = join(root, '.local-registry');

const argv = process.argv.slice(2);
const noBuild = argv.includes('--no-build');
const onlyArg = argv.find((a) => a.startsWith('--only'));
const only = onlyArg
  ? new Set(
      (onlyArg.includes('=') ? onlyArg.split('=')[1] : argv[argv.indexOf(onlyArg) + 1]).split(','),
    )
  : undefined;

/** Every workspace package that produces a dist — i.e. everything a sample could install. */
function packablePackages() {
  const out = [];
  for (const dir of readdirSync(join(root, 'packages'))) {
    const manifestPath = join(root, 'packages', dir, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    if (!manifest.scripts?.build) continue;
    out.push({ dir, name: manifest.name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** '@bugsee/react' -> 'bugsee-react' — a stable filename, so a sample's package.json never pins a version. */
const tarballName = (name) => `${name.replace('@', '').replace('/', '-')}.tgz`;

const packages = packablePackages().filter((p) => only === undefined || only.has(p.name));
if (packages.length === 0) {
  console.error('nothing to pack');
  process.exit(1);
}

if (!noBuild) {
  console.log('building…');
  execFileSync('pnpm', ['exec', 'turbo', 'run', 'build'], { cwd: root, stdio: 'inherit' });
}

mkdirSync(registry, { recursive: true });

for (const { dir, name } of packages) {
  const cwd = join(root, 'packages', dir);
  const target = join(registry, tarballName(name));
  rmSync(target, { force: true });
  // `pnpm pack` applies publishConfig and rewrites `workspace:*` to the concrete version, exactly as
  // `pnpm publish` would. --pack-destination keeps the versioned name, so we rename to the stable one.
  const stdout = execFileSync('pnpm', ['pack', '--pack-destination', registry], {
    cwd,
    encoding: 'utf8',
  });
  const produced = stdout.trim().split('\n').pop().trim();
  if (produced !== target) renameSync(produced, target);
  console.log(`  ${name} -> .local-registry/${tarballName(name)}`);
}

// The overrides block. Paths are relative to a sample at samples/<name>/, which is where they are used.
const all = packablePackages();
const overrides = Object.fromEntries(
  all.map(({ name }) => [name, `file:../../.local-registry/${tarballName(name)}`]),
);
writeFileSync(join(registry, 'overrides.json'), `${JSON.stringify(overrides, null, 2)}\n`);
console.log(`\n${packages.length} packed; overrides.json lists ${all.length}.`);
