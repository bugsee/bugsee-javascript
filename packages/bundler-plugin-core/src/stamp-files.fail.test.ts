import { mkdtemp, readdir, writeFile as realWriteFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadSourcemaps } from './orchestrate';

// A disk that fills up while the originals are being spilled (ENOSPC).
const { failSpill } = vi.hoisted(() => ({ failSpill: { on: false, rm: false } }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rm: (async (path: string, ...rest: unknown[]) => {
      if (failSpill.rm && String(path).includes('bugsee-orig-')) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return (real.rm as (...a: unknown[]) => Promise<void>)(path, ...rest);
    }) as typeof real.rm,
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
  failSpill.rm = false;
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

describe('a spill directory that cannot be removed (EPERM / EBUSY)', () => {
  const ok = async () => ({ code: 0, stdout: '', stderr: '' });
  const base = () => ({
    outDir: dir,
    appToken: 'tok',
    appVersion: '1',
    appBuild: '1',
    run: ok,
    deleteMaps: false,
    findSri: async () => [],
  });

  it('never fails a build whose upload succeeded: reported, not thrown (even under failOnError)', async () => {
    failSpill.on = false;
    failSpill.rm = true;
    const errors: unknown[] = [];
    const result = await uploadSourcemaps({
      ...base(),
      spillRoot,
      failOnError: true,
      onError: (e) => errors.push(e),
    });
    expect(result.uploaded).toBe(true);
    expect(String(errors[0])).toContain('EPERM');
    expect(String(errors[0])).toContain('spill');
    failSpill.rm = false;
  });

  it('does not mask the error that was already being reported', async () => {
    failSpill.on = false;
    failSpill.rm = true;
    const errors: unknown[] = [];
    const result = await uploadSourcemaps({
      ...base(),
      spillRoot,
      run: async () => {
        throw new Error('cli exploded');
      },
      onError: (e) => errors.push(e),
    });
    expect(result.uploaded).toBe(false);
    expect(errors.map(String).join('|')).toContain('cli exploded');
    expect(errors.map(String).join('|')).toContain('EPERM');
    failSpill.rm = false;
  });
});
