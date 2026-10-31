import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A file handle that accepts at most 3 bytes per write, as a full disk or a pipe may: the sink must keep writing
// until the whole chunk is down, and its size must be what is really in the file.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      const write = handle.write.bind(handle) as (
        b: Uint8Array,
        offset: number,
        length: number,
      ) => Promise<{ bytesWritten: number }>;
      (handle as unknown as { write: unknown }).write = (
        b: Uint8Array,
        offset = 0,
        length = b.length - offset,
      ) => write(b, offset, Math.min(3, length));
      return handle;
    },
  };
});

import { createFileBundleSink } from './file-bundle-sink';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bugsee-sink-partial-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('createFileBundleSink — short writes', () => {
  it('keeps writing until the whole chunk is on disk and reports the real size', async () => {
    const writer = await createFileBundleSink(dir).open();
    const chunk = Uint8Array.from({ length: 20 }, (_, i) => i);
    await writer.write(chunk);
    await writer.write(Uint8Array.from([100, 101]));
    const body = await writer.finish();
    expect(body.size).toBe(22);
    expect(Array.from(await body.bytes())).toEqual([...chunk, 100, 101]);
    await body.dispose();
  });
});
