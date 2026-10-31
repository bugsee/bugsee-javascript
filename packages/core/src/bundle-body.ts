// The body of an assembled bundle (docs/design/streaming-export.md §4.5). A report's `*.bundle.zip` can be large, so the
// pipeline never assumes it is one contiguous `Uint8Array`: it asks a BundleBody for what it needs (its size, a stream,
// or the bytes when something genuinely needs them all at once). Platforms back it with whatever is cheap to hold — a
// Blob, a temp file, or, here, memory chunks.

export interface BundleBody {
  /**
   * Optional pre-flight, awaited BEFORE the upload creates anything on the collector: rejects when the content can no
   * longer be read (a temp file that was removed). Bodies that cannot go missing (memory, Blob) omit it.
   */
  ready?(): Promise<void>;
  /** Total length in bytes (the signed PUT's Content-Length). */
  readonly size: number;
  /** The content in order. RESTARTABLE: every call reads from the start, so an upload retry can run again. */
  stream(): AsyncIterable<Uint8Array>;
  /** The whole content as one array (tests, small bundles, hashing). Materializes a body that is not in memory. */
  bytes(): Promise<Uint8Array>;
  /** The whole content when it is already in memory, else `undefined`: lets a synchronous writer avoid a copy. */
  peek(): Uint8Array | undefined;
  /**
   * Release whatever backs the body (a temp file, a Blob). Repeatable and never throws into its caller. Ownership
   * passes with the body: the upload pipeline that was handed it disposes it once the upload is over (success or not).
   * An in-memory body has nothing to release.
   */
  dispose(): void | Promise<void>;
}

/** What `Bundle.body` may hold: raw bytes (every assembler today) or a {@link BundleBody}. */
export type BundleBodyLike = Uint8Array | BundleBody;

export function isBundleBody(value: BundleBodyLike): value is BundleBody {
  // `ArrayBuffer.isView` rather than `instanceof Uint8Array`: bytes from another realm (a vm context, an iframe) are
  // still bytes.
  return !ArrayBuffer.isView(value);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const [only] = chunks;
  if (chunks.length === 1 && only !== undefined) {
    return only;
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** A body held in memory as chunks (no copy for a single chunk). The default sink's artifact. */
export function createMemoryBody(input: readonly Uint8Array[]): BundleBody {
  // Snapshot the list (the chunks themselves are not copied) so a caller reusing its array cannot change the body.
  const chunks = input.slice();
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  // Joined lazily and ONCE: bytes() and peek() then hand out the same array instead of a new copy per call.
  let joined: Uint8Array | undefined;
  const whole = (): Uint8Array => {
    joined ??= concat(chunks);
    return joined;
  };
  return {
    size,
    async *stream(): AsyncIterable<Uint8Array> {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    bytes: (): Promise<Uint8Array> => Promise.resolve(whole()),
    peek: whole,
    dispose: (): void => {},
  };
}

/** Normalize `Bundle.body` so every consumer reads one shape. */
export function asBody(body: BundleBodyLike): BundleBody {
  return isBundleBody(body) ? body : createMemoryBody([body]);
}

/**
 * Share one body between `count` owners (staging it durably and uploading it read it at the same time): the underlying
 * body is disposed when the LAST of them releases it, and never twice. Content access delegates untouched.
 */
export function retainBody(body: BundleBody, count: number): BundleBody {
  let remaining = count;
  const shared: BundleBody = {
    size: body.size,
    stream: () => body.stream(),
    bytes: () => body.bytes(),
    peek: () => body.peek(),
    dispose: (): void | Promise<void> => {
      remaining -= 1;
      return remaining === 0 ? body.dispose() : undefined; // exactly the last claim disposes; extra releases fall past 0
    },
  };
  if (body.ready !== undefined) {
    const ready = body.ready.bind(body);
    shared.ready = ready;
  }
  return shared;
}
