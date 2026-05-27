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

export function assembleBundle(
  request: ReportingRequest,
  capturedByType: Map<FileType, CaptureDataEntry[]>,
  context: BundleAssemblyContext,
): Bundle {
  const { report, source } = request;
  const now = context.clock.wallNow();

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
    ...(report.email !== undefined ? { email: report.email } : {}),
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
    // Core produces only JSON file types (log/network/events/traces/breadcrumbs). Binary streams
    // (§8.4: replay/screenshot/attachment) are platform-tier provider concerns; when those land the
    // assembler must branch on type (pass Uint8Array `data` through) instead of JSON-stringifying.
    typedFiles.push({ name: filename, data: JSON.stringify(entries.map((entry) => entry.data)) });
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
