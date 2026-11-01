import {
  APP_TOKEN_FILENAME,
  type FileType,
  MANIFEST_JSON_FILENAME,
  type ManifestFileEntry,
  REQUEST_JSON_FILENAME,
} from '@bugsee/protocol';
import { createDeferred, strToU8, Zip, ZipDeflate } from '@bugsee/util';
import {
  type BundleAssemblyContext,
  buildManifest,
  buildReportMembers,
  buildRequestJson,
  fileNameForType,
  fileShape,
  manifestEntryForType,
  randomBundleFileName,
} from './bundle-assembler';
import type { BundleBody } from './bundle-body';
import { type BundleSinkWriter, createMemorySink } from './bundle-sink';
import type { CaptureDataEntry } from './contracts';
import type { StreamEncoderSession } from './file-stream-encoder';
import type { ReportingRequest } from './reporting';
import type { Bundle } from './transport';

// The STREAMING report assembler (docs/design/streaming-export.md §4.1). It builds the same bundle as `assembleBundle`
// — member for member, byte for byte after unzipping — but reads the captured data one entry at a time and feeds it to a
// streaming zip, so the whole window is never held as parsed objects, JSON strings and a one-shot archive at once.
// A member that is not at the head of the zip is compressed as it arrives and waits compressed; peak memory is the
// compressed size of the window, not the window.
//
// Everything that is not a rolling capture stream (request.json, manifest.json, the crash, the attachments) is built by
// the helpers the buffered assembler exports, so the two cannot drift. File types with an injected binary encoder (the
// replay) still collect their payloads and encode at the end; a streaming encoder for them is a later slice.

type TimeRange = { readonly start: number; readonly end: number };

interface EncodedMember {
  readonly type: FileType;
  /** The visual source this member holds (`CaptureDataEntry.lane`); absent for the unkeyed source. */
  readonly lane: string | undefined;
  readonly session: StreamEncoderSession;
  /** Created with the first chunk, so a source that produced nothing leaves no empty member behind. */
  file: ZipDeflate | undefined;
  /** The member's file name, fixed when the file is created. */
  name: string | undefined;
}

/** `replay.bin` for the first member of a type, `replay.1.bin`, `replay.2.bin`, ... for the next ones. */
const nthFileName = (type: FileType, index: number): string => {
  const base = fileNameForType(type);
  if (index === 0) {
    return base;
  }
  const dot = base.lastIndexOf('.');
  return dot === -1 ? `${base}.${index}` : `${base.slice(0, dot)}.${index}${base.slice(dot)}`;
};

interface StreamMember {
  readonly file: ZipDeflate;
  readonly shape: ReturnType<typeof fileShape>;
  count: number;
}

