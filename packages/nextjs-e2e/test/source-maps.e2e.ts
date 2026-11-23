// `withBugsee` against REAL `next build`s, for both bundlers and both Next generations that matter:
//
//   next 15.5 + webpack (its default)      next 15.5 + `--turbopack`
//   next 16.4 + Turbopack (its default)    next 16.4 + `--webpack`
//
// Each builds a tiny app (a client page with a lazy chunk, a node route, an edge route) through the REAL
// `@bugsee/nextjs/config`, the REAL `bugsee-cli` and a mock collector, then asserts the outcome on disk and on the
// wire: the bundles are stamped, the maps reached the collector keyed by those exact debug-IDs, the public maps are
// gone, the server maps are kept, the version is baked into the bundle, and the build still RUNS (`next start`).
//
// Plus the Subresource-Integrity cases: webpack stamps inside the build so the hashes stay right; Turbopack hashes
// before its post-build hook, so the build is left unmodified and says so.
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..');
const fixturesRoot = join(pkgDir, '.fixtures');
const require_ = createRequire(import.meta.url);
const tsxLoader = join(dirname(require_.resolve('tsx/package.json')), 'dist', 'loader.mjs');

let server: Server;
let browser: Browser;
let endpoint: string;
const bodies: string[] = [];

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  rmSync(fixturesRoot, { recursive: true, force: true });
  mkdirSync(fixturesRoot, { recursive: true });
  // Every upload is answered "already have it", so it succeeds without a backend; the body is kept, so a test
  // can look for the exact debug-IDs that were sent.
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('latin1'));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ ok: false, error: { type: 'DuplicateSymbolsFoundError', code: 16004 } }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
  // BUGSEE_E2E_KEEP=1 leaves the built fixtures behind for inspection.
  if (process.env.BUGSEE_E2E_KEEP === undefined) {
    rmSync(fixturesRoot, { recursive: true, force: true });
  }
});

interface Spec {
  name: string;
  /** The dependency name of the Next copy to build with (`next` = 15.5, `next16` = 16.4). */
  next: 'next' | 'next16';
  args: string[];
  /** Extra source for the `withBugsee` options object and the Next config. */
  options?: string;
  nextConfig?: string;
  /** Pre-seed FOREIGN source-map files (stylesheet and declaration maps nothing in this build produced). */
  seedForeign?: boolean;
  /** Make `bugsee-cli sourcemaps inject` fail for the IN-BUILD stamp only (the post-emit one reaches the real CLI). */
  failInBuildStamp?: boolean;
}

/** The real bugsee-cli binary, as the core resolves it. */
const realCli = (
  createRequire(join(pkgDir, '..', 'bundler-plugin-core', 'package.json'))('@bugsee/cli') as {
    binaryPath(): string;
  }
).binaryPath();

/** Where the foreign files are written, relative to the dist dir, and what they contain. */
const FOREIGN = [
  ['static', 'foreign.css.map'],
  ['static', 'foreign.d.ts.map'],
  ['server', 'foreign.css.map'],
  ['server', 'foreign.d.ts.map'],
] as const;
const FOREIGN_BODY = '{"version":3,"sources":["foreign.css"],"names":[],"mappings":""}';

/** Next config source that writes the foreign files from BOTH bundlers' paths, before Bugsee's step runs. */
const SEED_HOOK = `
  compiler: { runAfterProductionCompile: async ({ distDir }) => seed(distDir) },`;
const SEED_WEBPACK = `
  webpack(config, { isServer }) {
    config.plugins.push({ apply(compiler) {
      compiler.hooks.afterEmit.tap('seed', () => {
        const out = compiler.options.output.path;
        seed(isServer ? join(out, '..', '..') : out);
      });
    } });
    return config;
  },`;
const SEED_PRELUDE = `
import { mkdirSync as mk, writeFileSync as wr } from 'node:fs';
import { join } from 'node:path';
function seed(dist) {
  for (const [dir, name] of ${JSON.stringify(FOREIGN)}) {
    mk(join(dist, dir), { recursive: true });
    wr(join(dist, dir, name), ${JSON.stringify(FOREIGN_BODY)});
  }
}
`;

interface Built {
  dir: string;
  status: number | null;
  log: string;
  uploads: string[];
}

const link = (target: string, path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(realpathSync(target), path, 'dir');
};

