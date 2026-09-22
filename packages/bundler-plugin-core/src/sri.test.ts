import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findIntegrityMismatches, findSriProtectedScripts } from './sri';

// Measured, 2026-09-18: a real webpack 5.111 build with `webpack-subresource-integrity` +
// `html-webpack-plugin`, served over HTTP and loaded in Chromium 151. Before `sourcemaps inject` the
// app ran; after it, the entry script was BLOCKED —
//   "Failed to find a valid digest in the 'integrity' attribute for resource '…/main.<hash>.js' …
//    The resource has been blocked."
// — because inject appends the debug-id to a file whose hash the HTML already pins (114 → 472 bytes,
// index.html byte-identical). This scanner is what stops us from shipping that page.

const write = async (dir: string, name: string, body: string) => {
  const full = join(dir, name);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, body, 'utf8');
  return full;
};

const made: string[] = [];
const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bugsee-sri-'));
  made.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('findSriProtectedScripts', () => {
  it('finds a script whose integrity pins a file we are about to stamp', async () => {
    const dir = await fixture();
    await write(dir, 'main.js', 'console.log(1)');
    await write(
      dir,
      'index.html',
      '<!doctype html><script defer src=main.js integrity=sha384-KUBb crossorigin=anonymous></script>',
    );

    const found = await findSriProtectedScripts(dir);
    expect(found).toEqual([
      { html: join(dir, 'index.html'), script: join(dir, 'main.js'), integrity: 'sha384-KUBb' },
    ]);
  });

  it('carries the integrity value unquoted and trimmed', async () => {
    const dir = await fixture();
    await write(dir, 'main.js', 'console.log(1)');
    await write(
      dir,
      'index.html',
      `<script src="main.js" integrity=" sha384-A  sha512-B "></script>`,
    );
    const [found] = await findSriProtectedScripts(dir);
    expect(found?.integrity).toBe('sha384-A  sha512-B');
  });

  it('accepts quoted attributes in either order, and several scripts in one page', async () => {
    const dir = await fixture();
    await write(dir, 'a.js', '1');
    await write(dir, 'assets/b.js', '2');
    await write(
      dir,
      'index.html',
      `<script integrity="sha512-AAA" src="a.js"></script>
       <script src='assets/b.js' integrity='sha256-BBB'></script>`,
    );

    const found = await findSriProtectedScripts(dir);
    expect(found.map((f) => f.script)).toEqual([join(dir, 'a.js'), join(dir, 'assets', 'b.js')]);
  });

  it('ignores a script with no integrity attribute — the ordinary case', async () => {
    const dir = await fixture();
    await write(dir, 'main.js', 'console.log(1)');
    await write(dir, 'index.html', '<script src="main.js"></script>');

    expect(await findSriProtectedScripts(dir)).toEqual([]);
  });

  it('ignores an integrity on a script we do not emit (a CDN dependency)', async () => {
    const dir = await fixture();
    await write(
      dir,
      'index.html',
      '<script src="https://cdn.example/lib.js" integrity="sha384-X"></script>',
    );

    // The file is not in the build output, so stamping cannot invalidate its hash.
    expect(await findSriProtectedScripts(dir)).toEqual([]);
  });

  it('ignores integrity on a stylesheet — inject only rewrites JS', async () => {
    const dir = await fixture();
    await write(dir, 'main.css', 'body{}');
    await write(dir, 'index.html', '<link rel=stylesheet href=main.css integrity=sha384-C>');

    expect(await findSriProtectedScripts(dir)).toEqual([]);
  });

  it('ignores a pinned script that is not JS — inject only rewrites .js/.cjs/.mjs', async () => {
    const dir = await fixture();
    await write(dir, 'app.wasm', 'not js');
    await write(dir, 'importmap.json', '{}');
    await write(
      dir,
      'index.html',
      `<script src="app.wasm" integrity="sha384-W"></script>
       <script type="importmap" src="importmap.json" integrity="sha384-I"></script>`,
    );

    expect(await findSriProtectedScripts(dir)).toEqual([]);
  });

  it('ignores a pinned script that resolves OUTSIDE the output directory', async () => {
    // `outDir` is what we hand the CLI, so a page reaching up to a sibling directory names a file
    // inject never touches. Flagging it would refuse to stamp a build we are not breaking.
    const root = await fixture();
    const outDir = join(root, 'dist');
    await write(root, 'vendor.js', '1');
    await write(outDir, 'index.html', '<script src="../vendor.js" integrity="sha384-V"></script>');

    expect(await findSriProtectedScripts(outDir)).toEqual([]);
  });

  it('reads nested pages and de-duplicates a script pinned by two of them', async () => {
    const dir = await fixture();
    await write(dir, 'app.js', '1');
    await write(dir, 'index.html', '<script src="app.js" integrity="sha384-A"></script>');
    await write(dir, 'about/index.html', '<script src="../app.js" integrity="sha384-A"></script>');

    const found = await findSriProtectedScripts(dir);
    expect(found.map((f) => f.script)).toEqual([join(dir, 'app.js')]);
  });

  it('ignores a pinned script whose src is only a query or fragment', async () => {
    const dir = await fixture();
    await write(dir, 'index.html', '<script src="?v=2" integrity="sha384-Q"></script>');

    expect(await findSriProtectedScripts(dir)).toEqual([]);
  });

  it('ignores an integrity on an INLINE script — there is no file to rewrite', async () => {
    const dir = await fixture();
    await write(dir, 'index.html', '<script integrity="sha384-N">console.log(1)</script>');

    expect(await findSriProtectedScripts(dir)).toEqual([]);
  });

  it('stops descending past the depth limit rather than walking a mis-resolved root', async () => {
    const dir = await fixture();
    await write(dir, 'app.js', '1');
    // Depth 7: one past MAX_DEPTH.
    await write(
      dir,
      'a/b/c/d/e/f/g/index.html',
      '<script src="/app.js" integrity="sha384-D"></script>',
    );
    expect(await findSriProtectedScripts(dir)).toEqual([]);

    // …and the same page one level shallower IS found, so the guard is the depth and nothing else.
    await write(
      dir,
      'a/b/c/d/e/f/index.html',
      '<script src="/app.js" integrity="sha384-D"></script>',
    );
    expect((await findSriProtectedScripts(dir)).map((f) => f.script)).toEqual([
      join(dir, 'app.js'),
    ]);
  });

  // Skipped as root (a containerised runner): chmod 000 does not stop root from reading.
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'skips a page it cannot read instead of failing the build',
    async () => {
      const dir = await fixture();
      await write(dir, 'app.js', '1');
      await write(dir, 'readable.html', '<script src="app.js" integrity="sha384-R"></script>');
      const locked = await write(
        dir,
        'locked.html',
        '<script src="app.js" integrity="sha384-L"></script>',
      );
      await chmod(locked, 0o000);

      // The readable page is still scanned: one unreadable file must not blind the whole guard.
      const found = await findSriProtectedScripts(dir);
      await chmod(locked, 0o644);
      expect(found.map((f) => f.html)).toEqual([join(dir, 'readable.html')]);
    },
  );

  it('never descends into node_modules or a dot-directory', async () => {
    const dir = await fixture();
    await write(dir, 'app.js', '1');
    await write(
      dir,
      'node_modules/pkg/demo.html',
      '<script src="/app.js" integrity="sha384-M"></script>',
    );
    await write(dir, '.cache/page.html', '<script src="/app.js" integrity="sha384-C"></script>');

    expect(await findSriProtectedScripts(dir)).toEqual([]);
  });

  // Rollup hands `writeBundle` its `output.dir` verbatim, and an `output.file: 'bundle.js'` config
  // resolves to '.' — so the guard used to compare an absolute script path against a relative root
  // and conclude every script was "outside the output directory". It was inert for exactly those
  // builds, which is worse than not having it: it reports safety it never checked.
  it('works when given a RELATIVE output directory', async () => {
    const dir = await fixture();
    await write(dir, 'main.js', '1');
    await write(dir, 'assets/chunk.js', '2');
    await write(
      dir,
      'index.html',
      `<script src="main.js" integrity="sha384-A"></script>
       <script src="/assets/chunk.js" integrity="sha384-B"></script>`,
    );

    const cwd = process.cwd();
    process.chdir(dir);
    try {
      // Resolved from INSIDE the directory: on macOS `/var` is a symlink to `/private/var`, so the
      // fixture's own path and the resolved one differ by that prefix. What matters is that a
      // relative root finds both scripts, not which spelling of the prefix comes back.
      const expected = [resolve('main.js'), resolve('assets/chunk.js')].sort();
      for (const relativeDir of ['.', './', 'assets/..']) {
        const found = await findSriProtectedScripts(relativeDir);
        expect(found.map((f) => f.script).sort()).toEqual(expected);
      }
      // …and one level up, naming the directory rather than sitting in it.
      const name = basename(dir);
      process.chdir(join(dir, '..'));
      expect((await findSriProtectedScripts(name)).length).toBe(2);
    } finally {
      process.chdir(cwd);
    }
  });

  it('flags a <link rel=modulepreload> that pins a chunk', async () => {
    // A failed modulepreload poisons the module map, so the later import() of that chunk fails too.
    const dir = await fixture();
    await write(dir, 'chunk.js', '1');
    await write(dir, 'entry.js', '2');
    await write(
      dir,
      'index.html',
      `<link rel="modulepreload" href="chunk.js" integrity="sha384-P">
       <link rel="preload" as="script" href="entry.js" integrity="sha384-Q">`,
    );

    expect((await findSriProtectedScripts(dir)).map((f) => f.script).sort()).toEqual(
      [join(dir, 'chunk.js'), join(dir, 'entry.js')].sort(),
    );
  });

  it('ignores a <link rel=prefetch> — a failed prefetch is discarded, not fatal', async () => {
    const dir = await fixture();
    await write(dir, 'chunk.js', '1');
    await write(dir, 'index.html', '<link rel="prefetch" href="chunk.js" integrity="sha384-P">');

    expect(await findSriProtectedScripts(dir)).toEqual([]);
  });

  it('does not follow a symlinked page', async () => {
    // Pins the walk to regular files. A symlink can point anywhere, and the pages we care about are
    // the ones the bundler wrote into this directory.
    const dir = await fixture();
    const other = await fixture();
    await write(dir, 'main.js', '1');
    await write(other, 'real.html', '<script src="main.js" integrity="sha384-L"></script>');
    await symlink(join(other, 'real.html'), join(dir, 'index.html'));

    expect(await findSriProtectedScripts(dir)).toEqual([]);
  });

  it('ignores a <link> that pins something other than a script', async () => {
    const dir = await fixture();
    await write(dir, 'app.css', 'body{}');
    await write(dir, 'index.html', '<link rel="stylesheet" href="app.css" integrity="sha384-S">');

    expect(await findSriProtectedScripts(dir)).toEqual([]);
  });

  it('pins .mjs and .cjs too, which is what a server build emits', async () => {
    const dir = await fixture();
    await write(dir, 'a.mjs', '1');
    await write(dir, 'b.cjs', '2');
    await write(
      dir,
      'index.html',
      `<script type="module" src="a.mjs" integrity="sha384-M"></script>
       <script src="b.cjs" integrity="sha384-C"></script>`,
    );

    expect((await findSriProtectedScripts(dir)).map((f) => f.script).sort()).toEqual(
      [join(dir, 'a.mjs'), join(dir, 'b.cjs')].sort(),
    );
  });

  it('ignores a commented-out script tag', async () => {
    const dir = await fixture();
    await write(dir, 'main.js', '1');
    await write(dir, 'index.html', '<!-- <script src="main.js" integrity="sha384-X"></script> -->');

    expect(await findSriProtectedScripts(dir)).toEqual([]);
  });

  it('ignores data-* attributes that merely look like integrity or src', async () => {
    const dir = await fixture();
    await write(dir, 'main.js', '1');
    await write(
      dir,
      'index.html',
      '<script data-integrity="sha384-X" data-src="main.js"></script>',
    );

    expect(await findSriProtectedScripts(dir)).toEqual([]);
  });

  it('ignores an EMPTY integrity attribute, which pins nothing', async () => {
    const dir = await fixture();
    await write(dir, 'main.js', '1');
    await write(dir, 'index.html', '<script src="main.js" integrity=""></script>');

    expect(await findSriProtectedScripts(dir)).toEqual([]);
  });

  it('flags a src padded with whitespace, which the browser strips', async () => {
    const dir = await fixture();
    await write(dir, 'main.js', '1');
    await write(dir, 'index.html', '<script src="  main.js  " integrity="sha384-W"></script>');

    expect((await findSriProtectedScripts(dir)).map((f) => f.script)).toEqual([
      join(dir, 'main.js'),
    ]);
  });

  it('does not treat a SIBLING directory with a shared prefix as inside the output', async () => {
    const root = await fixture();
    const outDir = join(root, 'dist');
    await write(root, 'dist-2/main.js', '1');
    await write(
      outDir,
      'index.html',
      '<script src="../dist-2/main.js" integrity="sha384-N"></script>',
    );

    expect(await findSriProtectedScripts(outDir)).toEqual([]);
  });

  it('ignores a DIRECTORY whose name ends in .html', async () => {
    const dir = await fixture();
    await mkdir(join(dir, 'weird.html'), { recursive: true });

    expect(await findSriProtectedScripts(dir)).toEqual([]);
  });

  it('returns nothing for a build with no HTML at all (a library, a server bundle)', async () => {
    const dir = await fixture();
    await write(dir, 'index.js', 'module.exports = 1');

    expect(await findSriProtectedScripts(dir)).toEqual([]);
  });

  it('is silent about a directory that does not exist rather than throwing', async () => {
    // The scan runs before anything else, on a path the caller supplied: a wrong path must surface as
    // the CLI's own "path does not exist", not as an unhandled error from a guard.
    expect(await findSriProtectedScripts(join(await fixture(), 'nope'))).toEqual([]);
  });
});

