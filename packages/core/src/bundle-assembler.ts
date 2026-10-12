import {
  APP_TOKEN_FILENAME,
  BUNDLE_FILE_SUFFIX,
  DEFAULT_FILENAMES,
  type EnvironmentEnvelope,
  type FileType,
  INPUT_STREAM_VERSION,
  MANIFEST_JSON_FILENAME,
  MANIFEST_VERSION,
  type ManifestFileEntry,
  type ManifestJson,
  REQUEST_JSON_FILENAME,
  type RequestJson,
  severityToWire,
  VIDEO_AUX_VERSION,
} from '@bugsee/protocol';
import type { AttributeValue, IssueType } from '@bugsee/types';
import { resolveUserAttachments } from './attachments';
import { type BundleFile, writeBundleZip } from './bundle-writer';
import type { Clock } from './clock';
import type { CaptureDataEntry } from './contracts';
import { stampCrashProvenance } from './crash';
import type { ReportingRequest } from './reporting';
import type { RequestContext } from './request-context';
import type { Bundle } from './transport';

// Report assembly (trigger path, bundle layout, Android CaptureExporter). Turns
// a ReportingRequest + the captured data (grouped by file type, from CaptureExporter.drain()) into a
// Bundle: request.json (from the Report + Environment + source mechanism), manifest.json (file
// inventory + time bounds + attributes), the apptoken file, and one JSON file per captured file-type,
// zipped. Pure + synchronous; the Client reads the CaptureExporter (drain()) and passes the data.

export interface BundleAssemblyContext {
  /** Plain-text app token (apptoken file). */
  appToken: string;
  /** Platform-built environment envelope (request.json `environment`). */
  environment: EnvironmentEnvelope;
  /** Global attributes (manifest `attrs`). */
  attributes: Record<string, AttributeValue>;
  /**
   * Global user identifier (Environment.getUserIdentifier()); becomes request.json `email` when set —
   * Android maps the user identifier to the `email` field ("email from global scope"). Null when unset.
   */
  userIdentifier?: string | null;
  /**
   * The active request context captured at report-submit time. When present, its
   * `contextId` becomes request.json `context_id`, and its `user`/`attributes` OVERRIDE the global ones
   * (the report reflects the request it fired in). Absent → global behavior unchanged.
   */
  requestContext?: RequestContext;
  /** Clock for created_on + manifest time bounds. */
  clock: Clock;
  /** Bundle archive name; defaults to `<random20>.bundle.zip`. Injectable for tests. */
  fileName?: () => string;
  /**
   * Per-file-type BINARY encoders. A file type with an encoder here is serialized to bytes by it (e.g.
   * `replay` → the gzipped `replay.bin` rrweb stream, encoder from `@bugsee/replay`) instead of the default
   * JSON path — keeping core codec-free. The encoder receives the type's ordered payloads (`entry.data`).
   */
  fileEncoders?: Partial<Record<FileType, (payloads: unknown[]) => Uint8Array>>;
  /** Sink for non-fatal problems (a dropped user attachment). Absent → they are dropped silently. */
  onError?: (error: unknown) => void;
}

const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomBundleFileName(): string {
  let name = '';
  for (let i = 0; i < 20; i += 1) {
    name += ALPHANUMERIC.charAt(Math.floor(Math.random() * ALPHANUMERIC.length));
  }
  return name + BUNDLE_FILE_SUFFIX;
}

function defaultSummary(type: IssueType): string {
  if (type === 'crash') {
    return 'Crash';
  }
  if (type === 'error') {
    return 'Error';
  }
  return 'Bug Report';
}

function fileNameForType(type: FileType): string {
  return type === 'attachment' ? 'attachment' : DEFAULT_FILENAMES[type];
}

