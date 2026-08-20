import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The packaging guard. Inside the monorepo a package's `exports` map points at `./src/*.ts`, and only
// `publishConfig` — applied by `pnpm pack`/`publish` — points at `dist`. Nothing else in the repo reads
// `publishConfig`, so a package can be fully green here and be broken, or partly missing, the moment it
// is published. That is not hypothetical: seven packages shipped with NO `publishConfig` at all (their
// tarballs resolved to uncompiled `src/`, which is not even packed), `@bugsee/electron` declared three
// subpath entries its build never emitted, and `@bugsee/protocol` dropped a subpath on publish. Every
// one of those was found by installing a sample application from a tarball, not by any test.
//
// These assertions are cheap and they are the contract: what a customer gets must exist, and must be
// reachable by the same specifier the monorepo uses.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const packagesDir = join(root, 'packages');

interface Manifest {
  name: string;
  files?: string[];
  scripts?: Record<string, string>;
  main?: string;
  module?: string;
  types?: string;
  exports?: Record<string, unknown>;
  publishConfig?: {
    main?: string;
    module?: string;
    types?: string;
    exports?: Record<string, unknown>;
  };
}

/** Every workspace package that produces a dist — i.e. everything that can be published. */
const buildable: Array<{ dir: string; manifest: Manifest }> = readdirSync(packagesDir)
  .map((dir) => ({ dir, path: join(packagesDir, dir, 'package.json') }))
  .filter(({ path }) => existsSync(path))
  .map(({ dir, path }) => ({ dir, manifest: JSON.parse(readFileSync(path, 'utf8')) as Manifest }))
  .filter(({ manifest }) => manifest.scripts?.build !== undefined)
  .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));

/** Collect every relative path a manifest fragment points at, however deeply nested the conditions are. */
function referencedPaths(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.startsWith('./')) out.push(value);
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) referencedPaths(nested, out);
  }
  return out;
}

/** Is `path` inside something `files` ships? npm always includes package.json/README/LICENSE. */
function isPacked(path: string, files: string[] | undefined): boolean {
  if (files === undefined) return true; // no allowlist: everything not ignored is packed
  const rel = path.replace(/^\.\//, '');
  return files.some((entry) => {
    const clean = entry.replace(/^\.\//, '').replace(/\/$/, '');
    return rel === clean || rel.startsWith(`${clean}/`);
  });
}

describe('every buildable package declares what it publishes', () => {
  it('finds the packages to check', () => {
    // A guard whose subject list silently emptied would pass every assertion below.
    expect(buildable.length).toBeGreaterThan(40);
  });

  it.each(
    buildable.map(({ dir, manifest }) => [manifest.name, dir] as const),
  )('%s has a publishConfig', (_name, dir) => {
    const { manifest } = buildable.find((p) => p.dir === dir) as (typeof buildable)[number];
    // Without one, the published `exports` still say `./src/index.ts` — a path `files: ["dist"]`
    // does not even pack, so the package cannot be imported at all.
    expect(
      manifest.publishConfig,
      'no publishConfig: this package would publish broken',
    ).toBeDefined();
    expect(manifest.publishConfig?.exports).toBeDefined();
  });

  it.each(
    buildable.map(({ dir, manifest }) => [manifest.name, dir] as const),
  )('%s keeps every dev entry point on publish', (_name, dir) => {
    const { manifest } = buildable.find((p) => p.dir === dir) as (typeof buildable)[number];
    const dev = Object.keys(manifest.exports ?? {});
    const published = Object.keys(manifest.publishConfig?.exports ?? {});
    // publishConfig.exports REPLACES exports wholesale, so a subpath omitted here disappears for
    // consumers even though it resolves inside the monorepo.
    expect(published.sort(), `entry points lost on publish`).toEqual(dev.sort());
  });

  it.each(
    buildable.map(({ dir, manifest }) => [manifest.name, dir] as const),
  )('%s publishes only files that exist and are packed', (_name, dir) => {
    const { manifest } = buildable.find((p) => p.dir === dir) as (typeof buildable)[number];
    const pkgRoot = join(packagesDir, dir);
    const paths = referencedPaths({
      main: manifest.publishConfig?.main,
      module: manifest.publishConfig?.module,
      types: manifest.publishConfig?.types,
      exports: manifest.publishConfig?.exports,
    });
    expect(paths.length, 'publishConfig points at nothing').toBeGreaterThan(0);
    for (const path of paths) {
      // Missing on disk means the build never emitted the entry the manifest promises.
      expect(existsSync(join(pkgRoot, path)), `${path} does not exist (run the build)`).toBe(true);
      expect(isPacked(path, manifest.files), `${path} is outside "files" — not packed`).toBe(true);
    }
  });
});

// A published package may only depend on things a customer can actually install. `@bugsee/rrweb`
// shipped a `github:bugsee/rrweb#<sha>` dependency on a private repository: pnpm 11 refuses an exotic
// dependency in a SUBdependency by default (`ERR_PNPM_EXOTIC_SUBDEP`), and even with that disabled it
// needs git access nobody outside this org has. Every browser-family package was uninstallable.
describe('published dependencies are installable', () => {
  const EXOTIC = /^(github:|git\+|git:|file:|link:|https?:)/;

  it.each([
    ['github:bugsee/rrweb#d50d8d7', true],
    ['git+ssh://git@github.com/bugsee/rrweb.git', true],
    ['git://github.com/bugsee/rrweb.git', true],
    ['file:../rrweb', true],
    ['link:../rrweb', true],
    ['https://example.com/pkg.tgz', true],
    ['^2.1.0', false],
    ['workspace:*', false], // rewritten to a real version by `pnpm pack`
    ['0.1.0', false],
    ['>=18', false],
  ])('classifies %s as exotic=%s', (range, exotic) => {
    // The rule itself, asserted directly: a manifest carrying an exotic range cannot even be
    // installed, so mutating one to prove this check works fails at install time instead of here.
    expect(EXOTIC.test(range)).toBe(exotic);
  });

  it.each(
    buildable.map(({ dir, manifest }) => [manifest.name, dir] as const),
  )('%s declares only registry dependencies', (_name, dir) => {
    const { manifest } = buildable.find((p) => p.dir === dir) as (typeof buildable)[number];
    const runtime = {
      ...(manifest as { dependencies?: Record<string, string> }).dependencies,
      ...(manifest as { peerDependencies?: Record<string, string> }).peerDependencies,
    };
    const exotic = Object.entries(runtime).filter(([, range]) => EXOTIC.test(range));
    expect(exotic, 'a consumer cannot install these').toEqual([]);
  });
});
