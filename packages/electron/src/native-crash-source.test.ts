import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CrashpadSessionMarker } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CrashDumpFs,
  createElectronNativeCrashSource,
  createNodeCrashDumpFs,
} from './native-crash-source';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const marker = (dumpDir = '/crashpad/db'): CrashpadSessionMarker => ({
  generation: 1,
  sessionId: 'sess-1',
  dumpDir,
  attributes: {},
  userIdentifier: null,
});

/** An in-memory Crashpad DB fs over a { path -> bytes } map (dirs are the union of file parents). */
function fakeFs(files: Record<string, number[]>): CrashDumpFs & { removed: string[] } {
  const store = new Map(Object.entries(files).map(([p, b]) => [p, new Uint8Array(b)]));
  const removed: string[] = [];
  return {
    removed,
    exists: (p: string) =>
      store.has(p) || [...store.keys()].some((k) => k.startsWith(`${p}/`)),
    readdir: (dir: string) => {
      const prefix = `${dir}/`;
      const names = [...store.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map((k) => k.slice(prefix.length));
      if (names.length === 0) {
        throw new Error(`ENOENT ${dir}`); // real readdirSync throws on a missing dir
      }
      return names;
    },
    readFile: (p: string) => {
      const b = store.get(p);
      if (b === undefined) throw new Error(`ENOENT ${p}`);
      return b;
    },
    unlink: (p: string) => {
      store.delete(p);
      removed.push(p);
    },
  };
}

describe('createElectronNativeCrashSource', () => {
  it('harvests every completed .dmp under <dumpDir>/completed as name + bytes', () => {
    const fs = fakeFs({
      '/crashpad/db/completed/a.dmp': [1, 2],
      '/crashpad/db/completed/b.dmp': [3],
      '/crashpad/db/completed/settings.dat': [9], // not a dump
    });
    const source = createElectronNativeCrashSource({ fs });

    const dumps = source.harvest(marker());

    expect(dumps.map((d) => d.name).sort()).toEqual(['a.dmp', 'b.dmp']);
    expect(Array.from(dumps.find((d) => d.name === 'a.dmp')!.data)).toEqual([1, 2]);
    expect(Array.from(dumps.find((d) => d.name === 'b.dmp')!.data)).toEqual([3]);
  });

  it('returns [] when the completed dir does not exist (no crash yet)', () => {
    const source = createElectronNativeCrashSource({ fs: fakeFs({}) });
    expect(source.harvest(marker())).toEqual([]);
  });

  it('reads dumps from the marker’s OWN dumpDir (not a hardcoded path)', () => {
    const fs = fakeFs({ '/other/dir/completed/x.dmp': [7] });
    const dumps = createElectronNativeCrashSource({ fs }).harvest(marker('/other/dir'));
    expect(dumps.map((d) => d.name)).toEqual(['x.dmp']);
  });

  it('claim() unlinks the delivered dump from the completed dir', () => {
    const fs = fakeFs({ '/crashpad/db/completed/a.dmp': [1] });
    const source = createElectronNativeCrashSource({ fs });
    source.claim(marker(), 'a.dmp');
    expect(fs.removed).toEqual(['/crashpad/db/completed/a.dmp']);
    expect(fs.exists('/crashpad/db/completed/a.dmp')).toBe(false);
  });

  it('claim() is a no-op when the dump is already gone', () => {
    const fs = fakeFs({});
    const source = createElectronNativeCrashSource({ fs });
    expect(() => source.claim(marker(), 'a.dmp')).not.toThrow();
    expect(fs.removed).toEqual([]);
  });

  it('ignores non-.dmp entries entirely', () => {
    const fs = fakeFs({
      '/crashpad/db/completed/report.meta': [1],
      '/crashpad/db/completed/x.dmp.lock': [2],
    });
    expect(createElectronNativeCrashSource({ fs }).harvest(marker())).toEqual([]);
  });

  it('createNodeCrashDumpFs round-trips a real Crashpad dir end to end (readdir/readFile/exists/unlink)', () => {
    const root = mkdtempSync(join(tmpdir(), 'bugsee-crashpad-'));
    tmpDirs.push(root);
    mkdirSync(join(root, 'completed'), { recursive: true });
    writeFileSync(join(root, 'completed', 'crash.dmp'), Buffer.from([10, 20, 30]));
    const source = createElectronNativeCrashSource({ fs: createNodeCrashDumpFs() });
    const m = marker(root);

    const dumps = source.harvest(m);
    expect(dumps.map((d) => d.name)).toEqual(['crash.dmp']);
    expect(Array.from(dumps[0]!.data)).toEqual([10, 20, 30]); // real readFile bytes

    source.claim(m, 'crash.dmp'); // real unlink
    expect(existsSync(join(root, 'completed', 'crash.dmp'))).toBe(false);
    expect(source.harvest(m)).toEqual([]); // dir now empty → nothing to re-harvest
  });

  it('composes paths via the injected join (completed dir + per-dump path), not a hardcoded separator', () => {
    const join = vi.fn((...p: string[]) => p.join('/'));
    const fs = fakeFs({ '/crashpad/db/completed/a.dmp': [5] });
    const source = createElectronNativeCrashSource({ fs, join });
    expect(source.harvest(marker()).map((d) => d.name)).toEqual(['a.dmp']);
    expect(join).toHaveBeenCalledWith('/crashpad/db', 'completed'); // dir composed via join
    source.claim(marker(), 'a.dmp');
    expect(join).toHaveBeenCalledWith('/crashpad/db', 'completed', 'a.dmp'); // dump path via join
  });
});
