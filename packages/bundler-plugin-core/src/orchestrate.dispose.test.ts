// A catch-up whose rewrite could NOT be restored returns a strict failure; a spill removal that then fails must
// be reported as a diagnostic and must NOT replace that failure (failOnError has to stop the build).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadSourcemaps } from './orchestrate';

vi.mock('./stamp-files', async (importOriginal) => {
  const real = await importOriginal<typeof import('./stamp-files')>();
  return {
    ...real,
    snapshotStampFiles: async (...args: Parameters<typeof real.snapshotStampFiles>) => {
      const snapshot = await real.snapshotStampFiles(...args);
      const dispose = snapshot.dispose;
      snapshot.dispose = async () => {
        await dispose();
        throw new Error('EBUSY: spill removal failed');
      };
      return snapshot;
    },
    verifyAndRestore: async () => ({
      issues: [{ name: 'w.js', reason: 'did not verify' }],
      restored: [],
      failed: [{ path: 'w.js', error: 'EPERM' }],
    }),
  };
});

describe('catch-up: a failed spill removal does not mask a strict verification failure', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bugsee-dispose-'));
    await writeFile(join(dir, 'w.js'), 'w();\n//# sourceMappingURL=w.js.map\n');
    await writeFile(join(dir, 'w.js.map'), '{"version":3,"sources":[],"mappings":""}');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const go = (failOnError: boolean, errors: unknown[]) =>
    uploadSourcemaps({
      outDir: dir,
      appToken: 't',
      appVersion: '1',
      appBuild: '1',
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      preStamped: true,
      verifySri: async () => [],
      findSri: async () => [],
      onNotice: () => undefined,
      onError: (e) => errors.push(e),
      failOnError,
      ownFiles: ['w.js', 'w.js.map'],
    });

  it('failOnError: still rejects with the verification failure; the removal failure is reported', async () => {
    const errors: unknown[] = [];
    await expect(go(true, errors)).rejects.toThrow(/did not verify|could not be restored|EPERM/);
    expect(errors.map(String).join('\n')).toContain('EBUSY');
  });

  it('without failOnError: the removal failure is reported, nothing throws', async () => {
    const errors: unknown[] = [];
    await go(false, errors);
    expect(errors.map(String).join('\n')).toContain('EBUSY');
  });
});
