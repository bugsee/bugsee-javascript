// @bugsee/logger — the SDK's internal diagnostic logger (the `debug.*` used across the SDK,
// gated by __BUGSEE_DEBUG__). Standalone (design §5). Distinct from the captured-log pipeline:
// these are SDK self-diagnostics, not user log entries, so the levels differ from LogLevelName.

/** Configured verbosity. `silent` suppresses everything. */
export type LoggerLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
/** Levels a message can be emitted at (everything except `silent`). */
export type LogLevel = Exclude<LoggerLevel, 'silent'>;
/** A sink that receives emitted messages. */
export type LogHandler = (level: LogLevel, args: readonly unknown[]) => void;

export interface Logger {
  setLevel(level: LoggerLevel): void;
  getLevel(): LoggerLevel;
  /** Registers a sink; returns a function that unregisters it. */
  addHandler(handler: LogHandler): () => void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  /** Emits a warning at most once per `key` (for "one-time" diagnostics). */
  warnOnce(key: string, ...args: unknown[]): void;
}

const RANK: Record<LoggerLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export function createLogger(initialLevel: LoggerLevel = 'error'): Logger {
  let level: LoggerLevel = initialLevel;
  const handlers = new Set<LogHandler>();
  const warnedKeys = new Set<string>();

  // Returns whether the message was deliverable at the current level (used by warnOnce).
  const emit = (messageLevel: LogLevel, args: unknown[]): boolean => {
    if (RANK[messageLevel] > RANK[level]) {
      return false;
    }
    Object.freeze(args); // handlers must treat args as immutable; freezing enforces it
    // Snapshot so a handler that (un)registers handlers mid-emit doesn't affect this delivery.
    for (const handler of [...handlers]) {
      try {
        handler(messageLevel, args);
      } catch {
        // A faulty sink must never break SDK logging or starve other sinks.
      }
    }
    return true;
  };

  return {
    setLevel(next: LoggerLevel): void {
      level = next;
    },
    getLevel(): LoggerLevel {
      return level;
    },
    addHandler(handler: LogHandler): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    error(...args: unknown[]): void {
      emit('error', args);
    },
    warn(...args: unknown[]): void {
      emit('warn', args);
    },
    info(...args: unknown[]): void {
      emit('info', args);
    },
    debug(...args: unknown[]): void {
      emit('debug', args);
    },
    warnOnce(key: string, ...args: unknown[]): void {
      if (warnedKeys.has(key)) {
        return;
      }
      // Consume the key only if the warning was actually delivered, so a warning first hit
      // while suppressed can still surface once verbosity is raised.
      if (emit('warn', args)) {
        warnedKeys.add(key);
      }
    },
  };
}
