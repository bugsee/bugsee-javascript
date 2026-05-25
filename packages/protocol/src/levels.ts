import type { LogLevelName, SeverityName } from '@bugsee/types';

// Numeric wire values (design §8.9). The public API is string-typed (@bugsee/types); this layer
// translates to/from the mobile-compatible numerics. Severity ascends with severity (1=VeryLow,
// 5=Blocker); log level: 1=Error .. 5=Verbose.

export enum LogLevel {
  Error = 1,
  Warning = 2,
  Info = 3,
  Debug = 4,
  Verbose = 5,
}

export enum Severity {
  VeryLow = 1,
  Medium = 2,
  High = 3,
  Critical = 4,
  Blocker = 5,
}

const LOG_LEVEL_BY_NAME: Record<LogLevelName, LogLevel> = {
  error: LogLevel.Error,
  warning: LogLevel.Warning,
  info: LogLevel.Info,
  debug: LogLevel.Debug,
  verbose: LogLevel.Verbose,
};

/** Translates a public log-level name to its numeric wire value. */
export function logLevelToWire(name: LogLevelName): LogLevel {
  return LOG_LEVEL_BY_NAME[name];
}

/** Translates a numeric wire log level back to its name; throws on an unknown value. */
export function logLevelFromWire(value: number): LogLevelName {
  switch (value) {
    case LogLevel.Error:
      return 'error';
    case LogLevel.Warning:
      return 'warning';
    case LogLevel.Info:
      return 'info';
    case LogLevel.Debug:
      return 'debug';
    case LogLevel.Verbose:
      return 'verbose';
    default:
      throw new RangeError(`Unknown log level wire value: ${value}`);
  }
}

const SEVERITY_BY_NAME: Record<SeverityName, Severity> = {
  verylow: Severity.VeryLow,
  low: Severity.VeryLow, // iOS alias for verylow (design §8.9)
  medium: Severity.Medium,
  high: Severity.High,
  critical: Severity.Critical,
  blocker: Severity.Blocker,
};

/** Translates a public severity name (incl. the `low` alias) to its numeric wire value. */
export function severityToWire(name: SeverityName): Severity {
  return SEVERITY_BY_NAME[name];
}

/** Translates a numeric wire severity back to its canonical name (1 -> verylow); throws on unknown. */
export function severityFromWire(value: number): SeverityName {
  switch (value) {
    case Severity.VeryLow:
      return 'verylow';
    case Severity.Medium:
      return 'medium';
    case Severity.High:
      return 'high';
    case Severity.Critical:
      return 'critical';
    case Severity.Blocker:
      return 'blocker';
    default:
      throw new RangeError(`Unknown severity wire value: ${value}`);
  }
}
