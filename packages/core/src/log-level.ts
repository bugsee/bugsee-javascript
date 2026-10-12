import { type LogLevel, logLevelToWire } from '@bugsee/protocol';
import type { LogLevelName } from '@bugsee/types';

// `captureLogsLevel` (Android `Options.CaptureLogsLevel`): the minimum severity of a log record worth
// capturing. Wire levels ascend in VERBOSITY (1=Error … 5=Verbose), so "at or above the threshold" is
// numerically `<=`.

const NAMES: readonly string[] = ['error', 'warning', 'info', 'debug', 'verbose'];

/**
 * A log-level name from untrusted input (a launch option): the canonical name (case-insensitive), or the
 * integer wire level 1-5 (1 = error … 5 = verbose, the mobile SDKs' numeric form); else `undefined`.
 */
export function parseLogLevelName(value: unknown): LogLevelName | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? (NAMES[value - 1] as LogLevelName | undefined) : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const name = value.trim().toLowerCase();
  return NAMES.includes(name) ? (name as LogLevelName) : undefined;
}

/** True when a record of `level` is at least as severe as `threshold` (so it should be captured). */
export function isLogLevelEnabled(
  level: LogLevel | LogLevelName,
  threshold: LogLevelName,
): boolean {
  const wire = typeof level === 'string' ? logLevelToWire(level) : level;
  return wire <= logLevelToWire(threshold);
}
