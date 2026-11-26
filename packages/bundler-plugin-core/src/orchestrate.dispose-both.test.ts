// Both spill directories (the stamp's and the re-seal's) must be removed even when removing the first fails: a failed
// cleanup of one must not leave a second copy of every bundle and map behind.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadSourcemaps } from './orchestrate';

const disposed: string[] = [];
vi.mock('./stamp-files', async (importOriginal) => {
  const real = await importOriginal<typeof import('./stamp-files')>();
  return {
    ...real,
    snapshotStampFiles: async (...args: Parameters<typeof real.snapshotStampFiles>) => {
      const snapshot = await real.snapshotStampFiles(...args);
      const dispose = snapshot.dispose;
      snapshot.dispose = async () => {
        disposed.push(snapshot.spillDir);
        await dispose();
        throw new Error(`EBUSY: ${snapshot.spillDir}`);
      };
      return snapshot;
    },
  };
});

describe('both spill cleanups are attempted', () => {
  let dir: string;
  beforeEach(async () => {
    disposed.length = 0;
    dir = await mkdtemp(join(tmpdir(), 'bugsee-dispose-both-'));
    await writeFile(join(dir, 'w.js'), 'w();\n');
    await writeFile(
      join(dir, 'index.html'),
      `<script src="w.js" integrity="sha384-${'A'.repeat(64)}"></script>`,
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('removes the second spill even though the first removal failed, and reports each failure', async () => {
    const errors: unknown[] = [];
    await uploadSourcemaps({
      outDir: dir,
      appToken: 't',
      appVersion: '1',
      appBuild: '1',
      resealSri: true,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      reseal: async () => ({ files: [] }),
      verifySri: async () => [],
      verifyDigests: async () => [],
      onError: (e) => errors.push(e),
    });
    expect(new Set(disposed).size).toBe(2); // the stamp's snapshot AND the re-seal's
    const text = errors.map(String).join('\n');
    for (const spill of disposed) {
      expect(text).toContain(spill);
    }
  });
});
