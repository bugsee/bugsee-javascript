import type { FileHandle } from 'node:fs/promises';

/** Write the whole chunk to the handle: one `write` may take less than it was given, so continue from where it stopped. */
export async function writeFully(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}
