#!/usr/bin/env node
// Attach the GitHub Actions trusted publisher (OIDC) to every publishable package, in one go.
//
//   node scripts/npm-trust-all.mjs --dry-run     # show what would be configured
//   node scripts/npm-trust-all.mjs               # configure all (skips packages already trusted)
//
// Needs `npm login` as an owner of the @bugsee scope (npm >= 11.10 for `npm trust`) and every package
// to exist on the registry already — a trusted publisher can only be attached to a published package.
// npm may ask for a 2FA code per call; pass `--otp <code>` to reuse a fresh one, or run it with an
// auth session that skips it.
import { execFileSync } from 'node:child_process';
import { loadPackages } from './check-publishable.mjs';

const REPO = 'bugsee/bugsee-javascript';
const WORKFLOW = 'release.yml';
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const otpIndex = argv.indexOf('--otp');
const otp = otpIndex === -1 ? undefined : argv[otpIndex + 1];

const npm = (args) =>
  execFileSync('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let configured = 0;
let skipped = 0;
const failures = [];

for (const { json } of loadPackages()) {
  const name = json.name;
  try {
    const existing = npm(['trust', 'list', name, '--json']);
    if (existing.includes(WORKFLOW)) {
      console.log(`skip     ${name} (already trusts ${WORKFLOW})`);
      skipped++;
      continue;
    }
  } catch {
    // no relationship yet (or list unsupported for this package) — fall through and try to create it
  }
  const args = ['trust', 'github', name, '--file', WORKFLOW, '--repo', REPO, '--yes'];
  if (dryRun) args.push('--dry-run');
  if (otp) args.push('--otp', otp);
  try {
    npm(args);
    console.log(`${dryRun ? 'dry-run ' : 'trusted '} ${name}`);
    configured++;
  } catch (error) {
    failures.push(name);
    console.error(
      `FAILED   ${name}: ${
        String(error.stderr ?? error.message)
          .split('\n')
          .find((l) => l.includes('npm error')) ?? error.message
      }`,
    );
  }
}
console.log(`\n${configured} configured, ${skipped} skipped, ${failures.length} failed.`);
process.exit(failures.length ? 1 : 0);
