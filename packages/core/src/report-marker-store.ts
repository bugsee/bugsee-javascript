import { serviceToken } from '@bugsee/service';
import type { AttributeValue } from '@bugsee/types';
import type { ReportingRequest } from './reporting';

// A durable PENDING-REPORT marker (capture recovery, the detected-incident gap). When an incident is
// detected, the SDK persists a marker BEFORE the (async) bundle assembly; if the process dies before the
// bundle reaches the durable bundle queue, the next launch rebuilds the report from this marker + the
// generation's preserved capture chunks. The marker snapshots the incident-time global attributes +
// user identifier, so the recovered report carries the state as it was, not next-launch's.

export interface ReportMarker {
  /** The capture generation whose chunks back this incident's report. */
  readonly generation: number;
  /** The detected incident's reporting request (the report metadata to reassemble). */
  readonly request: ReportingRequest;
  /** Global attributes as of the incident (Environment.getAllAttributes()). */
  readonly attributes: Record<string, AttributeValue>;
  /** Global user identifier as of the incident (Environment.getUserIdentifier()). */
  readonly userIdentifier: string | null;
}

/**
 * Durable store for pending-report markers (one per detected incident, keyed by `request.id`). Mirrors
 * the BundleStore shape; the platform supplies the medium (node fs / IndexedDB). It must outlive the
 * process (a STABLE, not per-generation, location) so the next launch can read what a crashed run left.
 */
export interface ReportMarkerStore {
  /** Persist (or replace) the marker for `marker.request.id`. */
  put(marker: ReportMarker): void;
  /** Every marker currently persisted (for recovery on the next launch). */
  list(): ReportMarker[];
  /** Remove the marker for report `id`; a no-op if absent. */
  remove(id: string): void;
}

// Service token: core owns the contract; the platform registers the impl, resolvable process-wide.
export const ReportMarkerStoreToken = serviceToken<ReportMarkerStore>('reportMarkerStore');
