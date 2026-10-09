#!/usr/bin/env node
// Set the one SDK version everywhere it lives: BUGSEE_SDK_VERSION (what the SDK reports about itself and
// the carrier slot key) and every publishable package.json. scripts/check-publishable.mjs fails CI if
// the two ever disagree, so this is the only way a version should change.
//
//   node scripts/bump-version.mjs 0.1.0-beta.2
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPackages } from './check-publishable.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: node scripts/bump-version.mjs <semver>   e.g. 0.1.0-beta.2');
  process.exit(2);
}

const carrierPath = join(root, 'packages/core/src/carrier.ts');
const carrier = readFileSync(carrierPath, 'utf8');
if (!/BUGSEE_SDK_VERSION = '[^']+'/.test(carrier)) throw new Error('BUGSEE_SDK_VERSION not found');
writeFileSync(
  carrierPath,
  carrier.replace(/BUGSEE_SDK_VERSION = '[^']+'/, `BUGSEE_SDK_VERSION = '${version}'`),
);

for (const { dir } of loadPackages()) {
  const path = join(root, 'packages', dir, 'package.json');
  const text = readFileSync(path, 'utf8');
  // Replace the first top-level "version" only, leaving the file's formatting untouched.
  writeFileSync(path, text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
}
console.log(`set ${loadPackages().length} packages and BUGSEE_SDK_VERSION to ${version}`);
