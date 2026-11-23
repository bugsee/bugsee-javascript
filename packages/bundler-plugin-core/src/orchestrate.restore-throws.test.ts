// A rejected inject whose restore step ITSELF throws (or reports failures): the inject failure stays the
// reported error (same object, same class), with the restore problem appended, never swapped for a plain Error.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadSourcemaps } from './orchestrate';
import { BugseeCliError } from './run-cli';

const { restore } = vi.hoisted(() => ({
  restore: { mode: 'throw' as 'throw' | 'failed' },
}));
vi.mock('./stamp-files', async (importOriginal) => {
  const real = await importOriginal<typeof import('./stamp-files')>();
  return {
    ...real,
    verifyAndRestore: async () => {
      if (restore.mode === 'throw') {
        throw new Error('disk gone');
      }
      return { issues: [], restored: [], failed: [{ path: 'a.js', error: 'EPERM' }] };
    },
  };
});

describe('a rejected inject followed by a restore problem', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bugsee-r18-'));
    await writeFile(join(dir, 'a.js'), 'a();\n//# sourceMappingURL=a.js.map\n');
    await writeFile(join(dir, 'a.js.map'), '{"version":3}');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const go = (original: unknown) =>
    uploadSourcemaps({
      outDir: dir,
      appToken: 't',
      appVersion: '1',
      appBuild: '1',
      run: (async () => {
        throw original;
      }) as never,
      findSri: async () => [],
      failOnError: true,
      ownFiles: ['a.js', 'a.js.map'],
    });

  it.each([
    'throw',
    'failed',
  ] as const)('keeps the original BugseeCliError object when the restore %s', async (mode) => {
    restore.mode = mode;
    const original = new BugseeCliError('inject died', 3, 'stderr');
    const caught = await go(original).catch((e: unknown) => e);
    expect(caught).toBe(original);
    expect(caught).toBeInstanceOf(BugseeCliError);
    expect((caught as BugseeCliError).code).toBe(3);
    expect((caught as Error).message).toContain('inject died');
    expect((caught as Error).message).toContain(
      mode === 'throw' ? 'restoring the originals also failed: disk gone' : 'EPERM',
    );
  });

  it('wraps a non-Error rejection, keeping it as the cause', async () => {
    restore.mode = 'throw';
    const caught = await go('plain string').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBe('plain string');
    expect((caught as Error).message).toContain('plain string');
    expect((caught as Error).message).toContain('disk gone');
  });
});
