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