// The question a browser actually asks: does the file's digest match what the page pinned? Used after
// the in-build stamping path, where nothing is rewritten post-emit — so the only way this build can
// break its own SRI is if some plugin hashed BEFORE Bugsee stamped (stamp-assets.ts). That is the
// silent broken page the refusal existed to prevent, and this is what keeps it from being silent.
describe('findIntegrityMismatches', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bugsee-sri-verify-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const digest = (alg: 'sha256' | 'sha384' | 'sha512', bytes: string): string =>
    `${alg}-${createHash(alg).update(bytes).digest('base64')}`;

  const page = async (integrity: string, script = 'main.js'): Promise<void> => {
    await writeFile(
      join(root, 'index.html'),
      `<script src="${script}" integrity="${integrity}" crossorigin="anonymous"></script>`,
    );
  };

  it('is empty when every pinned script still matches its hash', async () => {
    await writeFile(join(root, 'main.js'), 'stamped();');
    await page(digest('sha384', 'stamped();'));
    expect(await findIntegrityMismatches(root)).toEqual([]);
  });

  it('reports a script whose bytes changed after it was hashed', async () => {
    await writeFile(join(root, 'main.js'), 'stamped();');
    await page(digest('sha384', 'original();'));
    expect(await findIntegrityMismatches(root)).toEqual([
      expect.objectContaining({ script: join(root, 'main.js') }),
    ]);
  });

  it('checks each supported algorithm', async () => {
    await writeFile(join(root, 'main.js'), 'x();');
    for (const alg of ['sha256', 'sha384', 'sha512'] as const) {
      await page(digest(alg, 'x();'));
      expect(await findIntegrityMismatches(root), alg).toEqual([]);
      await page(digest(alg, 'y();'));
      expect(await findIntegrityMismatches(root), alg).toHaveLength(1);
    }
  });

  it('judges only by the STRONGEST algorithm listed, as a browser does', async () => {
    // SRI: when several algorithms are listed, only the strongest ones are compared. A matching
    // sha256 beside a stale sha512 does NOT get the script loaded.
    await writeFile(join(root, 'main.js'), 'x();');
    await page(`${digest('sha256', 'x();')} ${digest('sha512', 'stale();')}`);
    expect(await findIntegrityMismatches(root)).toHaveLength(1);
  });

  it('accepts any one match among several digests of the strongest algorithm', async () => {
    await writeFile(join(root, 'main.js'), 'x();');
    await page(`${digest('sha384', 'other();')} ${digest('sha384', 'x();')}`);
    expect(await findIntegrityMismatches(root)).toEqual([]);
  });

  it('ignores an integrity value it cannot evaluate, as a browser does', async () => {
    // Unknown algorithms are skipped by the browser, and a value with none it knows means no check.
    await writeFile(join(root, 'main.js'), 'x();');
    await page('md5-abc sha1-def');
    expect(await findIntegrityMismatches(root)).toEqual([]);
  });

  it('tolerates the ?options suffix the SRI grammar allows', async () => {
    await writeFile(join(root, 'main.js'), 'x();');
    await page(`${digest('sha384', 'x();')}?ct=application/javascript`);
    expect(await findIntegrityMismatches(root)).toEqual([]);
  });

  it('skips a pinned script that is not on disk, rather than failing the check', async () => {
    // A stale page pinning a deleted bundle is broken, but not by anything this build did.
    await page(digest('sha384', 'x();'), 'gone.js');
    expect(await findIntegrityMismatches(root)).toEqual([]);
  });
});
