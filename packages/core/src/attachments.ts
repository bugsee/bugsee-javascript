import { fromBase64, toBase64, utf8ByteLength } from '@bugsee/util';
import type { Report, ReportAttachmentInput, ReportingRequest } from './reporting';

// Application-supplied report attachments (Android `Report.addAttachment`, iOS `BugseeAttachment`).
// Limits: at most 3 attachments of 3 MB each (iOS `BugseeAttachment`; Android caps at 1000 attachments). An attachment that breaks a rule is
// DROPPED and reported through `onError` — a report is never lost, and the app never sees a throw, because
// the attachment usually rides a crash report that is the only record of the incident.

/** Attachments per report (iOS parity). */
export const MAX_USER_ATTACHMENTS = 3;
/** Bytes per attachment, 3 MB (iOS parity). */
export const MAX_USER_ATTACHMENT_BYTES = 3 * 1024 * 1024;

const MAX_FILE_NAME_LENGTH = 128;
const FALLBACK_FILE_NAME = 'attachment';
const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyz0123456789';
// ASCII control characters (U+0000-U+001F, U+007F); built from code points so the source has no literal controls.
const CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
);
// Bidirectional controls (LRM/RLM/ALM, embeddings/overrides U+202A-202E, isolates U+2066-2069): they let a
// name like `invoice\u202Etxt.exe` render as `invoiceexe.txt`.
const BIDI_CHARS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

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
  const base = (
    raw.replace(CONTROL_CHARS, '').replace(BIDI_CHARS, '').split(/[\\/]/).pop() as string
  ).trim();
  if (base === '' || base === '.' || base === '..') {
    return FALLBACK_FILE_NAME;
  }
  const cut = base.slice(0, MAX_FILE_NAME_LENGTH);
  // Never end on half a surrogate pair (an emoji straddling the cut would become a lone surrogate).
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff && base.length > cut.length ? cut.slice(0, -1) : cut;
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
  rawOnError: (error: unknown) => void,
  generateName: () => string = randomBundleName,
): ResolvedUserAttachment[] {
  // The sink is the application's callback: a throw from it must never cost the report these attachments
  // ride on, whether we are reporting a malformed one or the catch below is.
  const onError = (error: unknown): void => {
    try {
      rawOnError(error);
    } catch {
      // swallowed on purpose: the report matters more than the app's diagnostics
    }
  };
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
    // One bad attachment (a hostile getter, a wrong type) must never lose the report it rides on.
    try {
      const resolved = resolveOne(input, out.length, used, onError, generateName);
      if (resolved !== undefined) {
        out.push(resolved);
      }
    } catch (error) {
      onError(new Error(`Report attachment ${safeLabel(input)} dropped: ${errorText(error)}`));
    }
  }
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'unreadable';
}

function safeLabel(input: unknown): string {
  try {
    return label(input);
  } catch {
    return '(unreadable)';
  }
}

function resolveOne(
  input: unknown,
  accepted: number,
  used: Set<string>,
  onError: (error: unknown) => void,
  generateName: () => string,
): ResolvedUserAttachment | undefined {
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
    return undefined;
  }
  if (accepted >= MAX_USER_ATTACHMENTS) {
    onError(
      new Error(
        `Report attachment ${label(input)} dropped: at most ${MAX_USER_ATTACHMENTS} attachments per report`,
      ),
    );
    return undefined;
  }
  const { name, data } = candidate as ReportAttachmentInput;
  const size = typeof data === 'string' ? utf8ByteLength(data) : data.byteLength;
  if (size === 0) {
    onError(new Error(`Report attachment ${label(input)} dropped: it has no data`));
    return undefined;
  }
  if (size > MAX_USER_ATTACHMENT_BYTES) {
    onError(
      new Error(`Report attachment ${label(input)} dropped: ${size} bytes exceeds the 3 MB limit`),
    );
    return undefined;
  }
  let mimeType = candidate.mimeType;
  if (mimeType !== undefined && typeof mimeType !== 'string') {
    onError(new Error(`Report attachment ${label(input)}: ignoring a non-string mimeType`));
    mimeType = undefined;
  }
  let fileName = candidate.fileName;
  if (fileName !== undefined && typeof fileName !== 'string') {
    onError(new Error(`Report attachment ${label(input)}: ignoring a non-string fileName`));
    fileName = undefined;
  }
  let bundleName = `${generateName()}.attachment.bgsfile`;
  for (let n = 2; used.has(bundleName); n += 1) {
    bundleName = `${generateName()}${n}.attachment.bgsfile`;
  }
  used.add(bundleName);
  return {
    bundleName,
    name,
    mimeType: mimeType ?? (typeof data === 'string' ? 'text/plain' : 'application/octet-stream'),
    fileName: sanitizeAttachmentFileName(fileName ?? name),
    data,
  };
}

