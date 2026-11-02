import { type BundleBody, createMemoryBody } from './bundle-body';

// Where an assembled bundle's bytes go while the zip is being built (docs/design/streaming-export.md §4.5). The streaming
// assembler writes the zip chunk by chunk to a sink writer and gets a BundleBody back, so a platform decides what holds a
// large artifact: a Blob (the engine may spill it to disk), a temp file (node), or plain memory (the default, edge).

export interface BundleSinkWriter {
  /** The next chunk of the zip, in order. May be async: the assembler waits for it before producing much more. */
  write(chunk: Uint8Array): void | Promise<void>;
  /** The zip is complete: the artifact. */
  finish(): Promise<BundleBody>;
  /** The export failed: drop whatever was written (delete the partial file). Never throws into the caller. */
  abort(): void | Promise<void>;
}

export interface BundleSink {
  open(): BundleSinkWriter | Promise<BundleSinkWriter>;
}

/** The default sink: chunks held in memory (today's behaviour, minus the intermediate copies). */
export function createMemorySink(): BundleSink {
  return {
    open(): BundleSinkWriter {
      const chunks: Uint8Array[] = [];
      return {
        write: (chunk): void => {
          chunks.push(chunk);
        },
        finish: (): Promise<BundleBody> => Promise.resolve(createMemoryBody(chunks)),
        abort: (): void => {
          chunks.length = 0;
        },
      };
    },
  };
}

/** The slice of the platform `Blob` the Blob sink needs (core has no DOM types). */
interface BlobLike {
  readonly size: number;
  stream(): {
    getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; releaseLock(): void };
  };
  arrayBuffer(): Promise<ArrayBuffer>;
}
type BlobConstructorLike = new (parts: Uint8Array[]) => BlobLike;

/** A {@link BundleBody} backed by a Blob; `blob` is what a fetch transport can send as is. */
export interface BlobBundleBody extends BundleBody {
  readonly blob: BlobLike;
}

export function isBlobBundleBody(body: BundleBody): body is BlobBundleBody {
  return 'blob' in body && (body as { blob?: unknown }).blob !== undefined;
}

/**
 * A sink that collects the zip as Blob parts, for runtimes that have `Blob` (browsers, workers, Deno, Bun, Node 18+): the
 * engine is free to keep a large Blob out of the JS heap. `undefined` where the global is missing.
 */
export function createBlobSink(): BundleSink | undefined {
  const BlobCtor = (globalThis as unknown as { Blob?: BlobConstructorLike }).Blob;
  if (BlobCtor === undefined) {
    return undefined;
  }
  return {
    open(): BundleSinkWriter {
      let parts: Uint8Array[] = [];
      return {
        write: (chunk): void => {
          parts.push(chunk);
        },
        finish: (): Promise<BundleBody> => {
          const blob = new BlobCtor(parts);
          parts = [];
          const body: BlobBundleBody = {
            blob,
            size: blob.size,
            stream: (): AsyncIterable<Uint8Array> => ({
              async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
                const reader = blob.stream().getReader();
                try {
                  for (;;) {
                    const { done, value } = await reader.read();
                    if (done) {
                      return;
                    }
                    yield value as Uint8Array;
                  }
                } finally {
                  reader.releaseLock();
                }
              },
            }),
            bytes: async (): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer()),
            peek: (): undefined => undefined,
            dispose: (): void => {},
          };
          return Promise.resolve(body);
        },
        abort: (): void => {
          parts = [];
        },
      };
    },
  };
}
