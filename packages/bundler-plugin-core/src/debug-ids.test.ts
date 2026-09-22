import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectDebugIds, readDebugId } from './debug-ids';

// The exact tail `bugsee-cli sourcemaps inject` appends (src/inject/mod.rs, `runtime_stub`).
const stub = (id: string): string =>
  `\n;!function(){try{var e="undefined"!=typeof window?window:{},n=(new e.Error).stack;` +
  `n&&(e._bugseeDebugIds=e._bugseeDebugIds||{},e._bugseeDebugIds[n]="${id}")}catch(e){}}();\n` +
  `//# debugId=${id}\n`;

const ID_A = '0f3c2a1e-7b1d-5e2a-9c4b-1a2b3c4d5e6f';
const ID_B = '9a8b7c6d-5e4f-5a3b-8c2d-1e0f9a8b7c6d';

describe('readDebugId', () => {
  it('reads the id inject stamped', () => {
    expect(readDebugId(`console.log(1);${stub(ID_A)}`)).toBe(ID_A);
  });

  it('takes the LAST stamp, as inject itself does on a re-stamp', () => {
    // `existing_debug_id` uses `rfind`; a bundle that somehow carries two must agree with the CLI on
    // which one is current.
    expect(readDebugId(`//# debugId=${ID_B}\ncode();${stub(ID_A)}`)).toBe(ID_A);
  });

  it('normalises case, as the CLI does when it parses the id', () => {
    expect(readDebugId(`x;${stub(ID_A.toUpperCase())}`)).toBe(ID_A);
  });

  it('returns nothing for an unstamped bundle', () => {
    expect(readDebugId('console.log(1);\n//# sourceMappingURL=app.js.map\n')).toBeUndefined();
  });

  it('returns nothing for a stamp that is not a UUID', () => {
    // The CLI's own reader refuses it (`Uuid::parse_str`), so a hand-edited or truncated comment must
    // not become an input to the build id.
    expect(readDebugId('x;\n//# debugId=not-a-uuid-at-all\n')).toBeUndefined();
    expect(readDebugId('x;\n//# debugId=0f3c2a1e-7b1d\n')).toBeUndefined();
  });
});

describe('collectDebugIds', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bugsee-debug-ids-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('collects the id from every stamped bundle, including nested chunks', async () => {
    await writeFile(join(dir, 'index.js'), `a();${stub(ID_A)}`);
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'assets', 'chunk.mjs'), `b();${stub(ID_B)}`);

    expect((await collectDebugIds(dir)).sort()).toEqual([ID_A, ID_B].sort());
  });

  it('reads .cjs and .mjs as well as .js — the extensions inject stamps', async () => {
    await writeFile(join(dir, 'server.cjs'), `a();${stub(ID_A)}`);
    await writeFile(join(dir, 'worker.mjs'), `b();${stub(ID_B)}`);

    expect((await collectDebugIds(dir)).sort()).toEqual([ID_A, ID_B].sort());
  });

  it('ignores maps and every other file', async () => {
    // The ids are read from the BUNDLES because those survive: the plugin deletes the client maps
    // after uploading them, and a build id must not depend on having run before that.
    // A map's `sourcesContent` embeds the ORIGINAL sources verbatim, and a bundled dependency that
    // was itself stamped carries a real `//# debugId=` line in there — so reading maps would count a
    // foreign id as part of this build.
    await writeFile(
      join(dir, 'index.js.map'),
      JSON.stringify({ debugId: ID_B, sourcesContent: [`lib();\n//# debugId=${ID_B}\n`] }),
    );
    await writeFile(join(dir, 'index.html'), `<script>//# debugId=${ID_B}</script>`);
    await writeFile(join(dir, 'index.js'), `a();${stub(ID_A)}`);

    expect(await collectDebugIds(dir)).toEqual([ID_A]);
  });

  it('skips a bundle that was never stamped', async () => {
    await writeFile(join(dir, 'index.js'), `a();${stub(ID_A)}`);
    await writeFile(join(dir, 'plain.js'), 'b();\n');

    expect(await collectDebugIds(dir)).toEqual([ID_A]);
  });

  it('finds the stamp at the end of a large bundle', async () => {
    // Only the tail is read; the stub is what inject appends LAST, so a multi-megabyte chunk costs
    // one bounded read, not the whole file.
    await writeFile(join(dir, 'big.js'), `${'x'.repeat(3_000_000)};${stub(ID_A)}`);

    expect(await collectDebugIds(dir)).toEqual([ID_A]);
  });

  it('does not descend into node_modules or dot-directories', async () => {
    // Same walk rules as the map-deletion pass, so a mis-resolved output root cannot traverse a
    // project's dependencies.
    await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'dep', 'index.js'), `x();${stub(ID_B)}`);
    await mkdir(join(dir, '.cache'));
    await writeFile(join(dir, '.cache', 'c.js'), `x();${stub(ID_B)}`);
    await writeFile(join(dir, 'index.js'), `a();${stub(ID_A)}`);

    expect(await collectDebugIds(dir)).toEqual([ID_A]);
  });

  it('returns nothing, without throwing, for a directory that does not exist', async () => {
    // A registration must never fail a build over a path problem the CLI already reports properly.
    expect(await collectDebugIds(join(dir, 'missing'))).toEqual([]);
  });

  it('stops at a bounded depth', async () => {
    let deep = dir;
    for (let i = 0; i < 10; i += 1) {
      deep = join(deep, `d${i}`);
    }
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, 'x.js'), `x();${stub(ID_B)}`);
    await writeFile(join(dir, 'index.js'), `a();${stub(ID_A)}`);

    expect(await collectDebugIds(dir)).toEqual([ID_A]);
  });
});