/**
 * Apply the limits and naming to `report.userAttachments` NOW, in place — at submit time, before the
 * crash-recovery marker is written, so what the marker persists is already bounded (3 x 3 MB) and valid.
 * Idempotent: the assembler resolves again and finds nothing left to drop.
 */
export function normalizeReportAttachments(
  report: Report,
  onError: (error: unknown) => void,
): void {
  if (report.userAttachments === undefined) {
    return;
  }
  report.userAttachments = resolveUserAttachments(report.userAttachments, onError).map(
    ({ name, data, mimeType, fileName }) => ({ name, data, mimeType, fileName }),
  );
}

/**
 * A COPY of `request` whose attachments have the limits applied, for a request that could not be normalised in
 * place (a handler froze the report). The marker must never encode attachments the limits would drop - 3 x 3 MB
 * is the bound, not "whatever the app attached". Silent: assembly reports the drops. The request itself
 * is returned when it carries none.
 */
export function limitAttachmentsForMarker(request: ReportingRequest): ReportingRequest {
  let attachments: readonly ReportAttachmentInput[] | undefined;
  let readable = true;
  try {
    attachments = request.report.userAttachments;
  } catch {
    readable = false; // a hostile getter: the marker carries no attachments rather than a guess
  }
  if (readable && attachments === undefined) {
    return request;
  }
  const report = {} as Record<string, unknown>;
  for (const key of Object.keys(request.report)) {
    if (key !== 'userAttachments') {
      report[key] = (request.report as unknown as Record<string, unknown>)[key];
    }
  }
  report.userAttachments = readable
    ? resolveUserAttachments(attachments, () => undefined).map(
        ({ name, data, mimeType, fileName }) => ({ name, data, mimeType, fileName }),
      )
    : [];
  return { ...request, report: report as unknown as Report };
}

// The crash is the part of a report an `after` handler most plausibly SCRUBS (frame locals, source context, the
// cause chain, the message), so it must be in the signature. The WHOLE crash is serialised:
// listing the fields that matter missed `exception.cause`, `exception.name` and `domain`, so scrubbing a cause
// chain left the marker holding the unscrubbed one. Measured 0.05 ms for a 10-frame crash and 1.1 ms for a 1 MB one.
function crashFingerprint(crash: Report['crash']): unknown {
  return crash === undefined ? null : JSON.stringify(crash);
}

// A 32-bit FNV-1a over the content plus its length: O(n), allocation-free, so a same-length rewrite (mask with
// `*`, `fill(0)`) cannot hide behind an unchanged size. A collision needs an edit that keeps both the length
// and the hash (about 1 in 4 billion); the cost of one is a marker that keeps the pre-edit attachment.
function contentHash(data: Uint8Array | string): string {
  let hash = 0x811c9dc5;
  const length = typeof data === 'string' ? data.length : data.byteLength;
  for (let i = 0; i < length; i += 1) {
    const unit = typeof data === 'string' ? data.charCodeAt(i) : (data[i] as number);
    hash = Math.imul(hash ^ unit, 0x01000193);
  }
  return `${length}:${(hash >>> 0).toString(36)}`;
}

/**
 * A cheap signature of what a report-handler can change and the recovery marker carries: summary,
 * description, email, severity, labels, attributes, signatures, the whole crash, and every attachment's name,
 * type and CONTENT (a length plus two FNV-1a hashes: an edit that keeps the size, such as redacting with `*` or
 * zero-filling, is still a change). Covers both the application's `userAttachments` and the SDK's own
 * `attachments` (a `.dmp`), including their removal. `undefined` when the report cannot be read (a hostile
 * getter), which callers treat as "changed" so the marker is rewritten.
 */