/** Write a fixture app, build it with `spec`, and return what happened. */
async function build(spec: Spec): Promise<Built> {
  const dir = join(fixturesRoot, spec.name);
  mkdirSync(join(dir, 'app', 'lazy'), { recursive: true });
  mkdirSync(join(dir, 'app', 'api', 'hi'), { recursive: true });
  mkdirSync(join(dir, 'app', 'edge'), { recursive: true });
  const modules = join(dir, 'node_modules');
  link(join(pkgDir, 'node_modules', spec.next), join(modules, 'next'));
  link(join(pkgDir, 'node_modules', 'react'), join(modules, 'react'));
  link(join(pkgDir, 'node_modules', 'react-dom'), join(modules, 'react-dom'));
  link(join(pkgDir, '..', 'nextjs'), join(modules, '@bugsee', 'nextjs'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: spec.name, version: '1.2.3' }));
  // Plain JavaScript on purpose: a `.ts` file makes Next install TypeScript into the project.
  writeFileSync(
    join(dir, 'app', 'layout.jsx'),
    "import './style.css';\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }\n",
  );
  writeFileSync(join(dir, 'app', 'style.css'), 'body { margin: 0; color: rebeccapurple; }\n');
  writeFileSync(
    join(dir, 'app', 'page.jsx'),
    `'use client';
import { useState } from 'react';
import dynamic from 'next/dynamic';
const Lazy = dynamic(() => import('./lazy/lazy.jsx'), { ssr: false });
const version = typeof __BUGSEE_APP_VERSION__ === 'undefined' ? 'none' : __BUGSEE_APP_VERSION__;
export default function Page() {
  const [n, setN] = useState(0);
  return <main><button onClick={() => setN(n + 1)}>count {n} v{version}</button><Lazy /></main>;
}
`,
  );
  writeFileSync(
    join(dir, 'app', 'lazy', 'lazy.jsx'),
    'export default function Lazy() { return <p id="lazy">lazy-ok</p>; }\n',
  );
  writeFileSync(
    join(dir, 'app', 'api', 'hi', 'route.js'),
    "export const GET = () => new Response('hi');\n",
  );
  writeFileSync(
    join(dir, 'app', 'edge', 'route.js'),
    "export const runtime = 'edge';\nexport const GET = () => new Response('edge');\n",
  );
  writeFileSync(
    join(dir, 'next.config.mjs'),
    `import { withBugsee } from '@bugsee/nextjs/config';${spec.seedForeign ? SEED_PRELUDE : ''}
export default withBugsee(
  { ${spec.next === 'next' ? 'eslint: { ignoreDuringBuilds: true },' : ''} ${spec.nextConfig ?? ''}${spec.seedForeign ? SEED_HOOK + (spec.args.includes('--webpack') ? SEED_WEBPACK : '') : ''} },
  { appToken: 'e2e-token', endpoint: ${JSON.stringify(endpoint)}, appVersion: '9.8.7', appBuild: '42',
    vcs: false, registerBuild: false, failOnError: true, ${spec.options ?? ''} },
);
`,
  );
  const stub = join(dir, 'cli-stub.js');
  if (spec.failInBuildStamp) {
    writeFileSync(
      stub,
      `const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'sourcemaps' && args[1] === 'inject' && String(args[2]).includes('bugsee-stamp-')) {
  process.stderr.write('stub: the in-build inject is refused\\n');
  process.exit(11);
}
process.exit(spawnSync(${JSON.stringify(realCli)}, args, { stdio: 'inherit' }).status ?? 1);
`,
    );
  }
  const before = bodies.length;
  // Asynchronous on purpose: the mock collector lives in THIS process, and a blocking spawn would starve it.
  const child = spawn(
    process.execPath,
    [join(modules, 'next', 'dist', 'bin', 'next'), 'build', ...spec.args],
    {
      cwd: dir,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: '1',
        NODE_OPTIONS: `--import ${tsxLoader}`,
        ...(spec.failInBuildStamp ? { BUGSEE_CLI_PATH: stub } : {}),
      },
    },
  );
  let log = '';
  child.stdout.on('data', (c: Buffer) => (log += c.toString()));
  child.stderr.on('data', (c: Buffer) => (log += c.toString()));
  const status = await new Promise<number | null>((r) => child.on('close', r));
  return { dir, status, log, uploads: bodies.slice(before) };
}

