import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writevSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CaptureStore,
  createDiskPressure,
  createFileCaptureStore,
  type StoredEntry,
} from '@bugsee/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createBatchedFsChunkStorage } from './batched-fs-chunk-storage';
import { writeFileSecure } from './fs-storage';

// The REAL writer (the batched fs storage the node launch uses) under a refusing disk. Unlike a fake whose `append`
// throws, the real writer never throws into the caller: it buffers, reports asynchronously and retries. These tests
// pin what that means for the gate: no record may be lost from the live window, the pin must survive until a write
// succeeds, and the probe is what releases it.

const MB = 1024 * 1024;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mkRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'bugsee-pressure-int-'));
  dirs.push(d);
  return d;
};
const full = (): Error =>
  Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
const rec = (i: number, type: StoredEntry['type'] = 'log'): StoredEntry => ({
  type,
  timestamp: i,
  serialized: `${type}-${i}`,
});
const live = async (store: CaptureStore, type: StoredEntry['type']): Promise<string[]> => {
  const snap = store.snapshot();
  const all = await snap.drainAll();
  snap.release();
  return (all.get(type) ?? []).map((r) => r.serialized);
};

function rig(storageOver: Parameters<typeof createBatchedFsChunkStorage>[1] = {}) {
  const root = mkRoot();
  const pressure = createDiskPressure();
  const state = { refusing: false };
  const failures: unknown[] = [];
  const storage = createBatchedFsChunkStorage(root, {
    highWaterMark: 64,
    failureThreshold: 1000,
    onError: () => {},
    onWriteFailure: (e) => {
      failures.push(e);
      pressure.noteWriteError(e);
    },
    onWriteRecovered: () => pressure.noteWriteRecovered(),
    writev: (fd, bufs) => {
      if (state.refusing) throw full();
      return writevSync(fd, bufs);
    },
    // a full disk refuses the meta writes as well
    writeFile: (path, data) => {
      if (state.refusing) throw full();
      writeFileSecure(path, data);
    },
    ...storageOver,
  });
  const store = createFileCaptureStore(storage, {
    clock: { wallNow: () => 1000, monotonicNow: () => 0 },
    generation: 1,
    diskPressure: pressure,
  });
  return { root, pressure, state, failures, storage, store };
}

describe('disk pressure over the REAL batched writer', () => {
  it('ENOSPC at a high-water flush loses NOTHING from the live window (the buffered tail is counted by the gate)', async () => {
    const r = rig();
    for (let i = 0; i < 20; i++) r.store.add(rec(i));
    r.state.refusing = true;
    for (let i = 20; i < 200; i++) r.store.add(rec(i));
    const got = await live(r.store, 'log');
    expect(got).toEqual(Array.from({ length: 200 }, (_, i) => `log-${i}`));
    expect(r.pressure.level()).toBe('none'); // every failure reached the pin
    expect(r.failures.length).toBeGreaterThan(0);
  });

  it('once pinned, new records are held in memory; the pin survives healthy size readings and a probe releases it', async () => {
    const r = rig();
    r.store.add(rec(0));
    r.state.refusing = true;
    r.store.add(rec(1));
    r.store.add(rec(2)); // reaches the writer: refused
    r.store.tick(2000); // pinned: the probe is refused too
    expect(r.pressure.level()).toBe('none');
    r.pressure.observe(900 * MB); // a healthy size reading does not undo a refused write
    expect(r.pressure.level()).toBe('none');
    r.store.add(rec(3));
    r.state.refusing = false;
    r.store.tick(3000); // the probe's meta write succeeds: the pin is released
    expect(r.pressure.level()).toBe('normal');
    r.store.add(rec(4));
    r.storage.flushSync?.();
    expect(await live(r.store, 'log')).toEqual(['log-0', 'log-1', 'log-2', 'log-3', 'log-4']);
  });

  it('a medium that keeps refusing stays pinned across many ticks (it cannot flap back to normal)', async () => {
    const r = rig();
    r.state.refusing = true;
    r.store.add(rec(0));
    r.store.add(rec(1));
    for (let t = 1; t <= 5; t++) {
      r.store.tick(1000 + t * 1000);
      r.pressure.observe(900 * MB);
      r.store.add(rec(10 * t));
    }
    expect(r.pressure.level()).toBe('none');
    expect((await live(r.store, 'log')).length).toBe(7);
  });
});

// A REAL full disk: a tiny APFS image on macOS. Skipped where `hdiutil` does not exist (CI Linux, Windows): mounting a
// small tmpfs on Linux needs root, which the CI job and a developer shell do not have. Run on a Mac to verify for real.
const canMakeTinyDisk = process.platform === 'darwin' && existsSync('/usr/bin/hdiutil');
describe.skipIf(!canMakeTinyDisk)(
  'disk pressure on a REAL full disk (macOS: an 8 MB APFS image)',
  () => {
    it('no record is lost from the live window when the volume fills, and the pin releases once space returns', async () => {
      const base = mkRoot();
      const image = join(base, 'tiny.dmg');
      const mount = join(base, 'mnt');
      mkdirSync(mount);
      execFileSync(
        '/usr/bin/hdiutil',
        ['create', '-size', '8m', '-fs', 'APFS', '-volname', 'bugseetiny', image],
        {
          stdio: 'ignore',
        },
      );
      execFileSync('/usr/bin/hdiutil', ['attach', image, '-mountpoint', mount, '-nobrowse'], {
        stdio: 'ignore',
      });
      try {
        const pressure = createDiskPressure();
        const storage = createBatchedFsChunkStorage(join(mount, 'cap'), {
          highWaterMark: 4096,
          failureThreshold: 1000,
          onError: () => {},
          onWriteFailure: (e) => void pressure.noteWriteError(e),
          onWriteRecovered: () => pressure.noteWriteRecovered(),
        });
        const store = createFileCaptureStore(storage, {
          clock: { wallNow: () => 1000, monotonicNow: () => 0 },
          generation: 1,
          diskPressure: pressure,
        });
        const payload = 'x'.repeat(2000);
        const total = 6000; // ~12 MB: more than the volume holds
        for (let i = 0; i < total; i++) {
          store.add({ type: 'log', timestamp: i, serialized: `${i}:${payload}` });
          if (i % 500 === 0) store.tick(1000 + i);
        }
        storage.flushSync?.();
        expect(pressure.level()).toBe('none'); // a real ENOSPC reached the pin
        const snap = store.snapshot();
        const all = await snap.drainAll();
        snap.release();
        expect(all.get('log')?.length).toBe(total); // nothing lost from the live window
        // free the space (drop everything on the volume), then the probe's success releases the pin
        rmSync(join(mount, 'cap'), { recursive: true, force: true });
        store.tick(999_999);
        store.tick(1_000_000);
        expect(pressure.level()).toBe('normal');
        storage.dispose?.();
      } finally {
        try {
          execFileSync('/usr/bin/hdiutil', ['detach', mount, '-force'], { stdio: 'ignore' });
        } catch {
          // already gone
        }
      }
    }, 60_000);
  },
);
