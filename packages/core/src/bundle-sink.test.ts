import { describe, expect, it } from 'vitest';
import { createMemorySink } from './bundle-sink';

describe('createMemorySink', () => {
  it('collects chunks in order into a body of the right size and content', async () => {
    const writer = await createMemorySink().open();
    writer.write(new Uint8Array([1, 2]));
    writer.write(new Uint8Array([3]));
    const body = await writer.finish();
    expect(body.size).toBe(3);
    expect(Array.from(await body.bytes())).toEqual([1, 2, 3]);
  });

  it('gives every open() its own buffer', async () => {
    const sink = createMemorySink();
    const a = await sink.open();
    const b = await sink.open();
    a.write(new Uint8Array([1]));
    b.write(new Uint8Array([2, 2]));
    expect((await a.finish()).size).toBe(1);
    expect((await b.finish()).size).toBe(2);
  });

  it('an aborted writer drops what it held', async () => {
    const writer = await createMemorySink().open();
    writer.write(new Uint8Array([1, 2, 3]));
    await writer.abort();
    expect((await writer.finish()).size).toBe(0);
  });
});

import { createBlobSink, isBlobBundleBody } from './bundle-sink';

describe('createBlobSink', () => {
  it('is undefined where there is no Blob', () => {
    const g = globalThis as unknown as { Blob?: unknown };
    const original = g.Blob;
    g.Blob = undefined;
    try {
      expect(createBlobSink()).toBeUndefined();
    } finally {
      g.Blob = original;
    }
  });

  it('collects chunks into a Blob-backed body with the right size, bytes and stream', async () => {
    const sink = createBlobSink();
    const writer = await (sink as NonNullable<typeof sink>).open();
    writer.write(new Uint8Array([1, 2]));
    writer.write(new Uint8Array([3, 4, 5]));
    const body = await writer.finish();
    expect(body.size).toBe(5);
    expect(Array.from(await body.bytes())).toEqual([1, 2, 3, 4, 5]);
    expect(body.peek()).toBeUndefined();
    const streamed: number[] = [];
    for await (const chunk of body.stream()) streamed.push(...chunk);
    expect(streamed).toEqual([1, 2, 3, 4, 5]);
    // restartable: a retry reads from the start again
    const again: number[] = [];
    for await (const chunk of body.stream()) again.push(...chunk);
    expect(again).toEqual([1, 2, 3, 4, 5]);
    expect(isBlobBundleBody(body)).toBe(true);
    await body.dispose();
  });

  it('builds the Blob without a content type (a typed Blob would add a Content-Type header to the signed PUT)', async () => {
    const sink = createBlobSink();
    const writer = await (sink as NonNullable<typeof sink>).open();
    writer.write(new Uint8Array([1]));
    const body = (await writer.finish()) as unknown as { blob: { type: string } };
    expect(body.blob.type).toBe('');
  });

  it('a plain memory body is not a Blob body', async () => {
    const writer = await createMemorySink().open();
    expect(isBlobBundleBody(await writer.finish())).toBe(false);
  });

  it('an aborted writer drops its parts', async () => {
    const sink = createBlobSink();
    const writer = await (sink as NonNullable<typeof sink>).open();
    writer.write(new Uint8Array([1, 2, 3]));
    await writer.abort();
    expect((await writer.finish()).size).toBe(0);
  });
});
