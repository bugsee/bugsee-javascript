import { type Interceptor, InterceptorBase, type LogEvent } from '@bugsee/core';
import type { LogLevelName } from '@bugsee/types';
import { jsonSafeStringify } from '@bugsee/util';

// Cross-runtime console capture SOURCE (design §16.2): patches the global `console` methods, emits a
// LogEvent to client.hubs.log on each call, and calls through to the original so the app's own
// logging is preserved. `console` is universal across every target runtime, and patching
// `globalThis.console[method]` is the same technique everywhere, so this lives in the shared
// @bugsee/capture package rather than per platform.
//
// It is also LISTENABLE (extends InterceptorBase → the multi-key emitter): subscribers can observe the
// 'log' stage via `interceptor.on('log', e => …)`, in addition to the hub-based capture path.
//
// The only runtime-variable concern is argument FORMATTING: Node has util.format/inspect, others do
// not. The default formatter is a portable join + json-safe stringify; a platform wanting full
// fidelity injects its own `format` (e.g. node's util.format).

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

/** The console interceptor's observable stages: 'log' fires with the captured LogEvent on each call. */
export interface ConsoleStageMap {
  log: LogEvent;
}

export interface ConsoleInterceptorOptions {
  /** console method → log level. Default: log/info→info, debug→debug, warn→warning, error→error. */
  levels?: Record<string, LogLevelName>;
  /** Formats console arguments into a log message. Default: {@link formatConsoleArgs}. */
  format?: (args: readonly unknown[]) => string;
  /** Wall-clock source for the event timestamp; injectable for tests. Default Date.now. */
  now?: () => number;
}

class ConsoleInterceptor extends InterceptorBase<ConsoleStageMap> {
  readonly name = 'console';
  readonly #levels: Record<string, LogLevelName>;
  readonly #format: (args: readonly unknown[]) => string;
  readonly #now: () => number;
  readonly #originals = new Map<string, (...args: unknown[]) => void>();
  // Re-entrancy guard: if a log subscriber (hub or stage hook) itself logs, the nested console call
  // must pass through without re-emitting (no recursion / double capture).
  #capturing = false;

  constructor(options: ConsoleInterceptorOptions = {}) {
    super();
    this.#levels = options.levels ?? DEFAULT_LEVELS;
    this.#format = options.format ?? formatConsoleArgs;
    this.#now = options.now ?? (() => Date.now());
  }

  protected onActivate(): void {
    const con = getConsole();
    if (con === undefined) {
      return;
    }
    for (const [method, level] of Object.entries(this.#levels)) {
      const original = con[method];
      if (typeof original !== 'function') {
        continue; // method not present in this runtime's console
      }
      this.#originals.set(method, original);
      con[method] = (...args: unknown[]): void => {
        if (!this.#capturing) {
          this.#capturing = true;
          try {
            this.emit('log', {
              timestamp: this.#now(),
              level,
              source: 'console',
              message: this.#format(args),
            });
          } finally {
            this.#capturing = false;
          }
        }
        original.apply(con, args);
      };
    }
  }

  protected override onDeactivate(): void {
    const con = getConsole();
    if (con !== undefined) {
      for (const [method, original] of this.#originals) {
        con[method] = original;
      }
    }
    this.#originals.clear();
  }
}

export function createConsoleInterceptor(
  options?: ConsoleInterceptorOptions,
): Interceptor<ConsoleStageMap> {
  return new ConsoleInterceptor(options);
}