/** `JSON.stringify` that never returns `undefined`: inside an array an undefined item reads `null`. */
function jsonItem(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

export async function assembleBundleStream(
  request: ReportingRequest,
  entries: AsyncIterable<CaptureDataEntry> & { readonly timeRange?: TimeRange },
  context: BundleAssemblyContext,
  extra?: ReadonlyMap<FileType, readonly CaptureDataEntry[]>,
): Promise<Bundle & { body: BundleBody }> {
  // The source is acquired FIRST and closed on ANY failure below: it may hold a frozen snapshot (the capture exporter's
  // stream does), and a generator that was never read would otherwise never run its own cleanup.
  const iterator = entries[Symbol.asyncIterator]();
  try {
    return await build(request, iterator, context, extra, entries.timeRange);
  } catch (error) {
    try {
      await iterator.return?.();
    } catch {
      // Closing the source failed too: the caller needs the ORIGINAL failure, not this one.
    }
    throw error;
  }
}

async function build(
  request: ReportingRequest,
  iterator: AsyncIterator<CaptureDataEntry>,
  context: BundleAssemblyContext,
  extra: ReadonlyMap<FileType, readonly CaptureDataEntry[]> | undefined,
  plan: TimeRange | undefined,
): Promise<Bundle & { body: BundleBody }> {
  const writer = await (context.sink ?? defaultSink).open();
  const queue = createWriteQueue(writer);
  try {
    return await buildInto(writer, queue, request, iterator, context, extra, plan);
  } catch (error) {
    try {
      await queue.idle(); // a write still in flight must land (or fail) before the artifact is deleted under it
      await writer.abort(); // drop the partial artifact; the ORIGINAL failure is what the caller needs
    } catch {
      // Aborting failed too.
    }
    throw error;
  }
}

interface WriteQueue {
  add(chunk: Uint8Array): void;
  /** Bytes still waiting for the sink. */
  readonly queued: number;
  /** Wait for every queued write, then throw the first sink failure if there was one. */
  settle(): Promise<void>;
  /** Wait for every queued write; never throws. */
  idle(): Promise<void>;
  throwIfFailed(): void;
}

/**
 * The zip's output goes to the sink writer strictly in order: each write starts when the previous one is done. A failed
 * write is remembered (and the later ones skipped) so the build fails with it.
 */
function createWriteQueue(writer: BundleSinkWriter): WriteQueue {
  let writes: Promise<void> = Promise.resolve();
  let queued = 0;
  let failure: { error: unknown } | undefined;
  const throwIfFailed = (): void => {
    if (failure !== undefined) {
      throw failure.error;
    }
  };
  return {
    add(chunk): void {
      queued += chunk.length;
      writes = writes.then(async () => {
        if (failure === undefined) {
          try {
            await writer.write(chunk);
          } catch (error) {
            failure = { error };
          }
        }
        queued -= chunk.length;
      });
    },
    get queued(): number {
      return queued;
    },
    async settle(): Promise<void> {
      await writes;
      throwIfFailed();
    },
    idle: () => writes,
    throwIfFailed,
  };
}

/** Writes beyond this many queued bytes make the build wait for the sink instead of racing ahead of it. */
const MAX_QUEUED_BYTES = 1 << 20;
const defaultSink = createMemorySink();

async function buildInto(
  writer: BundleSinkWriter,
  queue: WriteQueue,
  request: ReportingRequest,
  iterator: AsyncIterator<CaptureDataEntry>,
  context: BundleAssemblyContext,
  extra: ReadonlyMap<FileType, readonly CaptureDataEntry[]> | undefined,
  plan: TimeRange | undefined,
): Promise<Bundle & { body: BundleBody }> {
  const now = context.clock.wallNow();
  const requestJson = buildRequestJson(request, context, now);

  const done = createDeferred<void>();
  const zip = new Zip((error, data, final) => {
    /* v8 ignore next 4 -- fflate's streaming deflate is synchronous and reports no error for in-memory input; the guard keeps the contract if that ever changes */
    if (error !== null) {
      done.reject(error);
      return;
    }
    queue.add(data);
    if (final) {
      done.resolve();
    }
  });

  // Every member name written so far: a clash (a captured `crash` entry beside report.crash, say) is refused exactly as
  // `writeBundleZip` refuses it, rather than writing two members of one name.
  const claimed = new Set<string>();
  const claim = (name: string): string => {
    if (claimed.has(name)) {
      throw new Error(`Bundle has a duplicate file name: ${name}`);
    }
    claimed.add(name);
    return name;
  };
  const addWhole = (name: string, data: Uint8Array | string): void => {
    const file = new ZipDeflate(claim(name));
    zip.add(file);
    file.push(typeof data === 'string' ? strToU8(data) : data, true);
  };

  addWhole(REQUEST_JSON_FILENAME, JSON.stringify(requestJson));
  addWhole(APP_TOKEN_FILENAME, context.appToken);

  // The data pass. `order` is the first-seen order of the types (the manifest lists them in it).
  // With a plan the report starts where the plan says (the window), whatever the records are; without one, at the earliest
  // record. The plan also bounds the ROLLING records: older ones (the store keeps up to a second of slack) are dropped.
  let start = plan?.start ?? now;
  const order: string[] = []; // member keys: a type, or `type\0lane` for one visual source of a stream-encoded type
  const streamed = new Map<string, StreamMember>();
  const collected = new Map<string, unknown[]>(); // types with an injected encoder
  const encoded = new Map<string, EncodedMember>(); // types with a stream encoder: one member per visual source lane
  const filesOfType = new Map<FileType, number>(); // members actually created per type (names the next one)
  const writeChunks = (member: EncodedMember, chunks: Uint8Array[]): void => {
    for (const chunk of chunks) {
      if (member.file === undefined) {
        const index = filesOfType.get(member.type) ?? 0;
        filesOfType.set(member.type, index + 1);
        member.name = claim(nthFileName(member.type, index));
        member.file = new ZipDeflate(member.name);
        zip.add(member.file);
      }
      member.file.push(chunk, false);
    }
  };
  const take = (entry: CaptureDataEntry, rolling: boolean): void => {
    const type = entry.type;
    if (plan === undefined) {
      if (entry.timestamp < start) {
        start = entry.timestamp;
      }
    } else if (
      rolling &&
      entry.timestamp < plan.start &&
      context.fileEncoders?.[entry.type] === undefined &&
      context.streamEncoders?.[entry.type] === undefined
    ) {
      return; // before the window; types with an encoder (the replay) are clamped by it instead
    }
    const streamEncoder = context.streamEncoders?.[type];
    // Only a stream-encoded (reconstructed) type splits by source: every other type is one member whatever its lane.
    const key =
      streamEncoder !== undefined && entry.lane !== undefined ? `${type}\0${entry.lane}` : type;
    if (!streamed.has(key) && !collected.has(key) && !encoded.has(key)) {
      order.push(key);
      if (streamEncoder !== undefined) {
        encoded.set(key, {
          type,
          lane: entry.lane,
          session: streamEncoder.begin({ start: plan?.start, end: now }),
          file: undefined,
          name: undefined,
        });
      } else if (context.fileEncoders?.[type] !== undefined) {
        collected.set(key, []);
      } else {
        const file = new ZipDeflate(claim(fileNameForType(type)));
        zip.add(file);
        streamed.set(key, { file, shape: fileShape(type), count: 0 });
      }
    }
    const session = encoded.get(key);
    if (session !== undefined) {
      let chunks: Uint8Array[];
      try {
        chunks = session.session.write(entry);
      } catch (error) {
        context.onError?.(error); // one bad record never costs the member
        return;
      }
      // Outside the try: a name clash (or any zip failure) is not a bad record and must fail the bundle, as it does everywhere.
      writeChunks(session, chunks);
      return;
    }
    const payloads = collected.get(key);
    if (payloads !== undefined) {
      payloads.push(entry.data);
      return;
    }
    const member = streamed.get(key) as StreamMember;
    if (member.shape.single) {
      // `profile`: the first entry alone, as a bare object.
      if (member.count === 0) {
        member.file.push(strToU8(jsonItem(entry.data)), false);
      }
    } else {
      member.file.push(
        strToU8((member.count === 0 ? member.shape.open : ',') + jsonItem(entry.data)),
        false,
      );
    }
    member.count += 1;
  };
  for await (const entry of { [Symbol.asyncIterator]: () => iterator }) {
    take(entry, true);
    queue.throwIfFailed(); // the sink already failed: stop reading, nothing more can be delivered
    if (queue.queued > MAX_QUEUED_BYTES) {
      await queue.settle(); // the sink is behind: let it catch up before reading more
    }
  }
  for (const list of extra?.values() ?? []) {
    for (const entry of list) {
      take(entry, false);
    }
  }

  const files: ManifestFileEntry[] = [];
  const dataNames: string[] = [];
  for (const key of order) {
    const stream = encoded.get(key);
    const type = (stream?.type ?? key) as FileType;
    if (stream !== undefined) {
      writeChunks(stream, stream.session.end());
      if (stream.file === undefined) {
        continue; // nothing was produced: no member, no manifest entry
      }
      stream.file.push(new Uint8Array(0), true);
    }
    const name = stream?.name ?? fileNameForType(type);
    const entry = manifestEntryForType(type);
    files.push({
      ...entry,
      filename: name,
      ...(stream?.lane !== undefined ? { attrs: { ...entry.attrs, window: stream.lane } } : {}),
    });
    dataNames.push(name);
    const member = streamed.get(key);
    if (stream !== undefined) {
      // finalized above
    } else if (member !== undefined) {
      member.file.push(strToU8(member.shape.close), true);
    } else {
      const encode = (context.fileEncoders as NonNullable<typeof context.fileEncoders>)[type] as (
        payloads: unknown[],
      ) => Uint8Array;
      addWhole(fileNameForType(type), encode(collected.get(key) as unknown[]));
    }
  }

  const reportMembers = buildReportMembers(request.report, context, dataNames);
  for (const member of reportMembers.typedFiles) {
    addWhole(member.name, member.data);
  }
  files.push(...reportMembers.files);
  addWhole(MANIFEST_JSON_FILENAME, JSON.stringify(buildManifest(context, start, now, files)));
  zip.end();
  await done.promise;
  await queue.settle();
  return {
    request: requestJson,
    body: await writer.finish(),
    fileName: (context.fileName ?? randomBundleFileName)(),
  };
}
