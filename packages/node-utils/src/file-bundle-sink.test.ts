import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileBundleSink, sweepStaleExports } from './file-bundle-sink';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugsee-sink-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const collect = async (iterable: AsyncIterable<Uint8Array>): Promise<number[]> => {
  const out: number[] = [];
  for await (const chunk of iterable) out.push(...chunk);
  return out;
};

describe('createFileBundleSink', () => {
  it('writes chunks to a file under the directory and finishes with a file-backed body', async () => {
    const writer = await createFileBundleSink(join(dir, 'export')).open();
    await writer.write(new Uint8Array([1, 2]));
    await writer.write(new Uint8Array([3, 4, 5]));
    const body = await writer.finish();
    expect(body.size).toBe(5);
    expect(readdirSync(join(dir, 'export'))).toHaveLength(1);
    expect(await collect(body.stream())).toEqual([1, 2, 3, 4, 5]);
    expect(await collect(body.stream())).toEqual([1, 2, 3, 4, 5]); // restartable
    expect(Array.from(await body.bytes())).toEqual([1, 2, 3, 4, 5]);
    expect(body.peek()).toBeUndefined();
    await body.ready?.();
    await body.dispose();
    expect(readdirSync(join(dir, 'export'))).toHaveLength(0);
    await body.dispose(); // repeatable
  });

  it('creates the directory owner-only and the file mode 0o600', async () => {
    const sink = createFileBundleSink(join(dir, 'a', 'b'));
    const writer = await sink.open();
    await writer.write(new Uint8Array([1]));
    const body = await writer.finish();
    expect(statSync(join(dir, 'a', 'b')).mode & 0o777).toBe(0o700);
    const [name] = readdirSync(join(dir, 'a', 'b'));
    expect(statSync(join(dir, 'a', 'b', name as string)).mode & 0o777).toBe(0o600);
    await body.dispose();
  });

  it('abort deletes the partial file', async () => {
    const writer = await createFileBundleSink(dir).open();
    await writer.write(new Uint8Array([1, 2, 3]));
    await writer.abort();
    expect(readdirSync(dir)).toEqual([]);
    await writer.abort(); // repeatable, never throws
  });

  it('every open() gets its own file', async () => {
    const sink = createFileBundleSink(dir);
    const a = await sink.open();
    const b = await sink.open();
    await a.write(new Uint8Array([1]));
    await b.write(new Uint8Array([2, 2]));
    const [x, y] = await Promise.all([a.finish(), b.finish()]);
    expect([x.size, y.size]).toEqual([1, 2]);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('ready() rejects once the file is gone (so the upload fails before an issue is created)', async () => {
    const writer = await createFileBundleSink(dir).open();
    await writer.write(new Uint8Array([1]));
    const body = await writer.finish();
    for (const f of readdirSync(dir)) rmSync(join(dir, f));
    await expect(body.ready?.()).rejects.toThrow();
  });

  it('a size of zero is a valid, empty body', async () => {
    const writer = await createFileBundleSink(dir).open();
    const body = await writer.finish();
    expect(body.size).toBe(0);
    expect(await collect(body.stream())).toEqual([]);
    await body.dispose();
  });
});

describe('sweepStaleExports', () => {
  it('removes export files older than the age, keeps newer ones and unrelated files', () => {
    const old = join(dir, 'export-old.zip');
    const fresh = join(dir, 'export-fresh.zip');
    const other = join(dir, 'keep.txt');
    for (const f of [old, fresh, other]) writeFileSync(f, 'x');
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(old, past, past);
    utimesSync(other, past, past);
    expect(sweepStaleExports(dir, 60_000)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it('only touches names with both the export- prefix and the .zip suffix', () => {
    const names = ['export-a.txt', 'other-a.zip', 'export-b.zip', 'zip'];
    const past = new Date(Date.now() - 3_600_000);
    for (const n of names) {
      writeFileSync(join(dir, n), 'x');
      utimesSync(join(dir, n), past, past);
    }
    expect(sweepStaleExports(dir, 60_000)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(['export-a.txt', 'other-a.zip', 'zip']);
  });

  it('keeps a file exactly as old as the limit would allow only when it is newer than the cutoff', () => {
    const f = join(dir, 'export-edge.zip');
    writeFileSync(f, 'x');
    const t = new Date(Date.now() - 30_000);
    utimesSync(f, t, t);
    expect(sweepStaleExports(dir, 60_000)).toBe(0);
    expect(sweepStaleExports(dir, 10_000)).toBe(1);
  });

  it('a missing directory is not an error', () => {
    expect(sweepStaleExports(join(dir, 'nope'), 1000)).toBe(0);
  });
});
