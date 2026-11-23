import { mkdtemp, readdir, writeFile as realWriteFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadSourcemaps } from './orchestrate';

// A disk that fills up while the originals are being spilled (ENOSPC).
const { failSpill } = vi.hoisted(() => ({ failSpill: { on: false } }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    writeFile: (async (path: string, ...rest: unknown[]) => {
      if (failSpill.on && String(path).includes('bugsee-orig-')) {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return (real.writeFile as (...a: unknown[]) => Promise<void>)(path, ...rest);
    }) as typeof real.writeFile,
  };
});

let dir: string;
let spillRoot: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bugsee-fail-'));
  spillRoot = await mkdtemp(join(tmpdir(), 'bugsee-failspill-'));
  await realWriteFile(join(dir, 'a.js'), 'a();\n');
  failSpill.on = true;
});
afterEach(async () => {
  failSpill.on = false;
  await rm(dir, { recursive: true, force: true });
  await rm(spillRoot, { recursive: true, force: true });
});

describe('a snapshot that fails midway', () => {
  it('removes its spill directory, runs NO inject (an unverifiable stamp is not applied) and reports it', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const errors: unknown[] = [];
    const result = await uploadSourcemaps({
      outDir: dir,
      appToken: 'tok',
      appVersion: '1',
      appBuild: '1',
      run,
      spillRoot,
      findSri: async () => [],
      onError: (e) => errors.push(e),
    });
    expect(await readdir(spillRoot)).toEqual([]); // nothing leaked
    expect(run).not.toHaveBeenCalled();
    expect(String(errors[0])).toContain('ENOSPC');
    expect(result).toMatchObject({ injected: false, uploaded: false });
  });

  it('throws under failOnError', async () => {
    await expect(
      uploadSourcemaps({
        outDir: dir,
        appToken: 'tok',
        appVersion: '1',
        appBuild: '1',
        run: vi.fn(),
        spillRoot,
        findSri: async () => [],
        failOnError: true,
      }),
    ).rejects.toThrow(/ENOSPC/);
    expect(await readdir(spillRoot)).toEqual([]);
  });
});
