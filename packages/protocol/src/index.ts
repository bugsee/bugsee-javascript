// @bugsee/protocol — canonical wire shapes: types + sanitizer lists + shape redaction + option-key
// translator + enum maps. The single source of truth for the wire contract.
// Serializers + URL/stack scrubbing are core-coupled and live in @bugsee/core.

export {
  APP_TOKEN_FILENAME,
  BUNDLE_FILE_SUFFIX,
  DEFAULT_FILENAMES,
  type FileType,
  INPUT_STREAM_VERSION,
  MANIFEST_JSON_FILENAME,
  MANIFEST_VERSION,
  NAME_SOURCE_ATTRIBUTE,
  REQUEST_JSON_FILENAME,
  VIDEO_AUX_VERSION,
} from './constants';
export {
  LogLevel,
  logLevelFromWire,
  logLevelToWire,
  Severity,
  severityFromWire,
  severityToWire,
} from './levels';
export { sanitizeLocationName, sanitizeLocationUrl, TRUNCATED_URL_MARKER } from './location-url';
export {
  BugseeOption,
  type BugseeOptionKey,
  type BugseeOptionTypes,
  optionKeyFromWire,
  optionKeyToWire,
  optionsToWire,
} from './options';
export {
  contentTypeOf,
  gateNetworkBody,
  type NetworkBodyGateOptions,
  sanitizeBody,
  sanitizeHeaders,
  sanitizeJson,
  sanitizeParams,
} from './sanitize';
export {
  isSensitiveHeader,
  isSensitiveKey,
  REDACTED,
  REDACTED_URL_ENCODED,
  SENSITIVE_HEADERS,
  SENSITIVE_KEY_SUBSTRINGS,
} from './sensitive';
export { redactShapes, type ShapeRedactionOptions } from './shapes';
export { bytesToMegabytes } from './units';
export { sanitizeErrorMessage, sanitizeUrl } from './url';
export type {
  EnvironmentEnvelope,
  ManifestFileEntry,
  ManifestJson,
  Mechanism,
  NetworkDirection,
  NetworkEvent,
  NetworkMechanism,
  NetworkStage,
  NoBodyReason,
  ReportingTriggerType,
  RequestJson,
  RuntimeType,
} from './wire';
