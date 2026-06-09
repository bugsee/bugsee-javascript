// Shared options for the web-vitals collectors (onTTFB/onFCP/onLCP/onCLS/onINP).

export interface VitalReportOptions {
  /** Stream every intermediate update (vs report only the final value). Default false. */
  reportAllChanges?: boolean;
}
