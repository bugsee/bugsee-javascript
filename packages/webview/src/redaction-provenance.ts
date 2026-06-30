import type { FilterStore } from '@bugsee/core';
import type { FileType } from '@bugsee/protocol';

// D3 redaction provenance (docs/design/webview-bridge.md §8). Each crossing carries a `red` flag telling native
// whether a JS-side filter PASS ran on it (NOT that content was necessarily changed — a no-op filter still ran).
// Native ALWAYS re-applies its own canonical filters regardless of `red` (so `red` is provenance-only and never
// causes native to skip redaction — there is no privacy hazard if it's wrong); `red` just records that the JS
// pass also ran, so the union of both filter sets is the effective policy. The flag is PER ENTRY TYPE: a `log`
// entry is `red` iff a log filter is configured, `network` iff a network filter, etc. Entry types with no
// corresponding JS filter (system traces/events) are always `red:false` — only native redacts them. The report
// path is `red` iff a report handler with a `before` pass is set (that pass runs in the Client before crossing).
//
// NOTE on carrier: this reads the live `filters` service from the SDK's own service container (the authoritative
// store). In production the SDK runs on the default global carrier, where the capture providers' filter pass and
// this provenance resolve to the SAME store, so `red:true` ⟺ a filter both configured AND ran. (The `carrier`
// launch option is test-only; native's unconditional re-redaction keeps even a mismatched flag privacy-safe.)

/** Each filterable entry FileType → the FilterStore key whose presence means a JS pass ran on that entry. */
const FILTER_KEY: Partial<Record<FileType, 'log' | 'network' | 'breadcrumb'>> = {
  log: 'log',
  network: 'network',
  breadcrumbs: 'breadcrumb',
};

export interface RedactionProvenance {
  /** Did a JS-side filter run on a captured entry of this type? (drives the entry `red` flag). */
  forEntry(type: FileType): boolean;
  /** Did a JS-side report handler (`before`) run on the report request? (drives the report/crash `red` flag). */
  forReport(): boolean;
}

/**
 * Build the provenance over a LAZY FilterStore accessor — the store/report pipeline are constructed before the
 * Client registers the `filters` service, and a filter may be set later via the returned client, so the accessor
 * is read on every call (not captured once).
 */
export function createRedactionProvenance(
  getFilterStore: () => FilterStore | null | undefined,
): RedactionProvenance {
  return {
    forEntry(type: FileType): boolean {
      const key = FILTER_KEY[type];
      return key !== undefined && getFilterStore()?.[key] != null;
    },
    forReport(): boolean {
      return getFilterStore()?.report?.before != null;
    },
  };
}
