import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The SDK reports its own version to the collector, which enforces a minimum. That version is a
// hardcoded constant in each platform's launch, NOT read from package.json — so the two drift
// silently. They had: every package sat at `0.0.0`, below the collector's `0.1.0` floor, and every
// session was rejected with `UnsupportedSdkError`. Nothing failed; the SDK simply never delivered.
//
// These constants are the thing a customer's data depends on, so they are pinned to the package
// version here rather than left to be noticed.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Where each platform hardcodes the version it reports (and, for core, keys the carrier registry). */
const VERSION_CONSTANTS: ReadonlyArray<{ file: string; pkg: string }> = [
  { file: 'packages/browser/src/launch.ts', pkg: 'packages/browser/package.json' },
  { file: 'packages/core/src/carrier.ts', pkg: 'packages/core/package.json' },
  { file: 'packages/node/src/launch.ts', pkg: 'packages/node/package.json' },
  { file: 'packages/vercel-edge/src/launch.ts', pkg: 'packages/vercel-edge/package.json' },
  { file: 'packages/webview/src/launch.ts', pkg: 'packages/webview/package.json' },
  { file: 'packages/webworker/src/launch.ts', pkg: 'packages/webworker/package.json' },
];

/** The collector rejects anything below this (appserver `cfg.core.sdk.javascript.<family>.minimum`). */
const COLLECTOR_MINIMUM = [0, 1, 0];

const parse = (v: string): number[] => v.split('.').map(Number);
const gte = (a: number[], b: number[]): boolean =>
  a[0] !== b[0]
    ? (a[0] as number) > (b[0] as number)
    : a[1] !== b[1]
      ? (a[1] as number) > (b[1] as number)
      : (a[2] as number) >= (b[2] as number);

describe('the version the SDK reports to the collector', () => {
  it.each(VERSION_CONSTANTS)('$file matches its package version', ({ file, pkg }) => {
    const source = readFileSync(join(root, file), 'utf8');
    const version = (JSON.parse(readFileSync(join(root, pkg), 'utf8')) as { version: string })
      .version;
    const match = /SDK_VERSION\s*=\s*'([^']+)'/.exec(source);
    expect(match, `no SDK_VERSION constant in ${file}`).not.toBeNull();
    expect(match?.[1], `${file} reports a version its package does not declare`).toBe(version);
  });

  it.each(VERSION_CONSTANTS)('$pkg is at or above the collector floor', ({ pkg }) => {
    const version = (JSON.parse(readFileSync(join(root, pkg), 'utf8')) as { version: string })
      .version;
    expect(
      gte(parse(version), COLLECTOR_MINIMUM),
      `${version} is below the collector minimum ${COLLECTOR_MINIMUM.join('.')} — every session would be rejected with UnsupportedSdkError`,
    ).toBe(true);
  });

  it('every package carries the same version', () => {
    // Independent versions are legitimate for some monorepos, but these packages depend on each
    // other by exact version once packed; a split would make a published set unresolvable.
    const versions = new Map<string, string>();
    for (const { pkg } of VERSION_CONSTANTS) {
      const j = JSON.parse(readFileSync(join(root, pkg), 'utf8')) as {
        name: string;
        version: string;
      };
      versions.set(j.name, j.version);
    }
    expect(existsSync(join(root, 'packages'))).toBe(true);
    expect(new Set(versions.values()).size, `mixed versions: ${[...versions].join(', ')}`).toBe(1);
  });
});