export function reportChangeSignature(report: Report): string | undefined {
  try {
    const attachments = (report.userAttachments ?? []).map((a) => [
      a.name,
      contentHash(a.data),
      a.mimeType,
      a.fileName,
    ]);
    const sdkAttachments = (report.attachments ?? []).map((a) => [a.name, contentHash(a.data)]);
    return JSON.stringify([
      report.type,
      report.severity,
      report.summary,
      report.description,
      report.email,
      report.labels,
      report.attributes,
      report.signatures,
      attachments,
      sdkAttachments,
      crashFingerprint(report.crash),
    ]);
  } catch {
    return undefined;
  }
}

// A marker is JSON on disk and in IndexedDB; `JSON.stringify(Uint8Array)` is `{"0":1,"1":2,...}` (~14 bytes
// per byte, and not recoverable as bytes). Binary attachment data is therefore stored as base64 under
// `dataBase64` (with `data: ''`), and decoded again when the incident is rebuilt.
type MarkerAttachment = ReportAttachmentInput & { dataBase64?: string };

/**
 * A copy of `request` that survives `JSON.stringify`; `request` itself is returned when it has no attachments.
 *
 * Cost: base64 + JSON of the maximum (3 x 3 MB) is measured at ~279 ms of SYNCHRONOUS work on the thread that
 * reports. It is deliberately not chunked: the marker must be handed to the store in the same turn as the
 * incident (a deferred write can lose it to the very crash it records), and an attachment that large is the
 * application's own choice. Typical attachments (a few KB of state) cost microseconds.
 */
export function encodeRequestForMarker(request: ReportingRequest): ReportingRequest {
  const { userAttachments, attachments } = request.report;
  if (userAttachments === undefined && attachments === undefined) {
    return request;
  }
  const encode = <T extends { name: string; data: Uint8Array | string }>(
    list: readonly T[],
  ): MarkerAttachment[] =>
    list.map(
      (a): MarkerAttachment =>
        typeof a.data === 'string' ? a : { ...a, data: '', dataBase64: toBase64(a.data) },
    );
  return {
    ...request,
    report: {
      ...request.report,
      // SDK-internal attachments (a harvested native-crash `.dmp`) are binary too and cross the same JSON hop.
      ...(userAttachments !== undefined ? { userAttachments: encode(userAttachments) } : {}),
      ...(attachments !== undefined ? { attachments: encode(attachments) } : {}),
    },
  };
}

/** Inverse of {@link encodeRequestForMarker}; an attachment whose payload cannot be decoded is dropped to `onError`. */
export function decodeRequestFromMarker(
  request: ReportingRequest,
  onError: (error: unknown) => void,
): ReportingRequest {
  const { userAttachments, attachments } = request.report as {
    userAttachments?: unknown;
    attachments?: unknown;
  };
  if (userAttachments === undefined && attachments === undefined) {
    return request;
  }
  const decode = (list: unknown): ReportAttachmentInput[] => {
    if (!Array.isArray(list)) {
      onError(new Error('Recovered attachments dropped: not a list'));
      return [];
    }
    const decoded: ReportAttachmentInput[] = [];
    for (const item of list as unknown[]) {
      // Marker and renderer input is untrusted: one bad element must not cost the whole incident.
      if (item === null || typeof item !== 'object') {
        onError(new Error('Recovered attachment dropped: not an object'));
        continue;
      }
      const { dataBase64, ...rest } = item as MarkerAttachment;
      if (dataBase64 === undefined) {
        decoded.push(rest);
        continue;
      }
      if (typeof dataBase64 !== 'string') {
        // A damaged marker: decoding a number/object would manufacture garbage bytes, not an attachment.
        onError(
          new Error(`Recovered attachment ${safeLabel(rest)} dropped: its payload is not a string`),
        );
        continue;
      }
      try {
        decoded.push({ ...rest, data: fromBase64(dataBase64) });
      } catch (error) {
        onError(new Error(`Recovered attachment ${safeLabel(rest)} dropped: ${errorText(error)}`));
      }
    }
    return decoded;
  };
  return {
    ...request,
    report: {
      ...request.report,
      ...(userAttachments !== undefined ? { userAttachments: decode(userAttachments) } : {}),
      ...(attachments !== undefined ? { attachments: decode(attachments) as never } : {}),
    },
  };
}

/** Append an attachment to a report (the helper form of writing `report.userAttachments` directly). */
export function addReportAttachment(report: Report, attachment: ReportAttachmentInput): void {
  report.userAttachments = [...(report.userAttachments ?? []), attachment];
}
