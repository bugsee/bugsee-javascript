import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSriProtectedScripts } from './sri';

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

const fixture = async () => mkdtemp(join(tmpdir(), 'bugsee-sri-'));

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
    expect(found).toEqual([{ html: join(dir, 'index.html'), script: join(dir, 'main.js') }]);
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

  it('skips a page it cannot read instead of failing the build', async () => {
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
  });

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
