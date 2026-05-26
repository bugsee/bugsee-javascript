// @bugsee/protocol — canonical wire shapes: types + serializers + sanitizer lists + option-key
// translator + enum maps (design §8). The single source of truth for the wire contract. Tier 0.
// Built incrementally; this is the level/severity translation component (§8.9).

export {
  LogLevel,
  logLevelFromWire,
  logLevelToWire,
  Severity,
  severityFromWire,
  severityToWire,
} from './levels';
export { optionKeyFromWire, optionKeyToWire, optionsToWire } from './options';
export { sanitizeHeaders, sanitizeJson, sanitizeParams } from './sanitize';
export {
  isSensitiveHeader,
  isSensitiveKey,
  REDACTED,
  REDACTED_URL_ENCODED,
  SENSITIVE_HEADERS,
  SENSITIVE_KEY_SUBSTRINGS,
} from './sensitive';
export { redactShapes, type ShapeRedactionOptions } from './shapes';
