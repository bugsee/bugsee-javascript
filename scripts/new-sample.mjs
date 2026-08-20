#!/usr/bin/env node
// Scaffold a sample application under samples/<name>/ with the SHARED harness every sample needs:
// the pnpm overrides that pin every @bugsee/* dependency to a local pre-publish tarball, the .env
// convention for the staging app token, and the FINDINGS.md the sample records SDK defects in.
//
//   node scripts/new-sample.mjs react-spa "@bugsee/react"
//
// Run `node scripts/pack-local.mjs` first — the overrides point at .local-registry/*.tgz.
// It is deliberately minimal: it does NOT choose a framework, a bundler or a file layout. The sample
// author builds a real application on top; this only guarantees the SDK is consumed the way a
// customer will consume it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [name, ...packages] = process.argv.slice(2);
if (!name) {
  console.error('usage: node scripts/new-sample.mjs <sample-name> [<package-under-test> …]');
  process.exit(2);
}

const overridesPath = join(root, '.local-registry', 'overrides.json');
if (!existsSync(overridesPath)) {
  console.error('missing .local-registry/overrides.json — run `node scripts/pack-local.mjs` first');
  process.exit(1);
}
const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));

const dir = join(root, 'samples', name);
if (existsSync(dir)) {
  console.error(`samples/${name} already exists`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

// pnpm 11 reads `overrides` from pnpm-workspace.yaml, not package.json. A nested pnpm-workspace.yaml
// also makes the sample its OWN workspace root — its lockfile and node_modules are independent of the
// monorepo's, so parallel sample work never contends on the root lockfile.
const yaml = [
  `# This file makes samples/${name} a standalone pnpm project and pins every @bugsee/*`,
  '# dependency — including transitive ones — to the local pre-publish tarball produced by',
  '# `node scripts/pack-local.mjs`. That is what makes this sample a real pre-publish test: it',
  '# installs dist/ through the published `exports` map, exactly as a customer will.',
  '#',
  '# Re-run `node scripts/pack-local.mjs` after ANY change to packages/, then `pnpm install` here.',
  'overrides:',
  ...Object.entries(overrides).map(([k, v]) => `  '${k}': '${v}'`),
  '',
  '# @bugsee/rrweb depends on a git dependency (@bugsee/rrweb-record) which pnpm 11 blocks in',
  '# subdependencies by default. See samples/FINDINGS.md — this is a publish blocker, not a sample bug.',
  'blockExoticSubdeps: false',
  '',
].join('\n');
writeFileSync(join(dir, 'pnpm-workspace.yaml'), yaml);

const deps = Object.fromEntries(
  packages.map((p) => {
    if (overrides[p] === undefined) {
      console.error(`unknown package: ${p}`);
      process.exit(1);
    }
    return [p, overrides[p]];
  }),
);
writeFileSync(
  join(dir, 'package.json'),
  `${JSON.stringify({ name: `@bugsee-samples/${name}`, private: true, type: 'module', scripts: {}, dependencies: deps }, null, 2)}\n`,
);

writeFileSync(
  join(dir, '.env.example'),
  [
    '# Create the app with the Bugsee staging MCP (create_application) and paste its app_token here,',
    '# then `cp .env.example .env`. Never commit .env.',
    'BUGSEE_APP_TOKEN=',
    '# The staging collector. Production is https://api.bugsee.com.',
    'BUGSEE_ENDPOINT=https://apidev.bugsee.com',
    '',
  ].join('\n'),
);
writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.env\ndist/\n');

writeFileSync(
  join(dir, 'FINDINGS.md'),
  [
    `# Findings — samples/${name}`,
    '',
    'Every SDK defect, data-arrival failure or data inconsistency observed while building and running',
    'this sample. One entry per finding. Do NOT fix SDK code here — record it.',
    '',
    'Severity: **blocker** (SDK unusable / data lost) · **major** (feature broken or wrong data) ·',
    '**minor** (cosmetic, docs, ergonomics).',
    '',
    '## Open',
    '',
    '<!--',
    '### F-1 · <one-line summary>',
    '- **Severity:** major',
    '- **Package:** @bugsee/x (`packages/x/src/y.ts:NN`)',
    '- **Scenario:** S7 — network capture, POST with a JSON body',
    '- **Expected:** the request body appears in the uploaded bundle',
    '- **Observed:** the body is absent; MCP `get_issue` shows no network entry',
    '- **Reproduce:** `pnpm dev`, click "POST order", then …',
    '- **Evidence:** issue `SAMPLE-12`, captured at 2026-08-20T10:00Z',
    '-->',
    '',
    '## Resolved',
    '',
  ].join('\n'),
);

console.log(`scaffolded samples/${name}`);
console.log(`  packages under test: ${packages.join(', ') || '(none specified)'}`);
console.log(`  next: cd samples/${name} && pnpm install`);
