import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The SDK reports its own version to the collector, which enforces a minimum. That version is ONE
// constant — BUGSEE_SDK_VERSION in core/src/carrier.ts — not read from package.json, so the two can
// drift silently. They had: every package sat at `0.0.0`, below the collector's `0.1.0` floor, and
// every session was rejected with `UnsupportedSdkError`. Nothing failed; the SDK simply never
// delivered.
//
// The constant is the thing a customer's data depends on, so it is pinned to every package version
// here rather than left to be noticed. (scripts/check-publishable.mjs enforces the same invariant
// at release time; this keeps it inside `pnpm test`.)

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const versionOf = (pkg: string): string => (JSON.parse(read(pkg)) as { version: string }).version;

/** The platform entry points that report a version; each must take it from core, never hardcode it. */
const LAUNCH_FILES = [
  'packages/browser/src/launch.ts',
  'packages/node/src/launch.ts',
  'packages/vercel-edge/src/launch.ts',
  'packages/webview/src/launch.ts',
  'packages/webworker/src/launch.ts',
];

const PACKAGES = [
  'packages/browser/package.json',
  'packages/core/package.json',
  'packages/node/package.json',
  'packages/vercel-edge/package.json',
  'packages/webview/package.json',
  'packages/webworker/package.json',
];

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const reportedVersion = (): string => {
  const match = /BUGSEE_SDK_VERSION\s*=\s*'([^']+)'/.exec(read('packages/core/src/carrier.ts'));
  expect(match, 'no BUGSEE_SDK_VERSION constant in packages/core/src/carrier.ts').not.toBeNull();
  return match?.[1] as string;
};

describe('the version the SDK reports to the collector', () => {
  it.each(PACKAGES)('%s declares the version the SDK reports', (pkg) => {
    expect(versionOf(pkg), `${pkg} declares a version the SDK does not report`).toBe(
      reportedVersion(),
    );
  });

  it.each(LAUNCH_FILES)('%s takes its version from core instead of hardcoding one', (file) => {
    const source = read(file);
    expect(source, `${file} must import BUGSEE_SDK_VERSION from @bugsee/core`).toMatch(
      /\bBUGSEE_SDK_VERSION\b/,
    );
    expect(source, `${file} hardcodes a version literal — a second copy to drift`).not.toMatch(
      /SDK_VERSION\s*=\s*'\d/,
    );
  });

  it('is a valid semver the collector can compare (a prerelease is allowed)', () => {
    // The appserver floor is `0.0.0-0` (the lowest semver), precisely so that `0.1.0-beta.N`
    // sessions are admitted. A version that is not semver at all would fail `semver.gt` and be
    // rejected as unsupported.
    expect(reportedVersion()).toMatch(SEMVER);
  });

  it('every package carries the same version', () => {
    // Independent versions are legitimate for some monorepos, but these packages depend on each
    // other by exact version once packed; a split would make a published set unresolvable.
    const versions = new Map<string, string>();
    for (const pkg of PACKAGES) {
      const j = JSON.parse(read(pkg)) as { name: string; version: string };
      versions.set(j.name, j.version);
    }
    expect(existsSync(join(root, 'packages'))).toBe(true);
    expect(new Set(versions.values()).size, `mixed versions: ${[...versions].join(', ')}`).toBe(1);
  });
});
