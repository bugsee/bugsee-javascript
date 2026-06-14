import {
  APP_TOKEN_FILENAME,
  BUNDLE_FILE_SUFFIX,
  DEFAULT_FILENAMES,
  type EnvironmentEnvelope,
  type FileType,
  MANIFEST_JSON_FILENAME,
  MANIFEST_VERSION,
  type ManifestFileEntry,
  type ManifestJson,
  REQUEST_JSON_FILENAME,
  type RequestJson,
  severityToWire,
} from '@bugsee/protocol';
import type { AttributeValue, IssueType } from '@bugsee/types';
import { type BundleFile, writeBundleZip } from './bundle-writer';
import type { Clock } from './clock';
import type { CaptureDataEntry } from './contracts';
import type { ReportingRequest } from './reporting';
import type { Bundle } from './transport';

// Report assembly (design §7.7 trigger path, §8.4/§8.5 bundle layout, Android CaptureExporter). Turns
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
  /** Clock for created_on + manifest time bounds. */
  clock: Clock;
  /** Bundle archive name; defaults to `<random20>.bundle.zip`. Injectable for tests. */
  fileName?: () => string;
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

// Per-type JSON shape. Most file types serialize to a top-level ARRAY of payloads. Two exceptions:
// `performance.json` = `{ transactions: [...] }` (§711/§8.8), and `profile.json` = the SINGLE bare V8 CPU
// profile object (.cpuprofile — DevTools/speedscope-loadable). Binary streams (§8.4: replay/screenshot/
// attachment) are platform-tier provider concerns; when those land the assembler branches further
// (passing a Uint8Array `data` through).
function serializeFileData(type: FileType, payloads: unknown[]): unknown {
  if (type === 'performance') {
    return { transactions: payloads };
  }
  if (type === 'profile') {
    // The single CPU profile captured at report time. The assembler only iterates file types that have
    // ≥1 entry (CaptureExporter.drain seeds non-empty groups; the profile snapshot emits 0-or-1 and omits
    // the key when 0), so payloads[0] is always present here.
    return payloads[0];
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

  // Wire `email` = a per-report email if set, else the global user identifier (Android "email from
  // global scope"). Emitted only when it is a non-empty string.
  const email = report.email ?? context.userIdentifier ?? undefined;

  // request.json (§8.5): metadata from the Report + the wire source mechanism + the environment.
  const requestJson: RequestJson = {
    type: report.type,
    summary: report.summary ?? defaultSummary(report.type),
    severity: severityToWire(report.severity),
    source: {
      mechanism: source.mechanism ?? 'programmatic',
      ...(source.origin !== undefined ? { origin: source.origin } : {}),
    },
    created_on: new Date(now).toISOString(),
    environment: context.environment,
    ...(report.description !== undefined ? { description: report.description } : {}),
    ...(report.labels.length > 0 ? { labels: report.labels } : {}),
    ...(email !== undefined && email !== '' ? { email } : {}),
    ...(report.signatures.length > 0 ? { signatures: report.signatures } : {}),
  };

  // Time bounds (§7.7): earliest captured entry → trigger moment.
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
    files.push({ filename, type });
    const payloads = entries.map((entry) => entry.data);
    typedFiles.push({ name: filename, data: JSON.stringify(serializeFileData(type, payloads)) });
  }

  const manifest: ManifestJson = {
    version: MANIFEST_VERSION,
    time: { start, end: now },
    files,
    attrs: context.attributes,
  };

  const body = writeBundleZip([
    { name: REQUEST_JSON_FILENAME, data: JSON.stringify(requestJson) },
    { name: MANIFEST_JSON_FILENAME, data: JSON.stringify(manifest) },
    { name: APP_TOKEN_FILENAME, data: context.appToken },
    ...typedFiles,
  ]);

  return { request: requestJson, body, fileName: (context.fileName ?? randomBundleFileName)() };
}
