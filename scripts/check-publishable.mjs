#!/usr/bin/env node
// Release gate: every publishable package is public, carries the metadata npm needs, and ships ONE
// version — the one the SDK reports about itself (BUGSEE_SDK_VERSION in core/src/carrier.ts).
//
// Why a script and not a unit test: the invariant spans every package.json in the workspace, and the
// reported version is also the key of the process-global carrier slot, so a drift between the two is
// silent (bundles claim 0.1.0 while the tarball says 0.1.0-beta.2) until the backend rejects it.
//
//   node scripts/check-publishable.mjs          # exits 1 and lists every violation
//   node scripts/check-publishable.mjs --list   # print the publishable package names, one per line
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'git+https://github.com/bugsee/bugsee-javascript.git';

// Test harnesses and sample fixtures are never published.
const isTestOnly = (name) => /(^|\/)(e2e-kit|instrumentation-tests)$|-e2e$/.test(name);

export function loadPackages() {
  return readdirSync(join(root, 'packages'))
    .map((dir) => ({
      dir,
      json: JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')),
    }))
    .filter(({ json }) => !isTestOnly(json.name));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const packages = loadPackages();
  if (process.argv.includes('--list')) {
    for (const { json } of packages) console.log(json.name);
    process.exit(0);
  }

  const carrier = readFileSync(join(root, 'packages/core/src/carrier.ts'), 'utf8');
  const sdkVersion = /BUGSEE_SDK_VERSION = '([^']+)'/.exec(carrier)?.[1];
  const errors = [];
  if (!sdkVersion) errors.push('core/src/carrier.ts: BUGSEE_SDK_VERSION not found');

  for (const { dir, json } of packages) {
    const where = `${json.name} (packages/${dir})`;
    if (json.private) errors.push(`${where}: still private`);
    if (json.version !== sdkVersion)
      errors.push(`${where}: version ${json.version} != SDK version ${sdkVersion}`);
    if (json.publishConfig?.access !== 'public')
      errors.push(`${where}: publishConfig.access must be "public"`);
    if (json.repository?.url !== REPO_URL)
      errors.push(`${where}: repository.url must be ${REPO_URL}`);
    if (json.repository?.directory !== `packages/${dir}`)
      errors.push(`${where}: repository.directory must be packages/${dir}`);
    for (const [dep, range] of Object.entries({
      ...json.dependencies,
      ...json.optionalDependencies,
    })) {
      if (/^(github:|git\+|git:|file:|link:|https?:)/.test(range))
        errors.push(`${where}: ${dep} is a non-registry dependency (${range})`);
    }
  }

  // A second hardcoded copy of the version is exactly the drift this gate exists to stop.
  for (const { dir } of packages) {
    for (const file of ['launch.ts']) {
      let src;
      try {
        src = readFileSync(join(root, 'packages', dir, 'src', file), 'utf8');
      } catch {
        continue;
      }
      if (/SDK_VERSION = '\d/.test(src))
        errors.push(`packages/${dir}/src/${file}: hardcoded SDK_VERSION literal`);
    }
  }

  if (errors.length) {
    console.error(errors.join('\n'));
    console.error(`\n${errors.length} problem(s).`);
    process.exit(1);
  }
  console.log(`${packages.length} publishable packages, all at ${sdkVersion}.`);
}
