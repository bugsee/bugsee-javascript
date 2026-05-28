import type { Client, Interceptor } from '@bugsee/core';
import type { LogLevelName } from '@bugsee/types';
import { jsonSafeStringify } from '@bugsee/util';

// Cross-runtime console capture SOURCE (design §16.2 Interceptor): patches the global `console`
// methods, emits a LogEvent to client.hubs.log on each call, and calls through to the original so the
// app's own logging is preserved. `console` is universal across every target runtime (browser/workers/
// Node≥18/Bun/Deno/edge), and patching `globalThis.console[method]` is the same technique everywhere,
// so this lives in the shared @bugsee/capture package rather than per platform.
//
// The only runtime-variable concern is argument FORMATTING: Node has util.format/inspect, others do
// not. The default formatter is a portable join + json-safe stringify (no printf %-substitution); a
// platform wanting full fidelity injects its own `format` (e.g. node's util.format).

// `console` is a DOM/Node lib global; this package carries no such lib types, so reach it via a cast.
type ConsoleLike = Record<string, ((...args: unknown[]) => void) | undefined>;
const getConsole = (): ConsoleLike | undefined =>
  (globalThis as unknown as { console?: ConsoleLike }).console;

// console method → captured log level. log/info → info, debug → debug, warn → warning, error → error.
const DEFAULT_LEVELS: Record<string, LogLevelName> = {
  log: 'info',
  info: 'info',
  debug: 'debug',
  warn: 'warning',
  error: 'error',
};

/** Stringify one console argument: strings as-is, Errors as their stack, objects as JSON, else String. */
const stringifyArg = (arg: unknown): string => {
  if (typeof arg === 'string') {
    return arg;
  }
  if (arg instanceof Error) {
    return arg.stack ?? `${arg.name}: ${arg.message}`;
  }
  if (typeof arg === 'object' && arg !== null) {
    return jsonSafeStringify(arg);
  }
  return String(arg);
};

/** Portable default console formatter: join the args with a space, stringifying each (no %-substitution). */
export const formatConsoleArgs = (args: readonly unknown[]): string =>
  args.map(stringifyArg).join(' ');

export interface ConsoleInterceptorOptions {
  /** console method → log level. Default: log/info→info, debug→debug, warn→warning, error→error. */
  levels?: Record<string, LogLevelName>;
  /** Formats console arguments into a log message. Default: {@link formatConsoleArgs}. */
  format?: (args: readonly unknown[]) => string;
  /** Wall-clock source for the event timestamp; injectable for tests. Default Date.now. */
  now?: () => number;
}

export function createConsoleInterceptor(options: ConsoleInterceptorOptions = {}): Interceptor {
  const levels = options.levels ?? DEFAULT_LEVELS;
  const format = options.format ?? formatConsoleArgs;
  const now = options.now ?? (() => Date.now());
  const originals = new Map<string, (...args: unknown[]) => void>();
  // Re-entrancy guard: if a log-hub subscriber itself logs, the nested console call must pass through
  // without re-emitting (no recursion / double capture).
  let capturing = false;

  return {
    name: 'console',

    start(client: Client): void {
      const con = getConsole();
      if (con === undefined) {
        return;
      }
      for (const [method, level] of Object.entries(levels)) {
        const original = con[method];
        if (typeof original !== 'function') {
          continue; // method not present in this runtime's console
        }
        originals.set(method, original);
        con[method] = (...args: unknown[]): void => {
          if (!capturing) {
            capturing = true;
            try {
              client.hubs.log.emit({
                timestamp: now(),
                level,
                source: 'console',
                message: format(args),
              });
            } finally {
              capturing = false;
            }
          }
          original.apply(con, args);
        };
      }
    },

    stop(): void {
      const con = getConsole();
      if (con !== undefined) {
        for (const [method, original] of originals) {
          con[method] = original;
        }
      }
      originals.clear();
    },
  };
}
