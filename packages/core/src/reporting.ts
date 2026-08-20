import type { Mechanism, ReportingTriggerType } from '@bugsee/protocol';
import type { AttributeValue, IssueType, SeverityName } from '@bugsee/types';
import type { CrashJson, NativeCrashJson } from './crash';

/** An extra per-report binary/text file written verbatim into the bundle (e.g. a harvested native-crash
 *  `.dmp`). Its `name` is the bundle filename the crash.json references (e.g. `crash.minidumpFile`). */
export interface ReportAttachment {
  name: string;
  data: Uint8Array | string;
}

// Report assembly request (Android BugseeReportingRequest / ReportingSource / Report parity). A
// detection provider (or a manual entry point) builds a ReportingRequest and submits it; the trigger
// pipeline assembles it into request.json + a bundle. This replaces the lightweight TriggerHint.
//
// Android's filesystem/Bitmap/encryption/disk-stage machinery is platform-specific and intentionally
// omitted here — the JS v3 bundle path is in-memory (CaptureExporter.drain() → request.json → zip).

// The trigger vocabulary lives in @bugsee/protocol, because it is a WIRE value (`request.json`
// `source.type`) that the collector reads, not an internal one. Re-exported here so the reporting
// API keeps reading naturally.
export type { ReportingTriggerType } from '@bugsee/protocol';

/** The origin of a reporting request (Android ReportingSource). */
export interface ReportingSource {
  /** Why the report fired (crash/error/shake/upload/…). */
  type: ReportingTriggerType;
  /**
   * How the underlying event originated — the capture mechanism (uncaught/programmatic/console-error
   * /…). Set by the capturing code (an interceptor knows 'uncaught'); maps directly to
   * request.json `source.mechanism`. Optional: assembly defaults it for manual triggers.
   */
  mechanism?: Mechanism;
  /** Additional context about what initiated the report (e.g. 'window.onerror'). */
  origin?: string;
}

/** Mutable issue metadata (Android Report); resolved into request.json at assembly. */
export interface Report {
  readonly id: string;
  type: IssueType;
  summary?: string;
  description?: string;
  email?: string;
  severity: SeverityName;
  labels: string[];
  attributes: Record<string, AttributeValue>;
  signatures: string[];
  /** Structured crash detail written to the bundle as `crash.json` (the backend crash pipeline's input).
   *  A JS-exception ({@link CrashJson}) or a native-minidump ({@link NativeCrashJson}) container; absent for
   *  manual/bug reports. */
  crash?: CrashJson | NativeCrashJson;
  /** Extra binary/text files written verbatim into the bundle (e.g. a native-crash `.dmp`). */
  attachments?: readonly ReportAttachment[];
}

/** A report being assembled (Android ReportingRequest), carrying its source and metadata. */
export interface ReportingRequest {
  readonly id: string;
  readonly source: ReportingSource;
  readonly report: Report;
}

export interface ReportingRequestInit {
  source: ReportingSource;
  /** Explicit id; generated when omitted. */
  id?: string;
  /** Issue type; derived from the source when omitted. */
  type?: IssueType;
  /** Severity; derived from the type when omitted. */
  severity?: SeverityName;
  summary?: string;
  description?: string;
  email?: string;
  labels?: string[];
  signatures?: string[];
  /** Structured crash detail → `crash.json` (see {@link Report.crash}). */
  crash?: CrashJson | NativeCrashJson;
  /** Extra binary/text bundle files (see {@link Report.attachments}). */
  attachments?: readonly ReportAttachment[];
}

const defaultGenerateId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function defaultType(trigger: ReportingTriggerType): IssueType {
  if (trigger === 'crash') {
    return 'crash';
  }
  if (trigger === 'error' || trigger === 'assert') {
    return 'error';
  }
  return 'bug';
}

function defaultSeverity(type: IssueType): SeverityName {
  return type === 'crash' ? 'blocker' : 'high';
}

export function createReportingRequest(
  init: ReportingRequestInit,
  generateId: () => string = defaultGenerateId,
): ReportingRequest {
  const id = init.id ?? generateId();
  const type = init.type ?? defaultType(init.source.type);
  const severity = init.severity ?? defaultSeverity(type);
  const report: Report = {
    id,
    type,
    severity,
    labels: init.labels ?? [],
    attributes: {},
    signatures: init.signatures ?? [],
    ...(init.summary !== undefined ? { summary: init.summary } : {}),
    ...(init.description !== undefined ? { description: init.description } : {}),
    ...(init.email !== undefined ? { email: init.email } : {}),
    ...(init.crash !== undefined ? { crash: init.crash } : {}),
    ...(init.attachments !== undefined ? { attachments: init.attachments } : {}),
  };
  return { id, source: init.source, report };
}
