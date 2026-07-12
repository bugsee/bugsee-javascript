import type { FileType } from '@bugsee/protocol';
import type { CaptureDataEntry, CaptureEntryFactory, CaptureSnapshot } from './contracts';

// Drain a capture snapshot into reified entries grouped by file type (the read half of CaptureExporter,
// but over a snapshot we already hold rather than a live store), releasing the snapshot when done. Shared
// by both recovery paths: detected-incident recovery (capture-recovery.ts) and native-crash synthesis
// (native-crash-recovery.ts) rebuild a prior generation's capture the same way.
export async function drainReified(
  snapshot: CaptureSnapshot,
  factory: CaptureEntryFactory,
  onError: (error: unknown) => void,
): Promise<Map<FileType, CaptureDataEntry[]>> {
  try {
    const grouped = await snapshot.drainAll();
    const out = new Map<FileType, CaptureDataEntry[]>();
    for (const [type, records] of grouped) {
      const entries: CaptureDataEntry[] = [];
      for (const record of records) {
        try {
          const entry = factory(type);
          entry.deserialize(record.serialized);
          entries.push(entry);
        } catch (error) {
          // A torn trailing frame — the exact artifact a crash/SIGKILL leaves mid-write — yields one
          // un-deserializable record (the snapshot parser only guards the timestamp, not the payload).
          // Skip it; NEVER let one bad record poison the whole generation's recovery (which would keep
          // the marker + chunks and repeat the failure on every launch — a permanent loss). Route to onError.
          onError(error);
        }
      }
      out.set(type, entries);
    }
    return out;
  } finally {
    snapshot.release();
  }
}
