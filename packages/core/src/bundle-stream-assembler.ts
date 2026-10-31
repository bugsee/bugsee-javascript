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
import { type BundleBody, createMemoryBody } from './bundle-body';
import type { CaptureDataEntry } from './contracts';
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
  entries: AsyncIterable<CaptureDataEntry>,
  context: BundleAssemblyContext,
  extra?: ReadonlyMap<FileType, readonly CaptureDataEntry[]>,
): Promise<Bundle & { body: BundleBody }> {
  // The source is acquired FIRST and closed on ANY failure below: it may hold a frozen snapshot (the capture exporter's
  // stream does), and a generator that was never read would otherwise never run its own cleanup.
  const iterator = entries[Symbol.asyncIterator]();
  try {
    return await build(request, iterator, context, extra);
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
): Promise<Bundle & { body: BundleBody }> {
  const now = context.clock.wallNow();
  const requestJson = buildRequestJson(request, context, now);

  const chunks: Uint8Array[] = [];
  const done = createDeferred<void>();
  const zip = new Zip((error, data, final) => {
    /* v8 ignore next 4 -- fflate's streaming deflate is synchronous and reports no error for in-memory input; the guard keeps the contract if that ever changes */
    if (error !== null) {
      done.reject(error);
      return;
    }
    chunks.push(data);
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
  let start = now;
  const order: FileType[] = [];
  const streamed = new Map<FileType, StreamMember>();
  const collected = new Map<FileType, unknown[]>(); // types with an injected encoder
  const take = (entry: CaptureDataEntry): void => {
    const type = entry.type;
    if (entry.timestamp < start) {
      start = entry.timestamp;
    }
    if (!streamed.has(type) && !collected.has(type)) {
      order.push(type);
      if (context.fileEncoders?.[type] !== undefined) {
        collected.set(type, []);
      } else {
        const file = new ZipDeflate(claim(fileNameForType(type)));
        zip.add(file);
        streamed.set(type, { file, shape: fileShape(type), count: 0 });
      }
    }
    const payloads = collected.get(type);
    if (payloads !== undefined) {
      payloads.push(entry.data);
      return;
    }
    const member = streamed.get(type) as StreamMember;
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
    take(entry);
  }
  for (const list of extra?.values() ?? []) {
    for (const entry of list) {
      take(entry);
    }
  }

  const files: ManifestFileEntry[] = [];
  const dataNames: string[] = [];
  for (const type of order) {
    files.push(manifestEntryForType(type));
    dataNames.push(fileNameForType(type));
    const member = streamed.get(type);
    if (member !== undefined) {
      member.file.push(strToU8(member.shape.close), true);
    } else {
      const encode = (context.fileEncoders as NonNullable<typeof context.fileEncoders>)[type] as (
        payloads: unknown[],
      ) => Uint8Array;
      addWhole(fileNameForType(type), encode(collected.get(type) as unknown[]));
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
  return {
    request: requestJson,
    body: createMemoryBody(chunks),
    fileName: (context.fileName ?? randomBundleFileName)(),
  };
}
