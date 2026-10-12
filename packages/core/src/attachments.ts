import { utf8ByteLength } from '@bugsee/util';
import type { Report, ReportAttachmentInput } from './reporting';

// Application-supplied report attachments (Android `Report.addAttachment`, iOS `BugseeAttachment`).
// Limits mirror the mobile SDKs: at most 3 attachments of 3 MB each. An attachment that breaks a rule is
// DROPPED and reported through `onError` — a report is never lost, and the app never sees a throw, because
// the attachment usually rides a crash report that is the only record of the incident.

/** Mobile parity: attachments per report. */
export const MAX_USER_ATTACHMENTS = 3;
/** Mobile parity: bytes per attachment (3 MB). */
export const MAX_USER_ATTACHMENT_BYTES = 3 * 1024 * 1024;

const MAX_FILE_NAME_LENGTH = 128;
const FALLBACK_FILE_NAME = 'attachment';
const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyz0123456789';
// ASCII control characters (U+0000-U+001F, U+007F); built from code points so the source has no literal controls.
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);

/** An attachment after limits/naming: ready for the assembler. */
export interface ResolvedUserAttachment {
  /** The member name inside the bundle zip: `<random20>.attachment.bgsfile` (never user-controlled). */
  bundleName: string;
  /** Display label (manifest `name`). */
  name: string;
  mimeType: string;
  /** Sanitized download name; never contains a path separator. */
  fileName: string;
  data: Uint8Array | string;
}

/**
 * Reduce an arbitrary string to a safe single path segment: control characters removed, anything up to the
 * last `/` or `\` dropped, `.`/`..`/empty replaced by a fixed fallback, capped at 128 characters.
 */
export function sanitizeAttachmentFileName(raw: string): string {
  const base = (raw.replace(CONTROL_CHARS, '').split(/[\\/]/).pop() as string).trim();
  if (base === '' || base === '.' || base === '..') {
    return FALLBACK_FILE_NAME;
  }
  return base.slice(0, MAX_FILE_NAME_LENGTH);
}

function randomBundleName(): string {
  let name = '';
  for (let i = 0; i < 20; i += 1) {
    name += ALPHANUMERIC.charAt(Math.floor(Math.random() * ALPHANUMERIC.length));
  }
  return name;
}

function label(input: unknown): string {
  const name = (input as { name?: unknown } | null)?.name;
  return typeof name === 'string' && name !== '' ? `"${name}"` : '(unnamed)';
}

/**
 * Validate and name the application's attachments. Order is preserved; the budget is spent only by attachments
 * that are accepted, so an oversize one never uses up a slot. `generateName` is injectable for tests.
 */
export function resolveUserAttachments(
  inputs: readonly ReportAttachmentInput[] | undefined,
  onError: (error: unknown) => void,
  generateName: () => string = randomBundleName,
): ResolvedUserAttachment[] {
  if (inputs === undefined) {
    return [];
  }
  if (!Array.isArray(inputs)) {
    onError(new Error('Report attachments must be an array; none were attached'));
    return [];
  }
  const out: ResolvedUserAttachment[] = [];
  const used = new Set<string>();
  for (const input of inputs as readonly unknown[]) {
    const candidate = input as Partial<ReportAttachmentInput> | null;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof candidate.name !== 'string' ||
      candidate.name === '' ||
      (typeof candidate.data !== 'string' && !(candidate.data instanceof Uint8Array))
    ) {
      onError(
        new Error(
          `Report attachment ${label(input)} is malformed (needs a name and string or Uint8Array data); dropped`,
        ),
      );
      continue;
    }
    if (out.length >= MAX_USER_ATTACHMENTS) {
      onError(
        new Error(
          `Report attachment ${label(input)} dropped: at most ${MAX_USER_ATTACHMENTS} attachments per report`,
        ),
      );
      continue;
    }
    const { name, data } = candidate as ReportAttachmentInput;
    const size = typeof data === 'string' ? utf8ByteLength(data) : data.byteLength;
    if (size > MAX_USER_ATTACHMENT_BYTES) {
      onError(
        new Error(
          `Report attachment ${label(input)} dropped: ${size} bytes exceeds the 3 MB limit`,
        ),
      );
      continue;
    }
    let bundleName = `${generateName()}.attachment.bgsfile`;
    for (let n = 2; used.has(bundleName); n += 1) {
      bundleName = `${generateName()}${n}.attachment.bgsfile`;
    }
    used.add(bundleName);
    out.push({
      bundleName,
      name,
      mimeType:
        candidate.mimeType ??
        (typeof data === 'string' ? 'text/plain' : 'application/octet-stream'),
      fileName: sanitizeAttachmentFileName(candidate.fileName ?? name),
      data,
    });
  }
  return out;
}

/** Append an attachment to a report (the helper form of writing `report.userAttachments` directly). */
export function addReportAttachment(report: Report, attachment: ReportAttachmentInput): void {
  report.userAttachments = [...(report.userAttachments ?? []), attachment];
}