const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
        const full = join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : [full];
      })
    : [];

const DEBUG_ID = /\/\/# debugId=([0-9a-f-]{36})/;
const debugIdOf = (file: string): string | undefined =>
  DEBUG_ID.exec(readFileSync(file, 'utf8'))?.[1];

/** Every bundle under `dir` that points at a map, with the path it points at (the map may be deleted by now). */
const pointing = (dir: string): Array<{ file: string; map: string }> =>
  walk(dir)
    .filter((f) => f.endsWith('.js'))
    .flatMap((file) => {
      const ref = /\/\/# sourceMappingURL=(\S+)\s*$/m.exec(readFileSync(file, 'utf8'))?.[1];
      return ref === undefined ? [] : [{ file, map: join(dirname(file), decodeURIComponent(ref)) }];
    });

/**
 * Bundles whose map belongs to them alone, and bundles that share a map with another (Next 15.5's Turbopack does
 * that for its runtime chunks: a map carries one debug-id, so those are deliberately left unstamped).
 */
const split = (dir: string): { unique: string[]; shared: string[]; referenced: Set<string> } => {
  const all = pointing(dir);
  const count = new Map<string, number>();
  for (const { map } of all) count.set(map, (count.get(map) ?? 0) + 1);
  return {
    unique: all.filter(({ map }) => count.get(map) === 1).map(({ file }) => file),
    shared: all.filter(({ map }) => (count.get(map) as number) > 1).map(({ file }) => file),
    referenced: new Set(all.map(({ map }) => map)),
  };
};

const clientBundles = (dir: string): string[] => split(join(dir, '.next', 'static')).unique;

const maps = (dir: string): string[] => walk(dir).filter((f) => f.endsWith('.map'));

