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
import { createInterface } from 'node:readline/promises';
import { loadPackages } from './check-publishable.mjs';

const REPO = 'bugsee/bugsee-javascript';
const WORKFLOW = 'release.yml';
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const otpIndex = argv.indexOf('--otp');
let otp = otpIndex === -1 ? undefined : argv[otpIndex + 1];

// The code goes in through the environment: `npm trust` parses its own flags strictly and rejects
// `--otp <code>` ("Unknown positional argument"), while npm_config_otp is read like any other config.
const npm = (args) =>
  execFileSync('npm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: otp ? { ...process.env, npm_config_otp: otp } : process.env,
  });

/** Ask for a fresh 2FA code. A TOTP code lives ~30s, so it is reused until npm says it expired. */
async function askOtp() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question('npm 2FA code: ')).trim();
  } finally {
    rl.close();
  }
}

const isOtpError = (error) => /EOTP|one-time password/i.test(String(error.stderr ?? error.message));

let consecutiveFailures = 0;
let configured = 0;
let skipped = 0;
const failures = [];

packages: for (const { json } of loadPackages()) {
  const name = json.name;
  const args = ['trust', 'github', name, '--file', WORKFLOW, '--repo', REPO, '--yes'];
  if (dryRun) args.push('--dry-run');
  let attempts = 0;
  for (;;) {
    try {
      npm(args);
      console.log(`${dryRun ? 'dry-run ' : 'trusted '} ${name}`);
      configured++;
      consecutiveFailures = 0;
      break;
    } catch (error) {
      // A missing or expired code: ask once more and retry this package (max 3 asks per package).
      if (isOtpError(error) && process.stdin.isTTY && attempts++ < 3) {
        otp = await askOtp();
        continue;
      }
      if (/already|exists|conflict|409/i.test(String(error.stderr ?? ''))) {
        console.log(`skip     ${name} (a trusted publisher is already configured)`);
        skipped++;
        break;
      }
      failures.push(name);
      consecutiveFailures++;
      if (consecutiveFailures >= 3) break packages;
      const line = String(error.stderr ?? error.message)
        .split('\n')
        .find((l) => l.includes('npm error'));
      console.error(`FAILED   ${name}: ${line ?? error.message}`);
      break;
    }
  }
}
if (consecutiveFailures >= 3)
  console.error('\nStopping: 3 failures in a row means something systemic, not one package.');
console.log(`\n${configured} configured, ${skipped} skipped, ${failures.length} failed.`);
process.exit(failures.length ? 1 : 0);
