// The PUBLISHED shape of `@bugsee/nextjs/config`: packs `@bugsee/nextjs` and every workspace package it depends on
// (pnpm applies each `publishConfig`, so `exports` point at `dist`), unpacks them as an app's node_modules, and
// loads the config entry the way a real next.config does: `require()` from a CJS `next.config.js` and `import` from
// an ESM `next.config.mjs`. In the repo everything resolves to `src`, so this is the only check of the dual build.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const packages = join(repo, 'packages');
let app: string;

/** `@bugsee/*` workspace packages reachable from `name` through `dependencies`, `name` included. */
function workspaceClosure(name: string, seen = new Map<string, string>()): Map<string, string> {
  const dir = join(packages, name.replace('@bugsee/', ''));
  if (seen.has(name)) return seen;
  seen.set(name, dir);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const wanted = { ...manifest.dependencies, ...manifest.optionalDependencies };
  for (const [dep, range] of Object.entries(wanted)) {
    if (range.startsWith('workspace:')) workspaceClosure(dep, seen);
  }
  return seen;
}

beforeAll(() => {
  const closure = workspaceClosure('@bugsee/nextjs');
  const filters = [...closure.keys()].flatMap((n) => ['--filter', n]);
  execFileSync('pnpm', ['--dir', repo, ...filters, 'run', '--if-present', 'build'], {
    stdio: 'ignore',
  });
  app = mkdtempSync(join(tmpdir(), 'bugsee-packed-'));
  const modules = join(app, 'node_modules');
  mkdirSync(join(modules, '@bugsee'), { recursive: true });
  // The packed tarballs, unpacked as an app's node_modules (pnpm applies each `publishConfig`).
  for (const [name, dir] of closure) {
    const target = join(modules, name);
    mkdirSync(target, { recursive: true });
    const out = mkdtempSync(join(tmpdir(), 'bugsee-pack-'));
    execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: dir, stdio: 'ignore' });
    execFileSync('tar', [
      '-xzf',
      join(out, readdirSync(out)[0] as string),
      '-C',
      target,
      '--strip-components=1',
    ]);
    rmSync(out, { recursive: true, force: true });
  }
  // Third-party dependencies, and ONLY the ones the packed manifests DECLARE. No registry, no package store: each
  // declared dependency is linked from where the monorepo installed it (its own transitive dependencies resolve from
  // that real location). A dependency a package uses but forgot to declare is therefore missing here, exactly as it
  // would be for a user, which a monorepo-wide node_modules would hide.
  for (const [name] of closure) {
    const packed = JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const dep of Object.keys({ ...packed.dependencies, ...packed.optionalDependencies })) {
      if (closure.has(dep)) continue;
      const installed = join(closure.get(name) as string, 'node_modules', dep);
      const link = join(modules, dep);
      if (!existsSync(installed) || existsSync(link)) continue;
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(realpathSync(installed), link);
    }
  }
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app', version: '3.2.1' }));
}, 900_000);

afterAll(() => {
  if (app) rmSync(app, { recursive: true, force: true });
});

const probe = `
  const out = withBugsee({ reactStrictMode: true }, { appToken: 't', vcs: false });
  console.log(JSON.stringify({
    kind: typeof withBugsee,
    strict: out.reactStrictMode,
    maps: out.productionBrowserSourceMaps,
    version: out.compiler && out.compiler.define && out.compiler.define.__BUGSEE_APP_VERSION__,
  }));
`;
const expected = { kind: 'function', strict: true, maps: true, version: '3.2.1' };

describe('the published @bugsee/nextjs/config', () => {
  it('exports map to dist, with an import and a require build', () => {
    const manifest = JSON.parse(
      readFileSync(join(app, 'node_modules', '@bugsee', 'nextjs', 'package.json'), 'utf8'),
    ) as { exports: Record<string, { import: { default: string }; require: { default: string } }> };
    const entry = manifest.exports['./config'];
    expect(entry?.require.default).toBe('./dist/config.cjs');
    expect(entry?.import.default).toBe('./dist/config.js');
    for (const file of [entry?.require.default, entry?.import.default]) {
      expect(existsSync(join(app, 'node_modules', '@bugsee', 'nextjs', file as string))).toBe(true);
    }
  });

  it('works from a CommonJS next.config.js (require)', () => {
    const out = execFileSync(
      process.execPath,
      ['-e', `const { withBugsee } = require('@bugsee/nextjs/config');${probe}`],
      { cwd: app, encoding: 'utf8', env: { ...process.env, TURBOPACK: '' } },
    );
    expect(JSON.parse(out.trim().split('\n').pop() as string)).toEqual(expected);
  });

  it('works from an ESM next.config.mjs (import)', () => {
    writeFileSync(
      join(app, 'probe.mjs'),
      `import { withBugsee } from '@bugsee/nextjs/config';${probe}`,
    );
    const out = execFileSync(process.execPath, ['probe.mjs'], {
      cwd: app,
      encoding: 'utf8',
      env: { ...process.env, TURBOPACK: '' },
    });
    expect(JSON.parse(out.trim().split('\n').pop() as string)).toEqual(expected);
  });
});
