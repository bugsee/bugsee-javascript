import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isProjectRootOrAbove,
  isUploadableMap,
  listOutputMaps,
  partitionByKeyed,
  restoreAtomically,
  snapshotStampFiles,
  verifyAndRestore,
  verifyStampedOnDisk,
} from './stamp-files';

const ID = 'b039c7fb-d958-5fe6-b76f-136179e9a728';
const STAMP = `\n;1;\n//# debugId=${ID}\n`;
const plainMap = '{"version":3,"sources":[],"mappings":""}';
const stampedMap = JSON.stringify({ version: 3, sources: [], mappings: '', debugId: ID });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bugsee-sf-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('snapshot + verifyAndRestore', () => {
  it('keeps the originals OUTSIDE memory: a spill directory that is removed on dispose', async () => {
    await writeFile(join(dir, 'a.js'), 'a();\n');
    const snap = await snapshotStampFiles({ dir });
    expect(snap.entries.get(join(dir, 'a.js'))?.hash).toMatch(/^[0-9a-f]{40}$/);
    const spill = snap.spillDir;
    expect((await readdir(spill)).length).toBe(1);
    await snap.dispose();
    await expect(readdir(spill)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('verifies a faithful stamp, including a map named by the pointer, restoring nothing', async () => {
    await mkdir(join(dir, 'maps'));
    await writeFile(join(dir, 'a.js'), 'a();\n//# sourceMappingURL=maps/a.map\n');
    await writeFile(join(dir, 'maps', 'a.map'), plainMap);
    const snap = await snapshotStampFiles({ dir });
    await writeFile(join(dir, 'a.js'), `a();\n//# sourceMappingURL=maps/a.map\n${STAMP}`);
    await writeFile(join(dir, 'maps', 'a.map'), stampedMap);
    const result = await verifyAndRestore(snap);
    expect(result).toEqual({ issues: [], restored: [], failed: [] });
    await snap.dispose();
  });

  it('restores a failing bundle and its custom-named map as a pair, bundle first', async () => {
    await mkdir(join(dir, 'maps'));
    const original = 'a();\n//# sourceMappingURL=maps/a.map\n';
    await writeFile(join(dir, 'a.js'), original);
    await writeFile(join(dir, 'maps', 'a.map'), plainMap);
    const snap = await snapshotStampFiles({ dir });
    await writeFile(join(dir, 'a.js'), `${original}{{${STAMP}`);
    await writeFile(join(dir, 'maps', 'a.map'), stampedMap);
    const { issues, restored, failed } = await verifyAndRestore(snap);
    expect(issues.length).toBeGreaterThan(0);
    expect(restored).toEqual([join(dir, 'a.js'), join(dir, 'maps', 'a.map')]);
    expect(failed).toEqual([]);
    expect(await readFile(join(dir, 'a.js'), 'utf8')).toBe(original);
    expect(await readFile(join(dir, 'maps', 'a.map'), 'utf8')).toBe(plainMap);
    // No temp file is left behind by the atomic restore.
    expect((await readdir(dir)).sort()).toEqual(['a.js', 'maps']);
    await snap.dispose();
  });

  it('a map-only failure restores its bundle too', async () => {
    const original = 'a();\n//# sourceMappingURL=a.js.map\n';
    await writeFile(join(dir, 'a.js'), original);
    await writeFile(join(dir, 'a.js.map'), plainMap);
    const snap = await snapshotStampFiles({ dir });
    await writeFile(join(dir, 'a.js'), `${original}${STAMP}`);
    await writeFile(join(dir, 'a.js.map'), 'not json');
    const { restored, issues } = await verifyAndRestore(snap);
    expect(issues).toHaveLength(1); // the bad map once, not once per loop
    expect(restored).toEqual([join(dir, 'a.js'), join(dir, 'a.js.map')]);
    expect(await readFile(join(dir, 'a.js'), 'utf8')).toBe(original);
    await snap.dispose();
  });

  it('a changed map with no changed bundle is held to being JSON, and is restored when it is not', async () => {
    await writeFile(join(dir, 'x.js.map'), plainMap);
    const snap = await snapshotStampFiles({ dir });
    await writeFile(join(dir, 'x.js.map'), 'garbage');
    const { issues, restored } = await verifyAndRestore(snap);
    expect(issues.map((i) => i.name)).toEqual([join(dir, 'x.js.map')]);
    expect(restored).toEqual([join(dir, 'x.js.map')]);
    expect(await readFile(join(dir, 'x.js.map'), 'utf8')).toBe(plainMap);
    await snap.dispose();
  });

  it('a file deleted meanwhile is not part of the comparison', async () => {
    await writeFile(join(dir, 'a.js'), 'a();\n');
    const snap = await snapshotStampFiles({ dir });
    await rm(join(dir, 'a.js'));
    expect(await verifyAndRestore(snap)).toEqual({ issues: [], restored: [], failed: [] });
    await snap.dispose();
  });

  it('a file that vanishes before the snapshot read is skipped', async () => {
    const snap = await snapshotStampFiles({ files: [join(dir, 'never-there.js')] });
    expect(snap.entries.size).toBe(0);
    await snap.dispose();
  });

  it('a restore that fails midway is REPORTED by name and leaves no temp file; the others still restore', async () => {
    const original = 'a();\n//# sourceMappingURL=a.js.map\n';
    await writeFile(join(dir, 'a.js'), original);
    await writeFile(join(dir, 'a.js.map'), plainMap);
    const snap = await snapshotStampFiles({ dir });
    await writeFile(join(dir, 'a.js'), `${original}{{${STAMP}`);
    await writeFile(join(dir, 'a.js.map'), stampedMap);
    const attempted: string[] = [];
    const { restored, failed } = await verifyAndRestore(snap, {
      restoreFile: async (spill, path) => {
        attempted.push(path);
        if (path.endsWith('.js')) {
          throw new Error('EIO: disk gone');
        }
        await writeFile(path, await readFile(spill));
      },
    });
    expect(attempted).toEqual([join(dir, 'a.js'), join(dir, 'a.js.map')]); // bundle first, map still tried
    expect(failed).toEqual([{ path: join(dir, 'a.js'), error: expect.stringContaining('EIO') }]);
    expect(restored).toEqual([join(dir, 'a.js.map')]);
    await snap.dispose();
  });

  it('the default restore is write-temp-then-rename: when it cannot write, the target is left as it was and no temp file remains', async () => {
    const original = 'a();\n';
    await writeFile(join(dir, 'a.js'), original);
    const snap = await snapshotStampFiles({ dir });
    await writeFile(join(dir, 'a.js'), `a();\n{{${STAMP}`);
    await chmod(dir, 0o555); // the directory refuses new files, so the temp write fails
    try {
      const { failed, restored } = await verifyAndRestore(snap);
      expect(restored).toEqual([]);
      expect(failed.map((f) => f.path)).toEqual([join(dir, 'a.js')]);
    } finally {
      await chmod(dir, 0o755);
    }
    expect(await readFile(join(dir, 'a.js'), 'utf8')).toBe(`a();\n{{${STAMP}`); // intact, not half-written
    expect(await readdir(dir)).toEqual(['a.js']);
    await snap.dispose();
  });

  it('only one pair is in memory at a time: the snapshot holds hashes, not bytes', async () => {
    await writeFile(join(dir, 'a.js'), 'a();\n');
    const snap = await snapshotStampFiles({ dir });
    for (const entry of snap.entries.values()) {
      expect(Object.keys(entry).sort()).toEqual(['hash', 'spill']);
    }
    await snap.dispose();
  });
});

describe("restoreAtomically keeps the target's identity", () => {
  it('keeps the file mode (a 0755 shebang bundle stays executable)', async () => {
    await writeFile(join(dir, 'spill'), '#!/usr/bin/env node\n');
    await writeFile(join(dir, 'cli.js'), 'stamped');
    await chmod(join(dir, 'cli.js'), 0o755);
    await restoreAtomically(join(dir, 'spill'), join(dir, 'cli.js'));
    expect((await stat(join(dir, 'cli.js'))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(dir, 'cli.js'), 'utf8')).toBe('#!/usr/bin/env node\n');
  });
  it('restores THROUGH a symlink: the link stays a link and its real file is replaced', async () => {
    await writeFile(join(dir, 'spill'), 'original');
    await writeFile(join(dir, 'real.js'), 'stamped');
    await symlink('real.js', join(dir, 'link.js'));
    await restoreAtomically(join(dir, 'spill'), join(dir, 'link.js'));
    expect((await lstat(join(dir, 'link.js'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(dir, 'real.js'), 'utf8')).toBe('original');
    expect((await readdir(dir)).sort()).toEqual(['link.js', 'real.js', 'spill']);
  });
  it('a target that no longer exists is simply recreated', async () => {
    await writeFile(join(dir, 'spill'), 'original');
    await restoreAtomically(join(dir, 'spill'), join(dir, 'gone.js'));
    expect(await readFile(join(dir, 'gone.js'), 'utf8')).toBe('original');
  });
});

describe('restore order: the bundle goes back before its map, whatever they are called', () => {
  it('records bundle-then-map for a map that sorts BEFORE its bundle', async () => {
    const pairs = [
      ['b.js', 'a.map'],
      ['z.js', 'a.js.map'],
    ] as const;
    for (const [bundle, map] of pairs) {
      const original = `x();\n//# sourceMappingURL=${map}\n`;
      await writeFile(join(dir, bundle), original);
      await writeFile(join(dir, map), plainMap);
    }
    const snap = await snapshotStampFiles({ dir });
    for (const [bundle, map] of pairs) {
      await writeFile(join(dir, bundle), `x();\n//# sourceMappingURL=${map}\n{{${STAMP}`);
      await writeFile(join(dir, map), stampedMap);
    }
    const order: string[] = [];
    await verifyAndRestore(snap, {
      restoreFile: async (spill, path) => {
        order.push(path.slice(dir.length + 1));
        await writeFile(path, await readFile(spill));
      },
    });
    expect(order).toEqual(['b.js', 'z.js', 'a.js.map', 'a.map']);
    await snap.dispose();
  });
});

describe('restoreAtomically', () => {
  it('replaces the target via a temp file, and removes the temp file when the rename fails', async () => {
    await writeFile(join(dir, 'spill'), 'original');
    await writeFile(join(dir, 'target.js'), 'stamped');
    await restoreAtomically(join(dir, 'spill'), join(dir, 'target.js'));
    expect(await readFile(join(dir, 'target.js'), 'utf8')).toBe('original');
    expect((await readdir(dir)).sort()).toEqual(['spill', 'target.js']);

    // A non-empty directory in the target's place: the temp write succeeds, the rename cannot.
    await mkdir(join(dir, 'blocked'));
    await writeFile(join(dir, 'blocked', 'x'), 'x');
    await expect(restoreAtomically(join(dir, 'spill'), join(dir, 'blocked'))).rejects.toThrow();
    expect((await readdir(dir)).sort()).toEqual(['blocked', 'spill', 'target.js']);
  });
});

describe('isProjectRootOrAbove — the working directory itself', () => {
  it('is true for the cwd (and "."), false for a child, even without a package.json', async () => {
    const start = process.cwd();
    await mkdir(join(dir, 'child'));
    process.chdir(dir);
    try {
      expect(await isProjectRootOrAbove(dir)).toBe(true);
      expect(await isProjectRootOrAbove('.')).toBe(true);
      expect(await isProjectRootOrAbove(join(dir, 'child'))).toBe(false);
    } finally {
      process.chdir(start);
    }
  });
});

describe('isProjectRootOrAbove', () => {
  it('is true for the cwd, "." and any ancestor of the cwd', async () => {
    expect(await isProjectRootOrAbove(process.cwd())).toBe(true);
    expect(await isProjectRootOrAbove(dirname(process.cwd()))).toBe(true);
    expect(await isProjectRootOrAbove('.')).toBe(true);
  });
  it('is false for an ordinary output directory, even one with a package.json marker (dist/cjs, ng-packagr)', async () => {
    await mkdir(join(dir, 'dist', 'cjs'), { recursive: true });
    await writeFile(join(dir, 'dist', 'cjs', 'package.json'), '{"type":"commonjs"}');
    await writeFile(join(dir, 'dist', 'package.json'), '{"name":"copied"}');
    expect(await isProjectRootOrAbove(join(dir, 'dist', 'cjs'))).toBe(false);
    expect(await isProjectRootOrAbove(join(dir, 'dist'))).toBe(false);
  });
  it('is false for a directory that merely shares a name prefix with the cwd', async () => {
    expect(await isProjectRootOrAbove(`${process.cwd()}-sibling`)).toBe(false);
    expect(await isProjectRootOrAbove(process.cwd().slice(0, -1))).toBe(false); // a prefix of the name, not an ancestor
  });
});

describe('isProjectRootOrAbove — a working directory that no longer exists', () => {
  it('is false rather than throwing', async () => {
    const start = process.cwd();
    const gone = join(dir, 'gone');
    await mkdir(gone);
    process.chdir(gone);
    await rm(gone, { recursive: true });
    try {
      expect(await isProjectRootOrAbove(dir)).toBe(false);
    } finally {
      process.chdir(start);
    }
  });
});

describe('a dist/cjs with a package.json marker is snapshotted and verified like any output dir', () => {
  it('restores a bad stamp there', async () => {
    await mkdir(join(dir, 'cjs'));
    await writeFile(join(dir, 'cjs', 'package.json'), '{"type":"commonjs"}');
    await writeFile(join(dir, 'cjs', 'a.js'), 'a();\n');
    const snap = await snapshotStampFiles({ dir: join(dir, 'cjs') });
    expect(snap.entries.has(join(dir, 'cjs', 'a.js'))).toBe(true);
    await writeFile(join(dir, 'cjs', 'a.js'), `a();\n{{${STAMP}`);
    expect((await verifyAndRestore(snap)).restored).toEqual([join(dir, 'cjs', 'a.js')]);
    await snap.dispose();
  });
});

describe('snapshot walk fence (4): only a project root is fenced', () => {
  it('walks src, test and dot-directories of an ordinary output dir (preserveModules: dist/src/a.js)', async () => {
    await mkdir(join(dir, 'out', 'src'), { recursive: true });
    await mkdir(join(dir, 'out', '.hidden'));
    await mkdir(join(dir, 'out', 'node_modules'));
    await writeFile(join(dir, 'out', 'src', 'a.js'), 'a();\n');
    await writeFile(join(dir, 'out', '.hidden', 'h.js'), 'h();\n');
    await writeFile(join(dir, 'out', 'node_modules', 'n.js'), 'n();\n');
    const snap = await snapshotStampFiles({ dir: join(dir, 'out') });
    const names = [...snap.entries.keys()].map((k) => k.slice(join(dir, 'out').length + 1)).sort();
    expect(names).toEqual(['.hidden/h.js', 'node_modules/n.js', 'src/a.js']);
    await writeFile(join(dir, 'out', 'src', 'a.js'), `a();\n{{${STAMP}`);
    expect((await verifyAndRestore(snap)).restored).toEqual([join(dir, 'out', 'src', 'a.js')]);
    await snap.dispose();
  });
  it('fences src, test, node_modules and dot-directories when the directory IS the project root', async () => {
    const start = process.cwd();
    await mkdir(join(dir, 'src'));
    await mkdir(join(dir, '.hidden'));
    await mkdir(join(dir, 'lib'));
    await writeFile(join(dir, 'src', 's.js'), 's();\n');
    await writeFile(join(dir, '.hidden', 'g.js'), 'g();\n');
    await writeFile(join(dir, 'lib', 'l.js'), 'l();\n');
    process.chdir(dir);
    try {
      const snap = await snapshotStampFiles({ dir });
      expect([...snap.entries.keys()].map((k) => k.slice(dir.length + 1))).toEqual(['lib/l.js']);
      await snap.dispose();
    } finally {
      process.chdir(start);
    }
  });
});

describe('verifyStampedOnDisk', () => {
  it('checks only the named bundles, resolving each pair from its pointer, one at a time', async () => {
    await mkdir(join(dir, 'maps'));
    await writeFile(join(dir, 'a.js'), `a();\n//# sourceMappingURL=maps/a.map\n${STAMP}`);
    await writeFile(join(dir, 'maps', 'a.map'), stampedMap);
    // Never part of the bundle: unstamped, with a map — must not be judged.
    await writeFile(join(dir, 'vendor.js'), 'v();\n');
    await writeFile(join(dir, 'vendor.js.map'), plainMap);
    expect(await verifyStampedOnDisk([join(dir, 'a.js')])).toEqual([]);
    await writeFile(join(dir, 'maps', 'a.map'), plainMap);
    expect((await verifyStampedOnDisk([join(dir, 'a.js')])).map((i) => i.name)).toEqual([
      join(dir, 'maps', 'a.map'),
    ]);
  });
  it('falls back to the sibling .map when the pointer names a file that is not there, and skips a missing bundle', async () => {
    await writeFile(join(dir, 'a.js'), `a();\n//# sourceMappingURL=gone.map\n${STAMP}`);
    await writeFile(join(dir, 'a.js.map'), stampedMap);
    expect(await verifyStampedOnDisk([join(dir, 'a.js'), join(dir, 'missing.js')])).toEqual([]);
  });
  it('the sibling fallback is really used: a pointer at a missing file, an UNSTAMPED <bundle>.map beside it', async () => {
    await writeFile(join(dir, 'a.js'), `a();\n//# sourceMappingURL=gone.map\n${STAMP}`);
    await writeFile(join(dir, 'a.js.map'), plainMap);
    expect((await verifyStampedOnDisk([join(dir, 'a.js')])).map((i) => i.name)).toEqual([
      join(dir, 'a.js.map'),
    ]);
  });

  it('a pointer at an existing map wins, and a missing sibling is no problem', async () => {
    await writeFile(join(dir, 'a.js'), `a();\n//# sourceMappingURL=real.map\n${STAMP}`);
    await writeFile(join(dir, 'real.map'), plainMap);
    expect((await verifyStampedOnDisk([join(dir, 'a.js')])).map((i) => i.name)).toEqual([
      join(dir, 'real.map'),
    ]);
    await writeFile(join(dir, 'real.map'), stampedMap);
    expect(await verifyStampedOnDisk([join(dir, 'a.js')])).toEqual([]);
  });

  it('a bundle with no map at all is left alone', async () => {
    await writeFile(join(dir, 'a.js'), 'a();\n');
    expect(await verifyStampedOnDisk([join(dir, 'a.js')])).toEqual([]);
  });
});

describe('isUploadableMap — what the CLI scans a directory for', () => {
  it('is every .map except stylesheet and declaration maps', () => {
    for (const yes of ['a.js.map', 'a.mjs.map', 'index.map', 'dir/b.cjs.map', 'x.bundle.jsx.map']) {
      expect(isUploadableMap(yes), yes).toBe(true);
    }
    for (const no of ['a.css.map', 'a.d.ts.map', 'a.d.mts.map', 'a.d.cts.map', 'a.js', 'map']) {
      expect(isUploadableMap(no), no).toBe(false);
    }
  });
});

describe('partitionByKeyed — any uploadable map needs a key, whatever it is called', () => {
  it('keeps an unkeyed index.map, deletes a keyed one, and deletes a stylesheet/declaration map', async () => {
    await writeFile(join(dir, 'keyed.map'), stampedMap);
    await writeFile(join(dir, 'unkeyed.map'), plainMap);
    await writeFile(join(dir, 'a.css.map'), plainMap);
    await writeFile(join(dir, 'a.d.ts.map'), plainMap);
    const names = ['keyed.map', 'unkeyed.map', 'a.css.map', 'a.d.ts.map'].map((n) => join(dir, n));
    const { deletable, kept } = await partitionByKeyed(names);
    expect(kept).toEqual([join(dir, 'unkeyed.map')]);
    expect(deletable.sort()).toEqual(
      [join(dir, 'a.css.map'), join(dir, 'a.d.ts.map'), join(dir, 'keyed.map')].sort(),
    );
  });
});

describe('partitionByKeyed — a map that cannot be read is not "gone"', () => {
  it('keeps (never silently drops) a map that fails to read with anything but ENOENT', async () => {
    await writeFile(join(dir, 'locked.js.map'), stampedMap);
    await chmod(join(dir, 'locked.js.map'), 0o000);
    try {
      const { deletable, kept } = await partitionByKeyed([
        join(dir, 'locked.js.map'),
        join(dir, 'vanished.js.map'),
      ]);
      expect(kept).toEqual([join(dir, 'locked.js.map')]);
      expect(deletable).toEqual([]); // the vanished one is neither kept nor deleted
    } finally {
      await chmod(join(dir, 'locked.js.map'), 0o644);
    }
  });
});

describe('listOutputMaps', () => {
  it('lists EVERY map of the whole output directory (any name, src/ and dot-dirs included), sorted, stylesheet and declaration maps too', async () => {
    await mkdir(join(dir, 'src'));
    await mkdir(join(dir, '.hidden'));
    await mkdir(join(dir, 'test'));
    await writeFile(join(dir, 'src', 'a.js.map'), '{}');
    await writeFile(join(dir, '.hidden', 'b.mjs.map'), '{}');
    await writeFile(join(dir, 'test', 't.map'), '{}');
    await writeFile(join(dir, 'index.map'), '{}');
    await writeFile(join(dir, 'c.css.map'), '{}');
    await writeFile(join(dir, 'd.d.ts.map'), '{}');
    await writeFile(join(dir, 'e.js'), 'x');
    expect((await listOutputMaps(dir)).map((f) => f.slice(dir.length + 1))).toEqual([
      '.hidden/b.mjs.map',
      'c.css.map',
      'd.d.ts.map',
      'index.map',
      'src/a.js.map',
      'test/t.map',
    ]);
  });
  it('is fenced at the project root', async () => {
    const start = process.cwd();
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'a.js.map'), '{}');
    await writeFile(join(dir, 'ok.map'), '{}');
    process.chdir(dir);
    try {
      expect((await listOutputMaps(dir)).map((f) => f.slice(dir.length + 1))).toEqual(['ok.map']);
    } finally {
      process.chdir(start);
    }
  });
});
