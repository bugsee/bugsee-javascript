import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isProjectRootOrAbove,
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
  it('is true for a directory holding a package.json, the cwd, and any ancestor of the cwd', async () => {
    await writeFile(join(dir, 'package.json'), '{}');
    expect(await isProjectRootOrAbove(dir)).toBe(true);
    expect(await isProjectRootOrAbove(process.cwd())).toBe(true);
    expect(await isProjectRootOrAbove(dirname(process.cwd()))).toBe(true);
    expect(await isProjectRootOrAbove('.')).toBe(true);
  });
  it('is false for an ordinary output directory', async () => {
    await mkdir(join(dir, 'dist'));
    expect(await isProjectRootOrAbove(join(dir, 'dist'))).toBe(false);
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
  it('a bundle with no map at all is left alone', async () => {
    await writeFile(join(dir, 'a.js'), 'a();\n');
    expect(await verifyStampedOnDisk([join(dir, 'a.js')])).toEqual([]);
  });
});
