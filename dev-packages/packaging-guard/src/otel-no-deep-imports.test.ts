import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// OpenTelemetry JS 3.0 ships an `exports` map on every package, so `@opentelemetry/<pkg>/build/...` deep
// imports and `@opentelemetry/<pkg>/package.json` reads stopped resolving (issue #94, upstream #6293), and
// the `browser` field became `#platform` subpath imports. Nothing in this SDK may reach into an OTel
// package's internals: the only specifiers we may write are a package's public entry points. This scans
// every tracked source/config file so a new deep import fails here, in the unit gate, not in a customer's
// bundler.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Public subpaths an OTel package documents in its `exports` map (api 1.10 ships `./experimental`). */
const PUBLIC_SUBPATHS = new Set(['@opentelemetry/api/experimental']);

// Built from pieces so this file's own text never matches itself.
const SPECIFIER = new RegExp(`@${'opentelemetry'}/[a-z0-9-]+/[A-Za-z0-9_.@/-]+`, 'g');
const NODE_MODULES_PATH = new RegExp(`node_modules/@${'opentelemetry'}`);

/** Every `@opentelemetry/<pkg>/<subpath>` specifier (and any node_modules path into OTel) in `text`. */
export function findOtelDeepImports(text: string): string[] {
  const found = (text.match(SPECIFIER) ?? []).filter((specifier) => {
    const parts = specifier.split('/');
    return !PUBLIC_SUBPATHS.has(parts.slice(0, 3).join('/')) || parts.length > 3;
  });
  if (NODE_MODULES_PATH.test(text)) found.push('node_modules/@opentelemetry path');
  return found;
}

describe('findOtelDeepImports', () => {
  it.each([
    "import x from '@opentelemetry/sdk-trace-base/build/src/Span';",
    "require('@opentelemetry/core/build/esm/index.js')",
    "require.resolve('@opentelemetry/api/package.json')",
    'import("@opentelemetry/sdk-trace/dist/index.mjs")',
    "readFileSync('node_modules/@opentelemetry/api/package.json')",
    "join(here, '../node_modules/@opentelemetry/api')",
    "import y from '@opentelemetry/api/experimental/extra';",
  ])('flags %s', (source) => {
    expect(findOtelDeepImports(source).length).toBeGreaterThan(0);
  });

  it.each([
    "import { trace } from '@opentelemetry/api';",
    "import('@opentelemetry/sdk-trace-base')",
    "import('@opentelemetry/sdk-trace')",
    "import { x } from '@opentelemetry/api/experimental';",
    "import z from '@bugsee/opentelemetry';",
    'plain text about OpenTelemetry',
  ])('allows %s', (source) => {
    expect(findOtelDeepImports(source)).toEqual([]);
  });
});

const SCANNED = /\.(?:[cm]?[jt]sx?|json|vue|svelte|astro)$/;

/** Tracked and untracked-but-not-ignored files, so a new file is checked before it is committed. */
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter((file) => file !== '' && SCANNED.test(file))
  // This file's own fixtures are deliberate deep imports.
  .filter((file) => !file.endsWith('otel-no-deep-imports.test.ts'));

describe('no package reaches into OpenTelemetry internals', () => {
  it('scans a meaningful set of files', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('packages/opentelemetry/src/span-processor.ts');
    expect(files).toContain('packages/nextjs/src/otel-provider.ts');
  });

  it('finds no deep import, package.json read or node_modules path into @opentelemetry/*', () => {
    const offenders: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(join(root, file), 'utf8');
      } catch {
        continue; // deleted in the working tree but still indexed
      }
      for (const hit of findOtelDeepImports(text)) offenders.push(`${relative('.', file)}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });
});
