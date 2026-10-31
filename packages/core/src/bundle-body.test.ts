import { describe, expect, it } from 'vitest';
import { asBody, createMemoryBody, isBundleBody } from './bundle-body';

// `node:vm` through the process (this package has no node typings): a context of its own has its own Uint8Array.
const runInNewContext = (code: string): unknown =>
  (
    globalThis as unknown as {
      process: { getBuiltinModule(id: string): { runInNewContext(code: string): unknown } };
    }
  ).process
    .getBuiltinModule('node:vm')
    .runInNewContext(code);

const u8 = (...n: number[]): Uint8Array => Uint8Array.from(n);
const collect = async (body: AsyncIterable<Uint8Array>): Promise<number[]> => {
  const out: number[] = [];
  for await (const chunk of body) out.push(...chunk);
  return out;
};

describe('createMemoryBody', () => {
  it('reports the summed size of its chunks', () => {
    expect(createMemoryBody([u8(1, 2), u8(3)]).size).toBe(3);
  });

  it('streams the chunks in order, and again from the start on a second call (restartable for a retry)', async () => {
    const body = createMemoryBody([u8(1, 2), u8(3)]);
    expect(await collect(body.stream())).toEqual([1, 2, 3]);
    expect(await collect(body.stream())).toEqual([1, 2, 3]);
  });

  it('materializes to one contiguous array', async () => {
    expect(Array.from(await createMemoryBody([u8(1, 2), u8(3)]).bytes())).toEqual([1, 2, 3]);
  });

  it('hands out a single chunk without copying it', async () => {
    const only = u8(9, 8, 7);
    const body = createMemoryBody([only]);
    expect(await body.bytes()).toBe(only);
    expect(body.peek()).toBe(only);
  });

  it('peeks synchronously (it is held in memory)', () => {
    expect(Array.from(createMemoryBody([u8(1), u8(2)]).peek() as Uint8Array)).toEqual([1, 2]);
  });

  it('concatenates a multi-chunk body once: bytes() and peek() hand out the same array every time', async () => {
    const body = createMemoryBody([u8(1), u8(2)]);
    const first = await body.bytes();
    expect(await body.bytes()).toBe(first);
    expect(body.peek()).toBe(first);
  });

  it('is not changed by later mutation of the chunk list it was given', async () => {
    const chunks = [u8(1), u8(2)];
    const body = createMemoryBody(chunks);
    chunks.push(u8(3));
    expect(body.size).toBe(2);
    expect(Array.from(await body.bytes())).toEqual([1, 2]);
  });

  it('has no chunks at all as an empty body', async () => {
    const body = createMemoryBody([]);
    expect(body.size).toBe(0);
    expect((await body.bytes()).length).toBe(0);
    expect(await collect(body.stream())).toEqual([]);
  });

  it('dispose is harmless, repeatable, and leaves the body readable (nothing to release in memory)', async () => {
    const body = createMemoryBody([u8(1)]);
    await body.dispose();
    await body.dispose();
    expect(await collect(body.stream())).toEqual([1]);
  });
});

describe('asBody / isBundleBody', () => {
  it('wraps raw bytes into a body of the same content', async () => {
    const raw = u8(4, 5, 6);
    const body = asBody(raw);
    expect(body.size).toBe(3);
    expect(await body.bytes()).toBe(raw);
  });

  it('passes an existing body through untouched', () => {
    const body = createMemoryBody([u8(1)]);
    expect(asBody(body)).toBe(body);
  });

  it('treats a Uint8Array from another realm as raw bytes, not as a body', () => {
    const foreign = runInNewContext('new Uint8Array([1, 2, 3])') as Uint8Array;
    expect(isBundleBody(foreign)).toBe(false);
    expect(asBody(foreign).size).toBe(3);
  });

  it('tells a body from raw bytes', () => {
    expect(isBundleBody(createMemoryBody([]))).toBe(true);
    expect(isBundleBody(u8(1))).toBe(false);
  });
});
