// @bugsee/protocol — canonical wire shapes: types + sanitizer lists + shape redaction + option-key
// translator + enum maps (design §8). The single source of truth for the wire contract. Tier 0.
// Serializers + URL/stack scrubbing (§8.10/§14.3) are core-coupled and live in @bugsee/core.

export {
  APP_TOKEN_FILENAME,
  BUNDLE_FILE_SUFFIX,
  DEFAULT_FILENAMES,
  type FileType,
  MANIFEST_JSON_FILENAME,
  MANIFEST_VERSION,
  REQUEST_JSON_FILENAME,
} from './constants';
export {
  LogLevel,
  logLevelFromWire,
  logLevelToWire,
  Severity,
  severityFromWire,
  severityToWire,
} from './levels';
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
  PlatformType,
  ReportingTriggerType,
  RequestJson,
} from './wire';
