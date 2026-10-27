#!/usr/bin/env node
// Refreshes (or checks) the vendored snapshot of the JavaScript platform spec's trace/event tables.
//
//   pnpm spec:refresh [--specs <checkout>] [--ref <git ref>]   rewrite the snapshot from a bugsee/specs checkout
//   pnpm spec:check   [--specs <checkout>] [--ref <git ref>]   exit 1 when the snapshot is not what that ref produces
//   --out <file>      read/write that file instead of the vendored snapshot (the tests use it)
//
// The checkout is only READ, through `git show <ref>:<path>`, so its working tree and branch are irrelevant (and it may
// be on any branch). Default ref `origin/main`; run `git fetch` in the checkout first to pick up the latest spec.
// Default checkout: $BUGSEE_SPECS, else `../specs`, else `../../specs` (a sibling of this repo or of its worktree dir).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec } from './parse.mjs';

export const SPEC_REPO = 'bugsee/specs';
export const SPEC_PATH = 'sdk/reporting/platforms/javascript.md';
export const SNAPSHOT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../packages/protocol/spec/javascript-system-traces.snapshot.json',
);

/** The snapshot object for a spec markdown at a commit. */
export function buildSnapshot(markdown, source) {
  return { source: { repo: SPEC_REPO, path: SPEC_PATH, ...source }, ...parseSpec(markdown) };
}

export const serialize = (snapshot) => `${JSON.stringify(snapshot, null, 2)}\n`;

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
}

export function parseArgs(argv) {
  const out = { check: false, ref: 'origin/main', specs: undefined, out: SNAPSHOT_PATH };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') out.check = true;
    else if (argv[i] === '--specs') out.specs = argv[++i];
    else if (argv[i] === '--ref') out.ref = argv[++i];
    else if (argv[i] === '--out') out.out = resolve(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return out;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** The checkout to read: `--specs`, else `$BUGSEE_SPECS`, else a sibling of this repo or of its worktree directory. */
export function findSpecs(
  explicit,
  {
    env = process.env,
    roots = [resolve(HERE, '../../../specs'), resolve(HERE, '../../../../specs')],
    exists = existsSync,
  } = {},
) {
  const isCheckout = (dir) => exists(resolve(dir, '.git'));
  if (explicit !== undefined && !isCheckout(explicit)) {
    throw new Error(`--specs ${explicit} is not a git checkout`); // never fall back past an explicit choice
  }
  const candidates = [explicit, env.BUGSEE_SPECS, ...roots];
  // an empty value (`BUGSEE_SPECS=`) is "unset": resolving '' would silently pick the current directory
  const found = candidates.find((c) => c !== undefined && c !== '' && isCheckout(c));
  if (found === undefined) {
    throw new Error('no bugsee/specs checkout found: pass --specs <dir> or set BUGSEE_SPECS');
  }
  return resolve(found);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const specs = findSpecs(args.specs);
  const commit = git(specs, ['rev-parse', `${args.ref}^{commit}`]).trim();
  const markdown = git(specs, ['show', `${commit}:${SPEC_PATH}`]);
  const committed = git(specs, ['show', '-s', '--format=%cI', commit]).trim();
  const text = serialize(buildSnapshot(markdown, { commit, committed }));
  if (args.check) {
    if (existsSync(args.out) ? readFileSync(args.out, 'utf8') !== text : true) {
      console.error(
        `snapshot is out of date against ${SPEC_REPO}@${commit.slice(0, 12)}; run pnpm spec:refresh`,
      );
      process.exit(1);
    }
    console.log(`snapshot matches ${SPEC_REPO}@${commit.slice(0, 12)}`);
    return;
  }
  // through a temporary file in the same directory: a stop mid-write must not leave a truncated snapshot behind
  const tmp = `${args.out}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, args.out);
  console.log(`wrote ${args.out} from ${SPEC_REPO}@${commit.slice(0, 12)}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main();