// Per-type JSON shape. Most file types serialize to a top-level ARRAY of payloads. Four exceptions:
// `performance.json` = `{ transactions: [...] }`; `profile.json` = the SINGLE bare V8 CPU
// profile object (.cpuprofile — DevTools/speedscope-loadable); and `input.json` and `video.aux.json`
// carry the wire spec's own versioned envelope, `{ version, events: [...] }`
// (`specs/sdk/reporting/bundle/{input,video-aux}.md`). Those two need the version for the same reason:
// a consumer keys its decoding on it — `button`/`buttonMask`/`metaState`/scroll for `input`, and for
// `video.aux` whether the frame is in display pixels (version 1) or in the coordinates' own units
// (version 2), which are the same numbers meaning different things. Binary streams:
// replay/screenshot/attachment) are platform-tier provider concerns; when those land the assembler
// branches further (passing a Uint8Array `data` through).
function serializeFileData(type: FileType, payloads: unknown[]): unknown {
  if (type === 'performance') {
    return { transactions: payloads };
  }
  if (type === 'video.aux') {
    return { version: VIDEO_AUX_VERSION, events: payloads };
  }
  if (type === 'profile') {
    // The single CPU profile captured at report time. The assembler only iterates file types that have
    // ≥1 entry (CaptureExporter.drain seeds non-empty groups; the profile snapshot emits 0-or-1 and omits
    // the key when 0), so payloads[0] is always present here.
    return payloads[0];
  }
  if (type === 'input') {
    return { version: INPUT_STREAM_VERSION, events: payloads };
  }
  return payloads;
}

