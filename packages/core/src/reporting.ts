import type { Mechanism } from '@bugsee/protocol';
import type { AttributeValue, IssueType, SeverityName } from '@bugsee/types';

// Report assembly request (Android BugseeReportingRequest / ReportingSource / Report parity). A
// detection provider (or a manual entry point) builds a ReportingRequest and submits it; the trigger
// pipeline assembles it into request.json + a bundle. This replaces the lightweight TriggerHint.
//
// Android's filesystem/Bitmap/encryption/disk-stage machinery is platform-specific and intentionally
// omitted here — the JS v3 bundle path is in-memory (CaptureExporter.drain() → request.json → zip).

/** How a report was triggered (Android ReportingSource.ReportingTriggerType). */
export type ReportingTriggerType =
  | 'unknown'
  | 'crash'
  | 'error'
  | 'assert'
  | 'shake'
  | 'broadcast'
  | 'screenshot'
  | 'notification'
  | 'code_dialog'
  | 'code_upload';

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
  };
  return { id, source: init.source, report };
}
