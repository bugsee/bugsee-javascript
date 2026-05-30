import type { NetworkEvent } from '@bugsee/protocol';
import type { Breadcrumb, LogEvent } from './events';
import type { ReportingRequest } from './reporting';

// Redaction filters (design §4.1#4 / §7.1; Android EventFilter<T>) — the per-event transform/veto
// layer, distinct from the observe-only interceptor subscriptions. The user supplies a function the
// capture pipeline runs on each event to mutate it or DROP it (return null) before it is buffered.
// This is the first real SERVICE in the internal container (the `filters` service): the Client (facade)
// sets the filters; the capture pipeline reads the same store via the container (getFilters). Lives in
// this leaf module so the carrier/client/capture can reference the types cycle-free.

/** A capture filter: mutate the event (or return a new one) to keep it, or return null to DROP it. */
export type NetworkEventFilter = (event: NetworkEvent) => NetworkEvent | null;
export type LogEventFilter = (event: LogEvent) => LogEvent | null;
export type BreadcrumbFilter = (breadcrumb: Breadcrumb) => Breadcrumb | null;

/** Report handler (design §7.1): `before` mutates/returns a new request, or null to veto the report. */
export interface ReportHandler {
  before?: (request: ReportingRequest) => ReportingRequest | null;
  /** Accepted for forward-compat; not yet invoked (deferred to a later slice). */
  after?: (request: ReportingRequest) => void;
}

/** The mutable redaction-filter state — the `filters` service in the internal container. */
export interface FilterStore {
  network: NetworkEventFilter | null;
  log: LogEventFilter | null;
  breadcrumb: BreadcrumbFilter | null;
  report: ReportHandler | null;
  /** Diagnostic sink for a throwing filter (the event is then dropped). */
  readonly onError: (error: unknown) => void;
}

/** Create an empty filter store (all filters unset). */
export function createFilterStore(onError: (error: unknown) => void): FilterStore {
  return { network: null, log: null, breadcrumb: null, report: null, onError };
}

/**
 * Run a user filter (mutate/drop) safely: a null filter keeps `value`; a THROWING filter DROPS the
 * event (returns null — privacy-safe, we can't assume it was scrubbed) and routes once to `onError`.
 */
export function runFilter<T>(
  filter: ((value: T) => T | null) | null | undefined,
  value: T,
  onError: (error: unknown) => void,
): T | null {
  if (filter == null) {
    return value;
  }
  try {
    return filter(value);
  } catch (error) {
    onError(error);
    return null;
  }
}

// The `filters` service's typed identity in the internal container (resolved by the capture pipeline).
declare module '@bugsee/types' {
  interface NameServiceMapping {
    filters: FilterStore;
  }
}
