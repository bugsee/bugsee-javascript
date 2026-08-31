import {
  formatStack,
  type Interceptor,
  InterceptorBase,
  type LogEvent,
  parseV8Stack,
  type StackFrame,
} from '@bugsee/core';
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

// console method → captured log level. log/info → info, debug → debug, warn → warning, error → error,
// trace → verbose.
//
// `trace` maps to `verbose`, not `debug` or a bespoke 'trace' string, for two reasons: (1)
// @bugsee/types#LogLevelName does not declare a `'trace'` member — `'verbose'` is the closest/lowest
// level it DOES declare — and (2) the viewer's own level-name→number map (viewer/src/app/features/
// recording/shared/js-sdk-resource-normalize.ts, LOG_LEVEL_NAME_TO_NUMBER) already maps BOTH `verbose`
// and `trace` to the same numeric severity (5, the lowest/most-verbose tier) — so `'verbose'` renders
// identically to how a literal `'trace'` would have, with no viewer/backend change required.
const DEFAULT_LEVELS: Record<string, LogLevelName> = {
  log: 'info',
  info: 'info',
  debug: 'debug',
  warn: 'warning',
  error: 'error',
  trace: 'verbose',
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

// `console.trace()`'s whole point is the stack trace — the real console prints one below the message —
// but LogEvent (core/events.ts) has no dedicated stack field, and widening it is outside this package's
// files. So the stack is appended to `message` itself: still lost with NO fix, still present (in the
// one field the wire format has) with this one.
//
// `Error.captureStackTrace(error, boundary)` is the same technique @bugsee/core's `callSiteFrames`
// (core/src/stack.ts) uses to drop an SDK's own frames from a captured stack: it removes every frame
// from the point of capture down through AND INCLUDING `boundary` (by function identity, not call
// depth — so routing through this one small helper before reaching `boundary` costs nothing), leaving
// the application's real call site on top. core/stack.ts's own header comment records it as available
// on Chromium, Firefox and WebKit as of 2026-08-26. Where it is unavailable, or the resulting stack has
// no parseable frames, this returns `message` unchanged — exactly today's (pre-fix) behavior — rather
// than guessing at a frame-count to drop; best-effort, never worse than the status quo. And it never
// throws past the caller: a broken stack must not cost the message itself.
//
// `parseStack` is INJECTED (defaults to core's V8-only `parseV8Stack`) rather than hardcoded, mirroring
// core's own `callSiteFrames(error, boundary, parseStack)`. `Error.captureStackTrace` exists on Firefox
// and Safari too (see the header above this function), but `error.stack` there is the SpiderMonkey/
// JavaScriptCore `fn@loc` dialect, which `parseV8Stack` does not recognize (it only matches `at ` lines)
// — so on those engines the plain V8 parser silently yields zero frames and the stack is lost. A
// platform with a multi-engine dispatching parser (e.g. the browser tier's `parseStack`) passes it in
// via `ConsoleInterceptorOptions.stackParser` to recover the stack there too.
const appendCallStack = (
  message: string,
  boundary: (...args: unknown[]) => void,
  parseStack: (stack: string) => StackFrame[],
): string => {
  try {
    const capture = (Error as { captureStackTrace?: (target: object, fn: unknown) => void })
      .captureStackTrace;
    if (typeof capture !== 'function') {
      return message;
    }
    const error = new Error();
    capture(error, boundary);
    const frames = parseStack(error.stack ?? '');
    return frames.length === 0 ? message : `${message}\n${formatStack(frames)}`;
  } catch {
    return message;
  }
};

/** The console interceptor's observable stages: 'log' fires with the captured LogEvent on each call. */
export interface ConsoleStageMap {
  log: LogEvent;
}

export interface ConsoleInterceptorOptions {
  /** console method → log level. Default: log/info→info, debug→debug, warn→warning, error→error,
   *  trace→verbose. See {@link DEFAULT_LEVELS} for why `trace` maps to `verbose`. */
  levels?: Record<string, LogLevelName>;
  /** Formats console arguments into a log message. Default: {@link formatConsoleArgs}. */
  format?: (args: readonly unknown[]) => string;
  /** Wall-clock source for the event timestamp; injectable for tests. Default Date.now. */
  now?: () => number;
  /** Parses `Error.stack` into frames for the `console.trace()` call-stack appended to the message
   *  (see {@link appendCallStack}). Default: core's {@link parseV8Stack} (V8 `at fn (loc)` dialect
   *  only). A platform whose runtimes also include Firefox/Safari should inject a dispatching parser
   *  (e.g. the browser tier's `parseStack`) so the stack is not silently dropped on those engines. */
  stackParser?: (stack: string) => StackFrame[];
}

class ConsoleInterceptor extends InterceptorBase<ConsoleStageMap> {
  readonly name = 'console';
  readonly #levels: Record<string, LogLevelName>;
  readonly #format: (args: readonly unknown[]) => string;
  readonly #now: () => number;
  readonly #stackParser: (stack: string) => StackFrame[];
  readonly #originals = new Map<string, (...args: unknown[]) => void>();
  // Re-entrancy guard: if a log subscriber (hub or stage hook) itself logs, the nested console call
  // must pass through without re-emitting (no recursion / double capture).
  #capturing = false;

  constructor(options: ConsoleInterceptorOptions = {}) {
    super();
    this.#levels = options.levels ?? DEFAULT_LEVELS;
    this.#format = options.format ?? formatConsoleArgs;
    this.#now = options.now ?? (() => Date.now());
    this.#stackParser = options.stackParser ?? parseV8Stack;
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
      const isTrace = method === 'trace';
      // Self-referenced below (as the `boundary` passed to appendCallStack, so captureStackTrace can
      // drop this wrapper's own frame). A `const` arrow function CAN reference itself: the binding is
      // only read the first time the function is CALLED, by which point the `const wrapped = ...`
      // initializer has long finished — so `wrapped` inside the body always resolves to the same
      // function object it is bound to. `let` is neither required nor reassigned here.
      const wrapped = (...args: unknown[]): void => {
        if (!this.#capturing) {
          this.#capturing = true;
          try {
            const message = this.#format(args);
            this.emit('log', {
              timestamp: this.#now(),
              level,
              source: 'console',
              message: isTrace ? appendCallStack(message, wrapped, this.#stackParser) : message,
            });
          } catch {
            // Swallowed on purpose. This runs INSIDE the application's own `console.log` call, so
            // anything escaping here crashes code that was merely logging — and, because the passthrough
            // below sits after this block, the application also loses the line it was printing. Capture
            // is worth losing to avoid that; the reverse is not true.
            //
            // `format` is the reachable source: it is a public option a platform replaces (node passes
            // `util.format`), so it is arbitrary code. Subscriber callbacks are already isolated by the
            // emitter, and the default stringifier is total, but neither covers an injected formatter.
          } finally {
            this.#capturing = false;
          }
        }
        original.apply(con, args);
      };
      con[method] = wrapped;
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
