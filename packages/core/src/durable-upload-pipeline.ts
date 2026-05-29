import type { RequestJson } from '@bugsee/protocol';
import { strFromU8, strToU8 } from '@bugsee/util';
import type {
  Bundle,
  OutcomeCategory,
  UploadHint,
  UploadPipeline,
  UploadResult,
} from './transport';

// Durable bundle queue (design §7.8 / crash recovery). A report bundle is written to durable storage
// BEFORE its upload is attempted and removed only once the upload is confirmed; any bundle still on
// disk at the next launch (the process crashed/was killed mid-upload, or the upload kept failing) is
// re-uploaded via recover(). This is what guarantees a crash bundle survives a hard exit — the
// flush-then-exit best-effort delivery alone can lose it if the process dies before the upload lands.
// The pipeline LOGIC is platform-agnostic over a BundleStore blob adapter; the storage (node:fs,
// IndexedDB, …) is the platform's. Wrap a real UploadPipeline; it is itself an UploadPipeline.

/** A durable blob store for serialized bundles, keyed by an opaque id. */
export interface BundleStore {
  /** Durably write a bundle blob under `id` (replacing any existing one). */
  put(id: string, bytes: Uint8Array): void;
  /** Ids of every bundle still pending (written and not yet removed). */
  list(): string[];
  /** Read a bundle blob, or undefined if it is absent. */
  read(id: string): Uint8Array | undefined;
  /** Remove a bundle blob; a no-op if absent. */
  remove(id: string): void;
}

export interface DurableUploadPipeline extends UploadPipeline {
  /** Re-enqueue every bundle left persisted by a prior run (crash / kill / failed upload). */
  recover(): void;
}

export interface DurableUploadPipelineOptions {
  /** Where bundles are durably staged. */
  store: BundleStore;
  /** The underlying upload pipeline that actually delivers a bundle. */
  pipeline: UploadPipeline;
  /** Per-bundle id generator. Default: timestamp + monotonic counter. */
  newId?: () => string;
  /** Sink for non-fatal persistence/cleanup/parse failures. Default no-op. */
  onError?: (error: unknown) => void;
}

// Durable frame: [4-byte LE header length][header JSON (utf8)][bundle body bytes]. The header carries
// the request.json + fileName so the full Bundle can be reconstructed for re-upload from the blob.
export function serializeBundle(bundle: Bundle): Uint8Array {
  const header = strToU8(JSON.stringify({ request: bundle.request, fileName: bundle.fileName }));
  const out = new Uint8Array(4 + header.length + bundle.body.length);
  new DataView(out.buffer).setUint32(0, header.length, true);
  out.set(header, 4);
  out.set(bundle.body, 4 + header.length);
  return out;
}

export function deserializeBundle(bytes: Uint8Array): Bundle {
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    0,
    true,
  );
  const header = JSON.parse(strFromU8(bytes.subarray(4, 4 + headerLength))) as {
    request: RequestJson;
    fileName: string;
  };
  return {
    request: header.request,
    fileName: header.fileName,
    body: bytes.subarray(4 + headerLength),
  };
}

export function createDurableUploadPipeline(
  options: DurableUploadPipelineOptions,
): DurableUploadPipeline {
  const { store, pipeline } = options;
  const onError = options.onError ?? (() => {});
  let counter = 0;
  const newId =
    options.newId ??
    (() => {
      counter += 1;
      return `${Date.now()}-${counter}`;
    });

  const removeSafe = (id: string): void => {
    try {
      store.remove(id);
    } catch (error) {
      onError(error);
    }
  };

  // Re-upload a recovered bundle; drop the durable copy only once delivery is confirmed.
  const replay = (id: string, bundle: Bundle): void => {
    void pipeline.enqueue(bundle).then((result) => {
      if (result.ok) {
        removeSafe(id);
      }
    });
  };

  return {
    enqueue(bundle: Bundle, hint?: UploadHint): Promise<UploadResult> {
      const id = newId();
      try {
        store.put(id, serializeBundle(bundle)); // durable BEFORE the upload attempt
      } catch (error) {
        onError(error); // best-effort persistence must never block the upload
      }
      return pipeline.enqueue(bundle, hint).then((result) => {
        if (result.ok) {
          removeSafe(id); // confirmed delivered — drop the durable copy
        }
        return result;
      });
    },

    recover(): void {
      for (const id of store.list()) {
        const bytes = store.read(id);
        if (bytes === undefined) {
          continue; // removed between list() and read()
        }
        let bundle: Bundle;
        try {
          bundle = deserializeBundle(bytes);
        } catch (error) {
          onError(error);
          removeSafe(id); // unparseable leftover — purge so it can't wedge recovery forever
          continue;
        }
        replay(id, bundle);
      }
    },

    flush(timeout?: number): Promise<boolean> {
      return pipeline.flush(timeout);
    },

    drop(reason: string, category: OutcomeCategory): void {
      pipeline.drop(reason, category);
    },
  };
}
