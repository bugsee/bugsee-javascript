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
  cutAtQuery,
  isFencedPath,
  isProjectRootOrAbove,
  isUploadableMap,
  listOutputMaps,
  ownedBy,
  partitionByKeyed,
  restoreAtomically,
  restorePaths,
  sameAsSnapshot,
  snapshotStampFiles,
  verifyAndRestore,
  verifyStampedOnDisk,
} from './stamp-files';

/** A root runner (CAP_DAC_OVERRIDE) writes into a 0o555 directory anyway: such tests cannot run there. */
async function cannotBlockWrites(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), 'bugsee-perm-probe-'));
  try {
    await chmod(probe, 0o555);
    await writeFile(join(probe, 'x'), '');
    return true;
  } catch {
    return false;
  } finally {
    await chmod(probe, 0o755).catch(() => undefined);
    await rm(probe, { recursive: true, force: true });
  }
}

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
    expect(attempted).toEqual([join(dir, 'a.js')]); // bundle first; its map is NOT tried once the bundle failed
    expect(failed.map((f) => f.path)).toEqual([join(dir, 'a.js'), join(dir, 'a.js.map')]);
    expect(failed[0]?.error).toContain('EIO');
    expect(failed[1]?.error).toContain('bundle'); // its map is not restored under a still-stamped bundle
    expect(restored).toEqual([]);
    await snap.dispose();
  });

  it('the default restore is write-temp-then-rename: when it cannot write, the target is left as it was and no temp file remains', async (ctx) => {
    if (await cannotBlockWrites()) {
      ctx.skip();
    }
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
    if (process.platform !== 'win32') {
      // Windows cannot set the execute bits: the exact mode is a POSIX property
      expect((await stat(join(dir, 'cli.js'))).mode & 0o777).toBe(0o755);
    }
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
  it('falls back to the sibling .map when the pointer names a file that is not there', async () => {
    await writeFile(join(dir, 'a.js'), `a();\n//# sourceMappingURL=gone.map\n${STAMP}`);
    await writeFile(join(dir, 'a.js.map'), stampedMap);
    expect(await verifyStampedOnDisk([join(dir, 'a.js')])).toEqual([]);
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

describe('depth: an ordinary output directory is walked to any depth (the CLI scan and inject have no cap)', () => {
  const deepDir = async (levels: number): Promise<string> => {
    let d = dir;
    for (let i = 0; i < levels; i++) {
      d = join(d, `d${i}`);
      await mkdir(d);
    }
    return d;
  };
  it('lists a map 8 levels down and snapshots + restores the bundle beside it', async () => {
    const deep = await deepDir(8);
    await writeFile(join(deep, 'deep.js.map'), '{}');
    await writeFile(join(deep, 'deep.js'), 'a();\n');
    expect(await listOutputMaps(dir)).toEqual([join(deep, 'deep.js.map')]);
    const snap = await snapshotStampFiles({ dir });
    expect(snap.entries.has(join(deep, 'deep.js'))).toBe(true);
    await writeFile(join(deep, 'deep.js'), `a();\n{{${STAMP}`);
    expect((await verifyAndRestore(snap)).restored).toEqual([
      join(deep, 'deep.js'),
      join(deep, 'deep.js.map'),
    ]);
    await snap.dispose();
  });
  it('at a PROJECT ROOT the depth cap still bounds the walk', async () => {
    const start = process.cwd();
    const deep = await deepDir(8);
    await writeFile(join(deep, 'deep.js.map'), '{}');
    process.chdir(dir);
    try {
      expect(await listOutputMaps(dir)).toEqual([]);
    } finally {
      process.chdir(start);
    }
  });
});

describe("isFencedPath — directories that are not this build's output", () => {
  it('is true when any directory segment is a never-walk name or a dot-directory', () => {
    for (const rel of [
      'node_modules/p/a.css.map',
      'a/src/b.d.ts.map',
      '.cache/x.map',
      'x/.well-known/y.map',
      'test/t.map',
      '__tests__/a.map',
    ]) {
      expect(isFencedPath(rel), rel).toBe(true);
    }
    for (const rel of ['a.css.map', 'assets/a.css.map', 'srcs/a.map', 'a/b/.hidden.map']) {
      expect(isFencedPath(rel), rel).toBe(false);
    }
  });
});

describe('verifyAndRestore — a map that lives OUTSIDE the snapshotted output', () => {
  it('flags and restores a stamped bundle whose pointer reaches a map outside the directory', async () => {
    await mkdir(join(dir, 'out', 'js'), { recursive: true });
    await mkdir(join(dir, 'maps'));
    await writeFile(join(dir, 'maps', 'a.js.map'), plainMap);
    const original = 'a();\n//# sourceMappingURL=../../maps/a.js.map\n';
    await writeFile(join(dir, 'out', 'js', 'a.js'), original);
    const snap = await snapshotStampFiles({ dir: join(dir, 'out') });
    await writeFile(join(dir, 'out', 'js', 'a.js'), `${original}${STAMP}`);
    const { issues, restored } = await verifyAndRestore(snap);
    expect(issues[0]?.reason).toContain('outside the output directory');
    expect(restored).toEqual([join(dir, 'out', 'js', 'a.js')]);
    expect(await readFile(join(dir, 'out', 'js', 'a.js'), 'utf8')).toBe(original);
    await snap.dispose();
  });
});

describe("verifyStampedOnDisk — the build's own bundle -> map mapping", () => {
  it('checks a map the pointer and sibling both miss (Rollup moved map), and flags a lost id', async () => {
    await mkdir(join(dir, 'js'));
    await mkdir(join(dir, 'maps'));
    await writeFile(join(dir, 'js', 'a.js'), `a();\n//# sourceMappingURL=a.map\n${STAMP}`);
    await writeFile(join(dir, 'maps', 'a.js.map'), plainMap);
    const hint = new Map([[join(dir, 'js', 'a.js'), join(dir, 'maps', 'a.js.map')]]);
    expect(await verifyStampedOnDisk([join(dir, 'js', 'a.js')])).toEqual([]); // without the hint: blind
    expect((await verifyStampedOnDisk([join(dir, 'js', 'a.js')], hint)).map((i) => i.name)).toEqual(
      [join(dir, 'maps', 'a.js.map')],
    );
    await writeFile(join(dir, 'maps', 'a.js.map'), stampedMap);
    expect(await verifyStampedOnDisk([join(dir, 'js', 'a.js')], hint)).toEqual([]);
  });
});

describe('verifyStampedOnDisk — when the known map is gone', () => {
  it('falls back to the bundle pointer, then reports a map the stamp named that cannot be read at all', async () => {
    await mkdir(join(dir, 'maps'));
    await writeFile(join(dir, 'a.js'), `a();\n//# sourceMappingURL=maps/current.map\n${STAMP}`);
    await writeFile(join(dir, 'maps', 'current.map'), plainMap); // the pointed map exists and lost its id
    const known = new Map([[join(dir, 'a.js'), join(dir, 'gone.map')]]);
    // the missing known map must not leave the pointed one unchecked
    expect((await verifyStampedOnDisk([join(dir, 'a.js')], known)).map((i) => i.name)).toEqual([
      join(dir, 'maps', 'current.map'),
    ]);
    await rm(join(dir, 'maps', 'current.map'));
    const lost = await verifyStampedOnDisk([join(dir, 'a.js')], known);
    expect(lost.map((i) => i.name)).toEqual([join(dir, 'gone.map')]);
    expect(lost[0]?.reason).toContain('could not be read');
    // a bundle that never had a known map is no issue
    expect(await verifyStampedOnDisk([join(dir, 'a.js')])).toEqual([]);
  });
});

describe('verifyStampedOnDisk — the known map wins over the pointer', () => {
  it('verifies the known map when both it and the pointed map exist', async () => {
    await mkdir(join(dir, 'maps'));
    await writeFile(join(dir, 'a.js'), `a();\n//# sourceMappingURL=maps/pointed.map\n${STAMP}`);
    await writeFile(join(dir, 'maps', 'pointed.map'), stampedMap);
    await writeFile(join(dir, 'maps', 'known.map'), plainMap); // lost its id: only the known map reveals it
    const known = new Map([[join(dir, 'a.js'), join(dir, 'maps', 'known.map')]]);
    expect((await verifyStampedOnDisk([join(dir, 'a.js')], known)).map((i) => i.name)).toEqual([
      join(dir, 'maps', 'known.map'),
    ]);
  });
});

describe('verifyAndRestore — a dangling pointer is not an outside map', () => {
  it('raises nothing for a pointer at a file that does not exist anywhere', async () => {
    const original = 'a();\n//# sourceMappingURL=../../nowhere/a.js.map\n';
    await mkdir(join(dir, 'out'));
    await writeFile(join(dir, 'out', 'a.js'), original);
    const snap = await snapshotStampFiles({ dir: join(dir, 'out') });
    await writeFile(join(dir, 'out', 'a.js'), `${original}${STAMP}`);
    expect(await verifyAndRestore(snap)).toEqual({ issues: [], restored: [], failed: [] });
    await snap.dispose();
  });
});

describe('ownedBy — is this file one THIS build emitted?', () => {
  it('matches by identity: normalised separators, ./ prefixes, exact case', () => {
    const own = ownedBy('/o/dist', ['src/style.css.map', './assets\\a.d.ts.map', 'Case.js.map']);
    expect(own('/o/dist/src/style.css.map')).toBe(true);
    expect(own('/o/dist/assets/a.d.ts.map')).toBe(true);
    expect(own('/o/dist/case.js.map')).toBe(false); // case-sensitive
    expect(own('/o/dist/Case.js.map')).toBe(true);
    expect(own('/o/dist/src/old.d.ts.map')).toBe(false); // there, but not emitted by this build
    expect(own('/o/dist/node_modules/p/style.css.map')).toBe(false);
  });
  it('an empty set owns nothing', () => {
    expect(ownedBy('/o', [])('/o/a.css.map')).toBe(false);
  });
  it('without a set it falls back to the directory-name fence', () => {
    const own = ownedBy('/o/dist', undefined);
    expect(own('/o/dist/src/a.css.map')).toBe(false);
    expect(own('/o/dist/.cache/a.css.map')).toBe(false);
    expect(own('/o/dist/assets/a.css.map')).toBe(true);
  });
});

describe('an uppercase A.JS / A.JS.map pair goes through snapshot, verify and restore', () => {
  it('is snapshotted, and a bad stamp is restored with its map', async () => {
    const original = 'a();\n//# sourceMappingURL=A.JS.map\n';
    await writeFile(join(dir, 'A.JS'), original);
    await writeFile(join(dir, 'A.JS.map'), plainMap);
    const snap = await snapshotStampFiles({ dir });
    expect([...snap.entries.keys()].map((k) => k.slice(dir.length + 1)).sort()).toEqual([
      'A.JS',
      'A.JS.map',
    ]);
    await writeFile(join(dir, 'A.JS'), `${original}{{${STAMP}`);
    await writeFile(join(dir, 'A.JS.map'), stampedMap);
    const { restored } = await verifyAndRestore(snap);
    expect(restored).toEqual([join(dir, 'A.JS'), join(dir, 'A.JS.map')]);
    expect(await readFile(join(dir, 'A.JS'), 'utf8')).toBe(original);
    await snap.dispose();
  });
  it('a faithful stamp of the pair verifies', async () => {
    const original = 'a();\n//# sourceMappingURL=A.JS.map\n';
    await writeFile(join(dir, 'A.JS'), original);
    await writeFile(join(dir, 'A.JS.map'), plainMap);
    const snap = await snapshotStampFiles({ dir });
    await writeFile(join(dir, 'A.JS'), `${original}${STAMP}`);
    await writeFile(join(dir, 'A.JS.map'), stampedMap);
    expect(await verifyAndRestore(snap)).toEqual({ issues: [], restored: [], failed: [] });
    await snap.dispose();
  });
});

// GROUND TRUTH (real builds): webpack/Rspack drop `?...` when they write a file (`x.js.map?h` -> `x.js.map`) and KEEP
// `#` (`a#1.js` is written as `a#1.js`). Rollup/Vite write every name literally, `?` and `#` included
// (`index.js?v=1` -> `index.js?v=1`).
describe('ownedBy — what the bundlers really write', () => {
  it('matches a webpack ?query own-name to the file on disk without the query, and a literal name to itself', () => {
    const own = ownedBy('/o/dist', ['main.js.map?abc123', 'index.js?v=1', 'index.js?v=1.map']);
    expect(own('/o/dist/main.js.map')).toBe(true); // webpack: query dropped
    expect(own('/o/dist/index.js?v=1')).toBe(true); // Rollup: written literally
    expect(own('/o/dist/index.js?v=1.map')).toBe(true);
    expect(own('/o/dist/index.js?old')).toBe(false); // a stale foreign sibling is not this build's
    expect(own('/o/dist/other.js.map')).toBe(false);
  });
  it('treats # as part of the name: a#1 is not a#2, and x#old is not x#new', () => {
    const own = ownedBy('/o/dist', ['main#new.js.map', 'a#1.js']);
    expect(own('/o/dist/main#new.js.map')).toBe(true);
    expect(own('/o/dist/main#old.js.map')).toBe(false);
    expect(own('/o/dist/main.js.map')).toBe(false);
    expect(own('/o/dist/a#1.js')).toBe(true);
    expect(own('/o/dist/a#2.js')).toBe(false);
    expect(own('/o/dist/a')).toBe(false); // nothing is cut at the #
  });
});

describe('ownedBy — Windows separators and ./ prefixes (win32 path API, on any host)', () => {
  it('matches own names written with / or \\ or a leading ./ against win32 disk paths', async () => {
    const { win32 } = await import('node:path');
    const own = ownedBy('C:\\o\\dist', ['src/a.css.map', './b.css.map', 'c\\d.css.map'], win32);
    expect(own('C:\\o\\dist\\src\\a.css.map')).toBe(true);
    expect(own('C:\\o\\dist\\b.css.map')).toBe(true);
    expect(own('C:\\o\\dist\\c\\d.css.map')).toBe(true);
    expect(own('C:\\o\\dist\\src\\other.css.map')).toBe(false);
    // the directory-name fallback uses the same API
    const fenced = ownedBy('C:\\o\\dist', undefined, win32);
    expect(fenced('C:\\o\\dist\\node_modules\\p\\a.css.map')).toBe(false);
    expect(fenced('C:\\o\\dist\\assets\\a.css.map')).toBe(true);
  });
});

describe('cutAtQuery', () => {
  it('cuts at the first ? only (a # stays), and leaves a name with no ? alone', () => {
    expect(cutAtQuery('main.js?abc?d')).toBe('main.js');
    expect(cutAtQuery('a#1.js')).toBe('a#1.js');
    expect(cutAtQuery('x.js')).toBe('x.js');
    expect(cutAtQuery('?q')).toBe('');
  });
});

describe('review hardening of the snapshot / restore / on-disk check', () => {
  it('a snapshot aborts (and removes its spill) on a read error that is NOT a missing file', async () => {
    const spillRoot = await mkdtemp(join(tmpdir(), 'bugsee-spill-abort-'));
    try {
      await mkdir(join(dir, 'adir')); // readFile(directory) -> EISDIR, not ENOENT
      await expect(snapshotStampFiles({ files: [join(dir, 'adir')] }, spillRoot)).rejects.toThrow();
      expect(await readdir(spillRoot)).toEqual([]);
    } finally {
      await rm(spillRoot, { recursive: true, force: true });
    }
  });

  it('a bundle that disappears after the change scan is skipped; the other bad pair is still restored', async () => {
    const aOriginal = 'a();\n//# sourceMappingURL=a.js.map\n';
    await writeFile(join(dir, 'a.js'), aOriginal);
    await writeFile(join(dir, 'a.js.map'), plainMap);
    await writeFile(join(dir, 'b.js'), 'b();\n//# sourceMappingURL=b.js.map\n');
    await writeFile(join(dir, 'b.js.map'), plainMap);
    // explicit order (a before b): the walk order of a directory is not guaranteed
    const snap = await snapshotStampFiles({
      files: ['a.js', 'a.js.map', 'b.js', 'b.js.map'].map((n) => join(dir, n)),
    });
    await writeFile(join(dir, 'a.js'), `${aOriginal}{{${STAMP}`);
    await writeFile(join(dir, 'b.js'), `b();\n//# sourceMappingURL=b.js.map\n${STAMP}`);
    const { rmSync } = await import('node:fs');
    let removedWhileParsingA = false;
    const result = await verifyAndRestore(snap, {
      parse: (code) => {
        // verifying a.js: b.js vanishes before its own turn
        if (code.includes('{{')) {
          rmSync(join(dir, 'b.js'), { force: true });
          removedWhileParsingA = true;
        }
        return !code.includes('{{');
      },
    });
    expect(removedWhileParsingA).toBe(true);
    expect(result.restored).not.toContain(join(dir, 'b.js'));
    expect(result.restored).toContain(join(dir, 'a.js'));
    expect(await readFile(join(dir, 'a.js'), 'utf8')).toBe(aOriginal);
    await snap.dispose();
  });

  it('the rollback partner is chosen by the ORIGINAL pointer, even if the bad stamp changed it', async () => {
    await mkdir(join(dir, 'maps'));
    const original = 'm();\n//# sourceMappingURL=maps/m.map\n';
    await writeFile(join(dir, 'm.js'), original);
    await writeFile(join(dir, 'maps', 'm.map'), plainMap);
    const snap = await snapshotStampFiles({ dir });
    // the bad stamp breaks the bundle AND points it somewhere else; the real map got stamped
    await writeFile(join(dir, 'm.js'), `m();\n//# sourceMappingURL=elsewhere.map\n{{${STAMP}`);
    await writeFile(join(dir, 'maps', 'm.map'), stampedMap);
    const { restored } = await verifyAndRestore(snap);
    expect(restored).toEqual([join(dir, 'm.js'), join(dir, 'maps', 'm.map')]);
    expect(await readFile(join(dir, 'maps', 'm.map'), 'utf8')).toBe(plainMap);
    await snap.dispose();
  });

  it('a map is NOT restored when its bundle could not be (that would leave a stamped bundle beside an unstamped map)', async () => {
    const original = 'a();\n//# sourceMappingURL=a.js.map\n';
    await writeFile(join(dir, 'a.js'), original);
    await writeFile(join(dir, 'a.js.map'), plainMap);
    await writeFile(join(dir, 'z.js'), 'z();\n//# sourceMappingURL=z.js.map\n');
    await writeFile(join(dir, 'z.js.map'), plainMap);
    const snap = await snapshotStampFiles({ dir });
    await writeFile(join(dir, 'a.js'), `${original}{{${STAMP}`);
    await writeFile(join(dir, 'a.js.map'), stampedMap);
    await writeFile(join(dir, 'z.js'), `z();\n//# sourceMappingURL=z.js.map\n{{${STAMP}`);
    await writeFile(join(dir, 'z.js.map'), stampedMap);
    const { restored, failed } = await verifyAndRestore(snap, {
      restoreFile: async (spill, target) => {
        if (target === join(dir, 'a.js')) throw new Error('EIO');
        await writeFile(target, await readFile(spill));
      },
    });
    expect(restored).toEqual([join(dir, 'z.js'), join(dir, 'z.js.map')]); // the unrelated pair still restores
    expect(failed.map((f) => f.path).sort()).toEqual([join(dir, 'a.js'), join(dir, 'a.js.map')]);
    expect(failed.find((f) => f.path === join(dir, 'a.js.map'))?.error).toContain('bundle');
    expect(await readFile(join(dir, 'a.js.map'), 'utf8')).toBe(stampedMap); // untouched, reported incomplete
    await snap.dispose();
  });

  it('verifyStampedOnDisk reports a bundle the stamp named that is missing or unreadable', async () => {
    const issues = await verifyStampedOnDisk([join(dir, 'gone.js')]);
    expect(issues).toEqual([
      { name: join(dir, 'gone.js'), reason: expect.stringContaining('could not be read') },
    ]);
  });

  it('verifyStampedOnDisk verifies the map the fallback ACTUALLY loaded when the known one is missing', async () => {
    await writeFile(join(dir, 'a.js'), `a();\n//# sourceMappingURL=a.js.map\n${STAMP}`);
    await writeFile(join(dir, 'a.js.map'), plainMap); // sibling, unkeyed
    const known = new Map([[join(dir, 'a.js'), join(dir, 'missing.map')]]);
    const issues = await verifyStampedOnDisk([join(dir, 'a.js')], known);
    expect(issues.map((i) => i.name)).toEqual([join(dir, 'a.js.map')]);
  });
});

describe('sameAsSnapshot / restorePaths', () => {
  it('sameAsSnapshot: true for an unchanged or unknown file, false for a changed or removed one', async () => {
    await writeFile(join(dir, 'a.js'), 'a();\n');
    const snap = await snapshotStampFiles({ dir });
    expect(await sameAsSnapshot(snap, join(dir, 'a.js'))).toBe(true);
    expect(await sameAsSnapshot(snap, join(dir, 'not-in-snapshot.js'))).toBe(true);
    await writeFile(join(dir, 'a.js'), 'changed');
    expect(await sameAsSnapshot(snap, join(dir, 'a.js'))).toBe(false);
    await rm(join(dir, 'a.js'));
    expect(await sameAsSnapshot(snap, join(dir, 'a.js'))).toBe(false);
    await snap.dispose();
  });

  it('restorePaths puts the originals back, skips unknown files, and returns what it could not restore', async (ctx) => {
    if (await cannotBlockWrites()) {
      ctx.skip();
    }
    await writeFile(join(dir, 'a.js'), 'orig');
    const snap = await snapshotStampFiles({ dir });
    await writeFile(join(dir, 'a.js'), 'stamped');
    expect(await restorePaths(snap, [join(dir, 'a.js'), join(dir, 'unknown.js')])).toEqual([]);
    expect(await readFile(join(dir, 'a.js'), 'utf8')).toBe('orig');
    await writeFile(join(dir, 'a.js'), 'stamped');
    await chmod(dir, 0o555);
    try {
      const failed = await restorePaths(snap, [join(dir, 'a.js')]);
      expect(failed.map((f) => f.path)).toEqual([join(dir, 'a.js')]);
    } finally {
      await chmod(dir, 0o755);
    }
    await snap.dispose();
  });
});

describe("the rollback partner is the ORIGINAL pointer's map even when the changed pointer names ANOTHER snapshotted map", () => {
  it('restores maps/m.map (original partner), not x.map (where the bad stamp pointed)', async () => {
    await mkdir(join(dir, 'maps'));
    const original = 'm();\n//# sourceMappingURL=maps/m.map\n';
    await writeFile(join(dir, 'm.js'), original);
    await writeFile(join(dir, 'maps', 'm.map'), plainMap);
    await writeFile(join(dir, 'x.map'), plainMap); // an unrelated, snapshotted map
    const snap = await snapshotStampFiles({ dir });
    await writeFile(join(dir, 'm.js'), `m();\n//# sourceMappingURL=x.map\n{{${STAMP}`);
    await writeFile(join(dir, 'maps', 'm.map'), stampedMap); // the real map got stamped
    const { restored } = await verifyAndRestore(snap);
    expect(restored).toContain(join(dir, 'maps', 'm.map'));
    expect(await readFile(join(dir, 'maps', 'm.map'), 'utf8')).toBe(plainMap);
    await snap.dispose();
  });
});
