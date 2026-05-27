import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSecure,
  ensureDir,
  listFiles,
  readFileBytes,
  remove,
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