/** `next start` the build and fetch the paths; resolves their statuses. */
async function runBuild(dir: string, paths: string[]): Promise<number[]> {
  const port = 41000 + Math.floor(Math.random() * 2000);
  const child: ChildProcess = spawn(
    process.execPath,
    [join(dir, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port)],
    {
      cwd: dir,
      // `next start` loads next.config too, which imports the TypeScript source of @bugsee/nextjs/config.
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: `--import ${tsxLoader}` },
      stdio: 'ignore',
    },
  );
  try {
    const statuses: number[] = [];
    for (const path of paths) {
      let status = 0;
      for (let attempt = 0; attempt < 60 && status === 0; attempt++) {
        try {
          status = (await fetch(`http://127.0.0.1:${port}${path}`)).status;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      statuses.push(status);
    }
    return statuses;
  } finally {
    child.kill('SIGKILL');
  }
}

interface Page {
  /** What the page printed to the console as an error, plus uncaught exceptions. */
  errors: string[];
  /** Same-origin requests that answered 4xx/5xx (the favicon is not the app's). */
  failed: string[];
  /** The text of the lazily loaded component, which renders only if its chunk loaded and ran. */
  lazy: string | null;
  /** The text of the page after hydration. */
  body: string;
  /** How many bundles registered a debug-id with the runtime (`globalThis._bugseeDebugIds`). */
  debugIds: number;
  /** Next's error overlay / error page text, when it replaced the app. */
  crashed: boolean;
}

/** `next start` the build and open `/` in headless Chromium: does the app, lazy chunk included, actually RUN? */
async function openInBrowser(dir: string): Promise<Page> {
  const port = 43000 + Math.floor(Math.random() * 2000);
  const child: ChildProcess = spawn(
    process.execPath,
    [join(dir, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port)],
    {
      cwd: dir,
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: `--import ${tsxLoader}` },
      stdio: 'ignore',
    },
  );
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    const failed: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('response', (r) => {
      if (r.status() >= 400 && !r.url().includes('favicon'))
        failed.push(`${r.status()} ${r.url()}`);
    });
    let loaded = false;
    for (let attempt = 0; attempt < 60 && !loaded; attempt++) {
      try {
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
        loaded = true;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    expect(loaded, 'next start never answered').toBe(true);
    // Hydrate, then give the lazy chunk its chance to load and run.
    await page
      .locator('button')
      .first()
      .click({ timeout: 15_000 })
      .catch(() => undefined);
    await page.waitForSelector('#lazy', { timeout: 10_000 }).catch(() => undefined);
    const body = await page.evaluate(() => document.body.innerText);
    return {
      errors,
      failed,
      lazy: await page
        .locator('#lazy')
        .textContent({ timeout: 1000 })
        .catch(() => null),
      body,
      debugIds: await page.evaluate(
        () =>
          Object.keys((globalThis as { _bugseeDebugIds?: object })._bugseeDebugIds ?? {}).length,
      ),
      crashed: /Application error|This page couldn.t load|Unhandled Runtime Error/.test(body),
    };
  } finally {
    await context.close();
    child.kill('SIGKILL');
  }
}

/** The assertions every build that was stamped must satisfy once it is OPEN in a browser. */
function expectRuns(page: Page, options: { stamped: boolean }): void {
  expect(page.failed, 'a request failed (a stale chunk URL 404s)').toEqual([]);
  expect(page.errors).toEqual([]);
  expect(page.crashed, page.body).toBe(false);
  expect(page.lazy, 'the lazy chunk did not load and run').toBe('lazy-ok');
  expect(page.body).toContain('v9.8.7');
  if (options.stamped) {
    expect(page.debugIds, 'no bundle registered a debug-id').toBeGreaterThan(0);
  }
}

const MATRIX: Spec[] = [
  { name: 'next15-webpack', next: 'next', args: [] },
  { name: 'next15-turbopack', next: 'next', args: ['--turbopack'] },
  { name: 'next16-turbopack', next: 'next16', args: [] },
  { name: 'next16-webpack', next: 'next16', args: ['--webpack'] },
];

describe.each(MATRIX)('withBugsee — real `next build` ($name)', (spec) => {
  let built: Built;
  beforeAll(async () => {
    built = await build(spec);
  });

  it('builds, and says nothing was skipped or failed', () => {
    expect(built.status, built.log.split('\n').slice(-60).join('\n')).toBe(0);
    // The one expected notice: bundles sharing a map are left alone (asserted below).
    const notices = built.log.split('\n').filter((l) => l.includes('[bugsee]'));
    expect(notices.filter((l) => !l.includes('share one source map'))).toEqual([]);
  });

  it('stamps every client bundle that has a map of its own, and none that share one', () => {
    const { unique, shared } = split(join(built.dir, '.next', 'static'));
    expect(unique.length).toBeGreaterThan(2);
    for (const bundle of unique) {
      expect(debugIdOf(bundle), bundle).toBeDefined();
    }
    for (const bundle of shared) {
      expect(debugIdOf(bundle), `${bundle} shares a map`).toBeUndefined();
    }
    expect(built.log.includes('share one source map')).toBe(shared.length > 0);
  });

  it('uploaded the maps keyed by exactly those debug-IDs, client and server', () => {
    expect(built.uploads.length).toBeGreaterThan(0);
    const sent = built.uploads.join('\n');
    const ids = split(join(built.dir, '.next'))
      .unique.map(debugIdOf)
      .filter((id): id is string => id !== undefined);
    // Server bundles as well as browser ones carry an id, and every id reached the collector.
    expect(ids.length).toBeGreaterThan(clientBundles(built.dir).length);
    for (const id of ids) {
      expect(sent, `debug-id ${id} was not uploaded`).toContain(id);
    }
  });

  it('removes the publicly served client maps and keeps the server maps', () => {
    // What may remain in `.next/static` is a map no bundle points at (Next ships a polyfill that way) or the map
    // two unstamped Turbopack runtime chunks share (Next 15.5). Neither is the app's code, neither was uploaded.
    const staticDir = join(built.dir, '.next', 'static');
    const { shared, referenced } = split(staticDir);
    const sharedMaps = new Set(
      pointing(staticDir)
        .filter((p) => shared.includes(p.file))
        .map((p) => p.map),
    );
    for (const map of maps(staticDir)) {
      expect(referenced.has(map) && !sharedMaps.has(map), `${map} is still served`).toBe(false);
    }
    const server = split(join(built.dir, '.next', 'server'));
    const kept = maps(join(built.dir, '.next', 'server')).filter((m) => server.referenced.has(m));
    expect(kept.length).toBeGreaterThan(0);
    for (const map of kept) {
      expect(JSON.parse(readFileSync(map, 'utf8')).debugId, map).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('covers the edge route too', () => {
    const edgeBundles = split(join(built.dir, '.next', 'server')).unique.filter((f) =>
      /edge/.test(f),
    );
    expect(edgeBundles.length).toBeGreaterThan(0);
    for (const bundle of edgeBundles) {
      expect(debugIdOf(bundle), bundle).toBeDefined();
    }
  });

  it('bakes the app version and build into the bundle', () => {
    const text = clientBundles(built.dir)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    expect(text).toContain('9.8.7');
  });

  it('produces a build that still runs', async () => {
    expect(await runBuild(built.dir, ['/', '/api/hi', '/edge'])).toEqual([200, 200, 200]);
  });

  it('runs in a real browser: the lazy chunk loads and executes, debug-ids register, no errors', async () => {
    expectRuns(await openInBrowser(built.dir), { stamped: true });
  });
});

describe('withBugsee — Subresource Integrity', () => {
  it('webpack: stamps inside the build, so every pinned hash still matches the bytes on disk', async () => {
    const built = await build({
      name: 'sri-webpack',
      next: 'next16',
      args: ['--webpack'],
      nextConfig: "experimental: { sri: { algorithm: 'sha256' } },",
    });
    expect(built.status, built.log.split('\n').slice(-40).join('\n')).toBe(0);
    expect(built.log).not.toMatch(/\[bugsee\]/);
    const html = readFileSync(join(built.dir, '.next', 'server', 'app', 'index.html'), 'utf8');
    const pins = [
      ...html.matchAll(
        /<script[^>]*?(?:src="([^"]+)"[^>]*?integrity="([^"]+)"|integrity="([^"]+)"[^>]*?src="([^"]+)")/g,
      ),
    ];
    expect(pins.length).toBeGreaterThan(0);
    for (const m of pins) {
      const src = (m[1] ?? m[4]) as string;
      const integrity = (m[2] ?? m[3]) as string;
      const file = join(built.dir, '.next', src.replace(/^\/_next\//, ''));
      const [algo] = integrity.split('-');
      const digest = createHash(algo as string)
        .update(readFileSync(file))
        .digest('base64');
      expect(integrity, src).toBe(`${algo}-${digest}`);
      expect(debugIdOf(file), `${src} was not stamped`).toBeDefined();
    }
    expect(built.uploads.length).toBeGreaterThan(0);
    // The browser enforces the hashes: the stamped, SRI-pinned page must still run, lazy chunk included.
    expectRuns(await openInBrowser(built.dir), { stamped: true });
  });

  it('turbopack: leaves an SRI build exactly as Next wrote it, and says why', async () => {
    const built = await build({
      name: 'sri-turbopack',
      next: 'next16',
      args: [],
      nextConfig: "experimental: { sri: { algorithm: 'sha256' } },",
      options: 'failOnError: false,',
    });
    expect(built.status, built.log.split('\n').slice(-40).join('\n')).toBe(0);
    expect(built.log).toMatch(/Subresource Integrity/);
    expect(built.uploads).toEqual([]);
    // Unstamped, so the page's hashes still match.
    for (const bundle of clientBundles(built.dir)) {
      expect(debugIdOf(bundle), bundle).toBeUndefined();
    }
    expectRuns(await openInBrowser(built.dir), { stamped: false });
    // Bugsee did not turn browser maps on for a build it cannot upload for: none are written, none are public.
    expect(maps(join(built.dir, '.next', 'static'))).toEqual([]);
  });

  it('webpack: a failed in-build stamp does NOT fall back to stamping the written files of an SRI build', async () => {
    const built = await build({
      name: 'sri-webpack-fallback',
      next: 'next16',
      args: ['--webpack'],
      options: 'failOnError: false,',
      nextConfig: "experimental: { sri: { algorithm: 'sha256' } },",
      failInBuildStamp: true,
    });
    expect(built.status, built.log.split('\n').slice(-40).join('\n')).toBe(0);
    // ONE accurate message: the stamp failed and the fallback was refused. Never "falling back".
    expect(built.log).not.toMatch(/falling back to stamping after emit/);
    expect(built.log.split('\n').filter((l) => l.includes('Subresource Integrity'))).toHaveLength(
      3,
    ); // client, server, edge: one notice each
    expect(built.log).toMatch(/nothing was stamped or uploaded/);
    expect(built.uploads).toEqual([]);
    // Nothing was rewritten, so the pinned hashes still describe the bytes on disk and the page runs.
    for (const bundle of walk(join(built.dir, '.next', 'static')).filter((f) =>
      f.endsWith('.js'),
    )) {
      expect(debugIdOf(bundle), bundle).toBeUndefined();
    }
    expectRuns(await openInBrowser(built.dir), { stamped: false });
    // Bugsee had turned the browser maps on (the app did not ask); with no upload they must not stay public.
    expect(maps(join(built.dir, '.next', 'static'))).toEqual([]);
    expect(built.log).toMatch(/browser source maps Bugsee had turned on were removed/);
  });

  const sriFailing = (name: string, options: string) =>
    build({
      name,
      next: 'next16',
      args: ['--webpack'],
      options,
      nextConfig: "experimental: { sri: { algorithm: 'sha256' } },",
      failInBuildStamp: true,
    });

  it('webpack + SRI + failOnError: a failed stamp fails the build, and no maps are left behind', async () => {
    const built = await sriFailing('sri-webpack-strict', 'failOnError: true,');
    expect(built.status).not.toBe(0);
    expect(built.log).toMatch(/inject/);
    expect(maps(join(built.dir, '.next', 'static'))).toEqual([]);
  });

  it('webpack + SRI + silent: the notices are muted, the cause is still audible', async () => {
    const built = await sriFailing('sri-webpack-silent', 'failOnError: false, silent: true,');
    expect(built.status, built.log.split('\n').slice(-30).join('\n')).toBe(0);
    expect(built.log).not.toMatch(/Subresource Integrity/);
    expect(built.log).toMatch(/in-build debug-ID stamping did not apply/);
    expect(maps(join(built.dir, '.next', 'static'))).toEqual([]);
  });

  it('webpack + SRI + dryRun: browser maps are not forced on, so none are written or left public', async () => {
    const built = await sriFailing('sri-webpack-dry', 'failOnError: false, dryRun: true,');
    expect(built.status, built.log.split('\n').slice(-30).join('\n')).toBe(0);
    expect(built.uploads).toEqual([]);
    expect(maps(join(built.dir, '.next', 'static'))).toEqual([]);
    expect(built.log).not.toMatch(/Dry run: nothing was deleted/);
  });

  it('turbopack + SRI + maps the APP asked for: they stay, the notice says they are public, said once', async () => {
    const built = await build({
      name: 'sri-turbopack-own-maps',
      next: 'next16',
      args: [],
      nextConfig:
        "experimental: { sri: { algorithm: 'sha256' } }, productionBrowserSourceMaps: true,",
      options: 'failOnError: false,',
    });
    expect(built.status, built.log.split('\n').slice(-40).join('\n')).toBe(0);
    expect(built.uploads).toEqual([]);
    expect(maps(join(built.dir, '.next', 'static')).length).toBeGreaterThan(0);
    const said = built.log.split('\n').filter((l) => l.includes('Subresource Integrity'));
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/publicly served/);
    expectRuns(await openInBrowser(built.dir), { stamped: false });
  });
});

describe.each([
  { name: 'foreign-webpack', next: 'next16', args: ['--webpack'] },
  { name: 'foreign-turbopack', next: 'next16', args: [] },
] as Spec[])('withBugsee — files this build did not produce ($name)', (spec) => {
  let built: Built;
  beforeAll(async () => {
    built = await build({ ...spec, seedForeign: true });
  });

  it('builds', () => {
    expect(built.status, built.log.split('\n').slice(-40).join('\n')).toBe(0);
  });

  it('never deletes a stylesheet or declaration map it did not produce', () => {
    for (const [dir, name] of FOREIGN) {
      const file = join(built.dir, '.next', dir, name);
      expect(existsSync(file), `${dir}/${name} was deleted`).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(FOREIGN_BODY);
    }
  });

  it('still uploaded and deleted its own maps', () => {
    expect(built.uploads.length).toBeGreaterThan(0);
    const { unique } = split(join(built.dir, '.next', 'static'));
    expect(unique.length).toBeGreaterThan(2);
    for (const bundle of unique) {
      expect(debugIdOf(bundle), bundle).toBeDefined();
    }
    const own = maps(join(built.dir, '.next', 'static')).filter(
      (m) => !m.includes('foreign.') && split(join(built.dir, '.next', 'static')).referenced.has(m),
    );
    expect(own).toEqual([]);
  });
});
