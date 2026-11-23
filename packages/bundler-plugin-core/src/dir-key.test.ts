import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dirKey } from './resolve';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'bugsee-dirkey-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('dirKey', () => {
  it('is one key for every spelling of an existing directory', () => {
    const dist = join(root, 'dist');
    mkdirSync(dist);
    const link = join(root, 'link');
    symlinkSync(dist, link);
    const spellings = [
      dist,
      `${dist}/`,
      link,
      join(dist, '..', 'dist'),
      relative(process.cwd(), dist),
    ];
    for (const s of spellings) {
      expect(dirKey(s)).toBe(dist);
    }
  });

  it('keys a directory that does not exist yet the same as once it does (real path of the existing ancestor)', () => {
    const link = join(root, 'plink');
    const real = join(root, 'preal');
    mkdirSync(real);
    symlinkSync(real, link);
    const before = dirKey(join(link, 'out', 'deep'));
    expect(before).toBe(join(real, 'out', 'deep'));
    mkdirSync(join(real, 'out', 'deep'), { recursive: true });
    expect(dirKey(join(link, 'out', 'deep'))).toBe(before);
  });

  it('follows a symlink whose target does not exist yet, to the same key as once it does', () => {
    const real = join(root, 'later');
    const link = join(root, 'dangling');
    symlinkSync(real, link);
    const chain = join(root, 'chain');
    symlinkSync(link, chain); // a link to a dangling link
    expect(dirKey(link)).toBe(real);
    expect(dirKey(join(chain, 'sub'))).toBe(join(real, 'sub'));
    mkdirSync(real);
    expect(dirKey(link)).toBe(real);
  });

  it('resolves a RELATIVE dangling symlink target against the link directory', () => {
    mkdirSync(join(root, 'holder'));
    symlinkSync('../rel-later', join(root, 'holder', 'rel'));
    expect(dirKey(join(root, 'holder', 'rel'))).toBe(join(root, 'rel-later'));
  });

  it('does not loop forever on a symlink cycle', () => {
    const a = join(root, 'cyc-a');
    const b = join(root, 'cyc-b');
    symlinkSync(b, a);
    symlinkSync(a, b);
    expect(typeof dirKey(a)).toBe('string');
  });

  it('folds case on a case-insensitive filesystem (canonical on-disk spelling)', (ctx) => {
    const dir = join(root, 'CaseDir');
    mkdirSync(dir);
    if (!existsSync(join(root, 'casedir'))) {
      ctx.skip(); // case-sensitive filesystem: two spellings really are two directories
    }
    expect(dirKey(join(root, 'casedir'))).toBe(dirKey(dir));
    expect(dirKey(join(root, 'CASEDIR', 'sub'))).toBe(join(dirKey(dir), 'sub'));
  });

  it('falls back to the resolved path when nothing on the way can be resolved', () => {
    expect(dirKey('/')).toBe(realpathSync('/'));
  });
});
