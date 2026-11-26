import { constants as bufferConstants } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { READ_CEILING, readRegularFile } from './safe-read';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugsee-safe-read-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readRegularFile ceiling (the largest string Node can build)', () => {
  it('a limit above the ceiling is clamped to it: a bigger file is "too large", not a later decode failure', async () => {
    writeFileSync(join(dir, 'a'), 'hello');
    // an injected small ceiling stands in for buffer.constants.MAX_STRING_LENGTH (a 512 MiB file cannot be made here)
    expect(await readRegularFile(join(dir, 'a'), Number.POSITIVE_INFINITY, 4)).toEqual({
      ok: false,
      reason: 'is too large to read',
      tooLarge: { size: 5 },
    });
    expect((await readRegularFile(join(dir, 'a'), 1000, 5)).ok).toBe(true); // equal to the ceiling reads
    expect((await readRegularFile(join(dir, 'a'), 4, 1000)).ok).toBe(false); // the caller's lower limit still applies
    expect((await readRegularFile(join(dir, 'a'), Number.POSITIVE_INFINITY)).ok).toBe(true);
    expect(READ_CEILING).toBe(bufferConstants.MAX_STRING_LENGTH); // the default really is the string limit
  });
});

describe('readRegularFile', () => {
  it('reads a regular file, including an empty one', async () => {
    writeFileSync(join(dir, 'a'), 'hello');
    writeFileSync(join(dir, 'empty'), '');
    const read = await readRegularFile(join(dir, 'a'), 100);
    expect(read.ok && read.bytes.toString()).toBe('hello');
    const empty = await readRegularFile(join(dir, 'empty'), 100);
    expect(empty.ok && empty.bytes.length).toBe(0);
  });

  it('the limit is exact: equal reads, one over is too large (judged by the size, before reading)', async () => {
    writeFileSync(join(dir, 'a'), 'hello');
    expect((await readRegularFile(join(dir, 'a'), 5)).ok).toBe(true);
    expect(await readRegularFile(join(dir, 'a'), 4)).toEqual({
      ok: false,
      reason: 'is too large to read',
      tooLarge: { size: 5 },
    });
  });

  it('a symlink in the last component is refused, not followed', async () => {
    writeFileSync(join(dir, 'real'), 'x');
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(await readRegularFile(join(dir, 'link'), 100)).toEqual({
      ok: false,
      reason: 'is a symbolic link',
    });
  });

  it('a FIFO is refused without blocking; a device is refused without reading', async () => {
    if (spawnSync('mkfifo', [join(dir, 'pipe')]).status === 0) {
      expect(await readRegularFile(join(dir, 'pipe'), 100)).toEqual({
        ok: false,
        reason: 'is not a regular file',
      });
    }
    expect(await readRegularFile('/dev/zero', 100)).toEqual({
      ok: false,
      reason: 'is not a regular file',
    });
  }, 10_000);

  it('a directory is not a regular file; a missing or unreadable file is a value, not a throw', async () => {
    mkdirSync(join(dir, 'd'));
    expect(await readRegularFile(join(dir, 'd'), 100)).toEqual({
      ok: false,
      reason: 'is not a regular file',
    });
    expect(await readRegularFile(join(dir, 'missing'), 100)).toEqual({
      ok: false,
      reason: 'could not be read (ENOENT)',
    });
    if (process.getuid?.() !== 0) {
      writeFileSync(join(dir, 'locked'), 'x');
      chmodSync(join(dir, 'locked'), 0o000);
      expect(await readRegularFile(join(dir, 'locked'), 100)).toEqual({
        ok: false,
        reason: 'could not be read (EACCES)',
      });
    }
  });
});
