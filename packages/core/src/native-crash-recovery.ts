import type { AttributeValue } from '@bugsee/types';
import { assembleBundle, type BundleAssemblyContext } from './bundle-assembler';
import { drainReified } from './capture-drain';
import { defaultEntryFactory } from './capture-data-entry';
import type { ChunkBackend, FrozenPart } from './chunk-backend';
import type { CaptureEntryFactory } from './contracts';
import type { NativeCrashJson } from './crash';
import { createReportingRequest } from './reporting';
import type { UploadPipeline } from './transport';

// Native-crash recovery (session-stitched harvest-and-bundle — docs/design/electron-native-crashes.md §6.1).
// A native crash (Electron/Crashpad, V8 or native-addon segfault) kills the process INSTANTLY, so no JS
// detection handler runs and there is NO ReportMarker (those are written by the JS-side incident submit).
// `recoverReports` only rebuilds ALREADY-detected incidents, so it cannot see a native crash. Instead, at
// launch the SDK persists a CrashpadSessionMarker linking the Crashpad dump dir → this generation + session;
// on the NEXT launch, when a DEAD sibling subtree is processed, its marker lets us harvest the pending
// `.dmp`s and SYNTHESIZE a crash report for each — a native `crash.json` + the `.dmp` attachment, stitched to
// that session's preserved capture (the drained generation chunks) → assembled + uploaded through the live
// pipeline. Pure over injected ports (the Crashpad-dir read is the NativeCrashSource seam supplied by
// @bugsee/electron); best-effort — every failure routes to onError and the function never throws into launch.

/** Links a launch's Crashpad dump directory to its capture generation + session (persisted at start). */
export interface CrashpadSessionMarker {
  /** The capture generation whose preserved chunks back the crashed session (drained into the bundle). */
  readonly generation: number;
  /** The crashed session id — the seam matches dumps to this session (Crashpad `extra.session_id`). */
  readonly sessionId: string;
  /** The Crashpad database directory the `.dmp`s land in. */
  readonly dumpDir: string;
  /** Global attributes as of launch (Environment.getAllAttributes()) — stamped onto the recovered bundle. */
  readonly attributes: Record<string, AttributeValue>;
  /** Global user identifier as of launch — becomes the recovered report's `email`. */
  readonly userIdentifier: string | null;
}

/** One harvested native-crash dump: the `.dmp` filename + its bytes. */
export interface HarvestedDump {
  readonly name: string;
  readonly data: Uint8Array;
}

/** Reads pending native-crash dumps for a crashed session (the Crashpad-dir seam; @bugsee/electron supplies
 *  the real impl). Fully unit-testable with a fake. */
export interface NativeCrashSource {
  /** Pending dumps belonging to the marker's session (matched by the seam, e.g. via `extra.session_id`). */
  harvest(marker: CrashpadSessionMarker): Promise<HarvestedDump[]> | HarvestedDump[];
  /** Drop a harvested dump once its bundle is delivered (so it is never re-uploaded). */
  claim(marker: CrashpadSessionMarker, name: string): void;
}

export interface RecoverNativeCrashesOptions {
  /** The chunk backend (over the SAME medium as the crashed store) used to read the crashed generation. */
  backend: Pick<ChunkBackend, 'listParts' | 'snapshot'>;
  /** The crashed launch's session marker (generation + session + dump dir + incident-time global state). */
  marker: CrashpadSessionMarker;
  /** The Crashpad-dir seam that harvests + claims pending dumps. */
  source: NativeCrashSource;
  /** Base assembly context (appToken + environment + clock); the marker supplies attributes + user. */
  context: () => Omit<BundleAssemblyContext, 'attributes' | 'userIdentifier'>;
  /** The (durable) upload pipeline recovered bundles are enqueued through. */
  uploadPipeline: Pick<UploadPipeline, 'enqueue'>;
  /** Entry factory for reifying stored records. Default defaultEntryFactory. */
  entryFactory?: CaptureEntryFactory;
  /** Report-id generator (deterministic in tests). */
  generateId?: () => string;
  /** Failure sink. Default no-op. */
  onError?: (error: unknown) => void;
}

/** The outcome of a native-crash recovery pass over one dead session. */
export interface NativeCrashRecoveryResult {
  /** How many pending dumps the session yielded. */
  readonly harvested: number;
  /** How many were assembled + delivered (and claimed). */
  readonly delivered: number;
  /**
   * True when the session is FULLY processed and its marker may be cleared: either no dumps existed
   * (nothing to recover) or every harvested dump was delivered. False on any infrastructure failure or a
   * partial delivery — the caller then KEEPS the marker so a later launch retries.
   */
  readonly complete: boolean;
}

export async function recoverNativeCrashes(
  options: RecoverNativeCrashesOptions,
): Promise<NativeCrashRecoveryResult> {
  const onError = options.onError ?? ((): void => {});
  const entryFactory = options.entryFactory ?? defaultEntryFactory;
  const { backend, marker, source, uploadPipeline } = options;
  let harvested = 0;
  let delivered = 0;

  try {
    const dumps = await source.harvest(marker);
    harvested = dumps.length;
    // No native crash this session (clean exit / non-native death) — nothing to recover, marker clearable.
    if (dumps.length === 0) {
      return { harvested, delivered, complete: true };
    }

    const base = options.context();
    // Drain the crashed generation's capture ONCE — every dump of this session shares the same recording.
    const parts = await backend.listParts(marker.generation);
    const frozen: FrozenPart[] = parts.map((part) => ({
      ref: { generation: marker.generation, number: part.number },
      count: Number.MAX_SAFE_INTEGER, // recover the whole part
    }));
    const captured = await drainReified(backend.snapshot(frozen), entryFactory, onError);

    for (const dump of dumps) {
      try {
        const crash: NativeCrashJson = {
          exception_type: 'native',
          ndkCrash: true,
          minidumpFile: dump.name,
        };
        const request = createReportingRequest(
          {
            source: { type: 'crash', mechanism: 'uncaught', origin: 'crashpad' },
            type: 'crash',
            summary: 'Native crash',
            crash,
            attachments: [{ name: dump.name, data: dump.data }],
          },
          options.generateId,
        );
        const bundle = assembleBundle(request, captured, {
          ...base,
          attributes: marker.attributes,
          userIdentifier: marker.userIdentifier,
        });
        const result = await uploadPipeline.enqueue(bundle);
        if (result.ok) {
          source.claim(marker, dump.name); // confirmed delivered — never re-upload
          delivered += 1;
        }
        // On !ok the dump is LEFT unclaimed → re-harvested + retried on a later launch.
      } catch (error) {
        onError(error);
      }
    }
  } catch (error) {
    // Harvest / listParts / snapshot failure: keep the marker (complete stays false) so a launch retries.
    onError(error);
    return { harvested, delivered, complete: false };
  }

  return { harvested, delivered, complete: delivered === harvested };
}
