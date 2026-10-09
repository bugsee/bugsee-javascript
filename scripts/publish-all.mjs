#!/usr/bin/env node
// Publish every publishable @bugsee package, dependencies first, skipping versions already on npm.
//
//   node scripts/publish-all.mjs --dry-run              # pack + `npm publish --dry-run`, publishes nothing
//   node scripts/publish-all.mjs                        # publish (tag: latest)
//   node scripts/publish-all.mjs --tag beta             # publish under a dist-tag
//   node scripts/publish-all.mjs --only @bugsee/core    # a subset (comma-separated)
//
// Auth is whatever `npm publish` finds: in CI that is the OIDC trusted-publisher exchange (no token);
// for the one-time bootstrap run it is NODE_AUTH_TOKEN / ~/.npmrc.
//
// Why pack-then-publish: `pnpm pack` rewrites `workspace:*` to real versions and applies
// `publishConfig` (exports -> dist), which `npm publish` run in the package directory would not.
// Publishing the resulting tarball with npm keeps the OIDC path on npm itself (>= 11.5.1).
//
// It is idempotent: a re-run after a partial failure skips what is already published, so it can be
// repeated until the whole set is up. It stops at the first failure so a broken package never lets its
// dependents publish against it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPackages } from './check-publishable.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const dryRun = flag('--dry-run');
const tag = value('--tag') ?? 'latest';
const only = value('--only')?.split(',');

const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });

/** Dependencies before dependents, so a package never publishes ahead of what it needs. */
export function topologicalOrder(packages) {
  const byName = new Map(packages.map((p) => [p.json.name, p]));
  const ordered = [];
  const state = new Map();
  const visit = (pkg) => {
    const seen = state.get(pkg.json.name);
    if (seen === 'done') return;
    if (seen === 'visiting') throw new Error(`dependency cycle through ${pkg.json.name}`);
    state.set(pkg.json.name, 'visiting');
    const deps = {
      ...pkg.json.dependencies,
      ...pkg.json.optionalDependencies,
      ...pkg.json.peerDependencies,
    };
    for (const name of Object.keys(deps).sort()) if (byName.has(name)) visit(byName.get(name));
    state.set(pkg.json.name, 'done');
    ordered.push(pkg);
  };
  for (const pkg of [...packages].sort((a, b) => a.json.name.localeCompare(b.json.name)))
    visit(pkg);
  return ordered;
}

const published = (name, version) => {
  try {
    return run('npm', ['view', `${name}@${version}`, 'version']).trim() === version;
  } catch {
    return false; // E404: never published
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const packages = topologicalOrder(loadPackages()).filter(
    (p) => !only || only.includes(p.json.name),
  );
  const out = mkdtempSync(join(tmpdir(), 'bugsee-publish-'));
  let done = 0;
  let skipped = 0;

  for (const { dir, json } of packages) {
    const { name, version } = json;
    if (!dryRun && published(name, version)) {
      console.log(`skip     ${name}@${version} (already on npm)`);
      skipped++;
      continue;
    }
    const cwd = join(root, 'packages', dir);
    if (!readdirSync(cwd).includes('dist'))
      throw new Error(`${name}: no dist/ — run \`pnpm build\` first`);
    run('pnpm', ['pack', '--pack-destination', out], { cwd });
    const tarball = join(out, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`);
    const args = ['publish', tarball, '--tag', tag, '--access', 'public'];
    if (dryRun) args.push('--dry-run');
    console.log(`${dryRun ? 'dry-run ' : 'publish '} ${name}@${version} (tag ${tag})`);
    run('npm', args, { stdio: 'inherit' });
    done++;
  }
  console.log(
    `\n${done} ${dryRun ? 'checked' : 'published'}, ${skipped} skipped, of ${packages.length}.`,
  );
}