export function assembleBundle(
  request: ReportingRequest,
  capturedByType: Map<FileType, CaptureDataEntry[]>,
  context: BundleAssemblyContext,
): Bundle {
  const { report, source } = request;
  const now = context.clock.wallNow();

  // Wire `email` = a per-report email if set, else the request-context user (when the report fired in a
  // request), else the global user identifier (Android "email from global scope"). Emitted only when it
  // is a non-empty string.
  const requestContext = context.requestContext;
  // An empty request-context user means "no request user" → fall back to the global user (|| coerces ''
  // to undefined so the ?? chain continues), rather than emitting/suppressing an empty email.
  const email =
    report.email ?? (requestContext?.user || undefined) ?? context.userIdentifier ?? undefined;

  // request.json: metadata from the Report + the wire source mechanism + the environment.
  const requestJson: RequestJson = {
    type: report.type,
    summary: report.summary ?? defaultSummary(report.type),
    severity: severityToWire(report.severity),
    source: {
      // The TRIGGER, which the collector classifies on and matches notification filters against.
      type: source.type,
      mechanism: source.mechanism ?? 'programmatic',
      ...(source.origin !== undefined ? { origin: source.origin } : {}),
    },
    created_on: new Date(now).toISOString(),
    environment: context.environment,
    ...(requestContext !== undefined ? { context_id: requestContext.contextId } : {}),
    // The active trace → the cross-project join key on the report envelope (T8).
    ...(requestContext?.trace !== undefined
      ? { trace_id: requestContext.trace.traceId, span_id: requestContext.trace.spanId }
      : {}),
    ...(report.description !== undefined ? { description: report.description } : {}),
    ...(report.labels.length > 0 ? { labels: report.labels } : {}),
    ...(email !== undefined && email !== '' ? { email } : {}),
    ...(report.signatures.length > 0 ? { signatures: report.signatures } : {}),
  };

  // Time bounds: earliest captured entry → trigger moment.
  let start = now;
  const files: ManifestFileEntry[] = [];
  const typedFiles: BundleFile[] = [];
  for (const [type, entries] of capturedByType) {
    for (const entry of entries) {
      if (entry.timestamp < start) {
        start = entry.timestamp;
      }
    }
    const filename = fileNameForType(type);
    files.push({
      filename,
      type,
      // A video entry with no attrs reads as the default — an h264 MP4 — to the worker (which then skips the
      // transcode a WebM needs) and to the viewer (which labels it `video/mp4`). The container is whatever
      // the file name says it is.
      ...(type === 'video'
        ? { attrs: { format: filename.slice(filename.lastIndexOf('.') + 1) } }
        : {}),
    });
    const payloads = entries.map((entry) => entry.data);
    // A BINARY file type (e.g. `replay` → gzipped `replay.bin`) goes through its injected encoder → bytes;
    // every other type is JSON. Core stays codec-free — the encoder is provided by the platform/extension.
    const encoder = context.fileEncoders?.[type];
    const data =
      encoder !== undefined ? encoder(payloads) : JSON.stringify(serializeFileData(type, payloads));
    typedFiles.push({ name: filename, data });
  }

  // Structured crash detail (`crash.json`) — a per-report file (not a rolling capture stream) built
  // from the thrown Error at report time. The backend crash pipeline reads it for stack symbolication.
  //
  // The `source_*` provenance is stamped HERE rather than in `buildCrashJson`, because this is the one
  // place that holds both the crash and the environment this bundle emits — which is what the mirror rule
  // requires (the values must be copies of `request.json`'s, taken in the same code path, so they cannot
  // drift). It also means every crash path gets it for free: handled `logException`, each platform's
  // uncaught detection provider, and the recovered native minidump all converge on this line.
  if (report.crash !== undefined) {
    const crashFilename = fileNameForType('crash');
    files.push({ filename: crashFilename, type: 'crash' });
    const crash = stampCrashProvenance(report.crash, context.environment);
    typedFiles.push({ name: crashFilename, data: JSON.stringify(crash) });
  }

  // Report-level attachments (`attachment`) — extra binary/text files written verbatim (e.g. a
  // harvested native-crash `.dmp` referenced by `crash.minidumpFile`). Listed in the manifest by their own
  // filename so the backend can enumerate them.
  // The name is a zip member name and must be unique among the bundle's members: a clash (a `before` handler
  // or a forwarded renderer report supplying one) would make the zip writer throw and lose the whole
  // incident, so the offending attachment is skipped and reported instead.
  const taken = new Set<string>([
    REQUEST_JSON_FILENAME,
    MANIFEST_JSON_FILENAME,
    APP_TOKEN_FILENAME,
    ...typedFiles.map((file) => file.name),
  ]);
  for (const attachment of report.attachments ?? []) {
    const name: unknown = attachment?.name;
    if (typeof name !== 'string' || name === '' || name === '__proto__' || taken.has(name)) {
      context.onError?.(
        new Error(
          `Report attachment skipped: ${typeof name === 'string' ? JSON.stringify(name) : 'its name is not a string'} is not a usable, unused bundle file name`,
        ),
      );
      continue;
    }
    taken.add(name);
    files.push({ filename: name, type: 'attachment' });
    typedFiles.push({ name, data: attachment.data });
  }

  // Application attachments (`Report.userAttachments`, mobile `Report.addAttachment`): limits applied here,
  // the one place every report path passes through. The zip member is `<random20>.attachment.bgsfile` — the
  // mobile layout, never derived from user input — and the label/MIME/download name ride in the manifest
  // entry (`name` + `attrs`), which is where the worker and viewer read them.
  for (const att of resolveUserAttachments(
    report.userAttachments,
    context.onError ?? (() => undefined),
  )) {
    files.push({
      filename: att.bundleName,
      type: 'attachment',
      name: att.name,
      attrs: { name: att.name, mimeType: att.mimeType, fileName: att.fileName },
    });
    typedFiles.push({ name: att.bundleName, data: att.data });
  }

  // Manifest attributes: the request context's attributes (when present) merged OVER the global ones.
  const attrs =
    requestContext?.attributes !== undefined
      ? { ...context.attributes, ...requestContext.attributes }
      : context.attributes;
  const manifest: ManifestJson = {
    version: MANIFEST_VERSION,
    time: { start, end: now },
    files,
    attrs,
  };

  const body = writeBundleZip([
    { name: REQUEST_JSON_FILENAME, data: JSON.stringify(requestJson) },
    { name: MANIFEST_JSON_FILENAME, data: JSON.stringify(manifest) },
    { name: APP_TOKEN_FILENAME, data: context.appToken },
    ...typedFiles,
  ]);

  return { request: requestJson, body, fileName: (context.fileName ?? randomBundleFileName)() };
}
