import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSecure,
  ensureDir,
  listFiles,
  readFileBytes,
  remove,
  writeFileAtomic,
  writeFileExclusive,
  writeFileSecure,
} from './fs-storage';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bugsee-fs-test-'));
});

afterEach(() => {
  remove(root);
});

// owner-only (0o600 file / 0o700 dir): no permission bits for group/other.
const ownerOnly = (path: string): boolean => (statSync(path).mode & 0o077) === 0;

describe('ensureDir', () => {
  it('creates a nested directory tree owner-only', () => {
    const dir = join(root, 'a', 'b', 'c');
    ensureDir(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(ownerOnly(dir)).toBe(true);
  });

  it('is idempotent (no throw when the directory already exists)', () => {
    const dir = join(root, 'x');
    ensureDir(dir);
    expect(() => ensureDir(dir)).not.toThrow();
  });
});

describe('writeFileExclusive', () => {
  it('creates the file and reports that it won the claim', () => {
    const file = join(root, 'claim');
    expect(writeFileExclusive(file, 'first')).toBe(true);
    expect(readFileBytes(file)).toEqual(new TextEncoder().encode('first'));
  });

  it('reports LOST without touching an existing file — the whole point of the primitive', () => {
    const file = join(root, 'claim');
    writeFileSecure(file, 'first');
    expect(writeFileExclusive(file, 'second')).toBe(false);
    // The loser must not clobber the winner's content, or two claimants both believe they hold it.
    expect(readFileBytes(file)).toEqual(new TextEncoder().encode('first'));
  });

  it('is owner-only, like every other write here', () => {
    const file = join(root, 'claim');
    writeFileExclusive(file, 'x');
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it('THROWS on a real failure rather than reporting a lost claim', () => {
    // EEXIST means "someone else holds it"; anything else (ENOENT on a missing directory here) is a
    // genuine fault, and swallowing it as `false` would silently disable claiming altogether.
    expect(() => writeFileExclusive(join(root, 'nope', 'claim'), 'x')).toThrow();
  });
});

describe('writeFileSecure', () => {
  it('writes string content owner-only', () => {
    const file = join(root, 'f.txt');
    writeFileSecure(file, 'hello');
    expect(readFileBytes(file) && Buffer.from(readFileBytes(file) as Uint8Array).toString()).toBe(
      'hello',
    );
    expect(ownerOnly(file)).toBe(true);
  });

  it('writes Uint8Array content and overwrites an existing file', () => {
    const file = join(root, 'g.bin');
    writeFileSecure(file, new Uint8Array([1, 2, 3]));
    writeFileSecure(file, new Uint8Array([9]));
    expect([...(readFileBytes(file) as Uint8Array)]).toEqual([9]);
  });
});

describe('appendFileSecure', () => {
  it('appends to a file, creating it owner-only on first write', () => {
    const file = join(root, 'log.jsonl');
    appendFileSecure(file, 'line1\n');
    appendFileSecure(file, 'line2\n');
    expect(Buffer.from(readFileBytes(file) as Uint8Array).toString()).toBe('line1\nline2\n');
    expect(ownerOnly(file)).toBe(true);
  });
});

describe('readFileBytes', () => {
  it('returns the bytes of an existing file', () => {
    const file = join(root, 'r.txt');
    writeFileSecure(file, 'data');
    expect(Buffer.from(readFileBytes(file) as Uint8Array).toString()).toBe('data');
  });

  it('returns undefined for a missing file', () => {
    expect(readFileBytes(join(root, 'nope.txt'))).toBeUndefined();
  });

  it('rethrows non-ENOENT errors (e.g. reading a directory)', () => {
    expect(() => readFileBytes(root)).toThrow();
  });
});

describe('listFiles', () => {
  it('lists file names in a directory', () => {
    writeFileSecure(join(root, 'a.txt'), '1');
    writeFileSecure(join(root, 'b.txt'), '2');
    expect(listFiles(root).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('returns an empty array for a missing directory', () => {
    expect(listFiles(join(root, 'missing'))).toEqual([]);
  });

  it('rethrows non-ENOENT errors (e.g. listing a file as a directory)', () => {
    const file = join(root, 'notdir.txt');
    writeFileSecure(file, 'x');
    expect(() => listFiles(file)).toThrow();
  });
});

describe('remove', () => {
  it('deletes a file', () => {
    const file = join(root, 'del.txt');
    writeFileSecure(file, 'x');
    remove(file);
    expect(readFileBytes(file)).toBeUndefined();
  });

  it('deletes a directory tree recursively', () => {
    const dir = join(root, 'tree');
    mkdirSync(dir);
    writeFileSync(join(dir, 'inner.txt'), 'x');
    remove(dir);
    expect(listFiles(dir)).toEqual([]);
  });

  it('does not throw when the path is missing', () => {
    expect(() => remove(join(root, 'ghost'))).not.toThrow();
  });
});

describe('writeFileAtomic', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bugsee-atomic-'));
  });
  afterEach(() => {
    chmodSync(dir, 0o700); // restore so the temp dir can be cleaned up
  });

  it('writes the bytes, owner-only', () => {
    const file = join(dir, 'a.bundle');
    writeFileAtomic(file, new Uint8Array([1, 2, 3]));
    expect(readFileBytes(file)).toEqual(new Uint8Array([1, 2, 3]));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp file behind on success', () => {
    writeFileAtomic(join(dir, 'a.bundle'), new Uint8Array([1]));
    expect(readdirSync(dir)).toEqual(['a.bundle']);
  });

  it('does NOT damage the existing file when the write fails', () => {
    // The property that matters. A bundle is written to a DETERMINISTIC final name, and recovery treats
    // that name as a complete artifact: `readFrame` parses the header and uploads whatever body follows.
    // A plain `writeFileSync` truncates the target before it writes, so a failure part-way leaves a
    // parseable header over a truncated body — a corrupt bundle that recovery then uploads as if valid.
    // Writing to a temp sibling and renaming means the final name only ever refers to a complete file.
    const file = join(dir, 'a.bundle');
    writeFileAtomic(file, new Uint8Array([1, 2, 3]));
    chmodSync(dir, 0o500); // no new entries may be created — the temp write fails
    expect(() => writeFileAtomic(file, new Uint8Array([9, 9, 9, 9]))).toThrow();
    // The file itself is still writable (0o600), so a non-atomic write WOULD have clobbered it here.
    expect(readFileBytes(file)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('leaves no temp file behind on failure', () => {
    const file = join(dir, 'a.bundle');
    writeFileAtomic(file, new Uint8Array([1]));
    const sub = join(dir, 'sub');
    mkdirSync(sub, { mode: 0o700 });
    chmodSync(sub, 0o500);
    expect(() => writeFileAtomic(join(sub, 'b.bundle'), new Uint8Array([2]))).toThrow();
    chmodSync(sub, 0o700);
    expect(readdirSync(sub)).toEqual([]);
  });
});
