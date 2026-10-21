import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OpenTelemetry JS 3.0 (2026-10-20) REMOVED `@opentelemetry/sdk-trace-base` / `-web` / `-node` and replaced
// them with one `@opentelemetry/sdk-trace` (issue #94). A package that still lists only `sdk-trace-base`
// as its OTel SDK peer points OTel 3 users at a package that no longer exists on 3.x. Every package that
// names the SDK as an optional peer must name BOTH, split by OTel major, and keep both optional (a
// produce-only user installs neither).

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface Manifest {
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

const read = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')) as Manifest;

describe.each([
  'opentelemetry',
  'nextjs',
])('@bugsee/%s declares the OTel SDK peers by major', (dir) => {
  const manifest = read(dir);

  it('sdk-trace-base covers OTel 1.x/2.x only (it has no 3.x release)', () => {
    expect(manifest.peerDependencies?.['@opentelemetry/sdk-trace-base']).toBe('>=1.0.0 <3');
  });

  it('sdk-trace covers 2.9+ (a hard dependency of sdk-trace-base 2.9+) and 3.x', () => {
    expect(manifest.peerDependencies?.['@opentelemetry/sdk-trace']).toBe('>=2.9.0');
  });

  it('keeps every OTel peer optional', () => {
    for (const name of [
      '@opentelemetry/api',
      '@opentelemetry/sdk-trace-base',
      '@opentelemetry/sdk-trace',
    ]) {
      expect(manifest.peerDependenciesMeta?.[name]?.optional, name).toBe(true);
    }
  });
});
