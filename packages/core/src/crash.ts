// Structured crash.json builder (the JS crash wire contract — docs/design/javascript-application-type.md
// §5.4). The JS SDK's error reports carry a raw stack STRING in request.json.description; the backend crash
// pipeline instead needs a structured `crash.json` (Android managed-exception parity) with per-frame
// `debug_id` (each bundle/chunk its own source-map). This composes the existing `parseV8Stack` +
// `applyDebugIds` primitives into that container. Runtime-portable: the runtime-specific stack parser +
// debug-id registration global are injected seams (browser passes its multi-engine parser).
import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { applyDebugIds } from './debug-id';
import { type FrameContext, parseV8Stack, type StackFrame } from './stack';

/** A crash.json stack frame: an Android-parity `trace` string + the structured `data` the worker
 *  symbolicates against + the per-frame source-map `debug_id`. */
export interface CrashFrame {
  trace: string;
  user: boolean;
  data?: { source?: string; member?: string; line?: number; column?: number };
  debug_id?: string;
  /**
   * Local variables in scope at this frame — `{ name: stringified-value }`, already scrubbed and capped
   * by the capturing tier. Absent unless the platform captured them.
   */
  variables?: Record<string, string>;
  /** Source lines around this frame, when the platform read them. */
  context?: FrameContext;
}

/**
 * The `source_*` provenance triple (report-bundle-structure §crash.json common header), which makes a
 * crash.json SELF-DESCRIBING — routable from the document alone, without the `request.json` environment.
 *
 * This matters because the two do not travel together: on the backend's resymbolication path `crash.json`
 * is read from object storage while the environment comes from a separate database read, so a crash with
 * no provenance of its own is unroutable whenever that environment is missing or partial.
 *
 * `source_arch` is deliberately absent. The MIRROR RULE says each key is a copy of the corresponding
 * `environment` value taken from the same source of truth — never an independent probe — and a producer
 * omits any key it has no environment counterpart for. The JS SDK reports no `hardware.arch`.
 */
export interface CrashProvenance {
  /** The SDK family — the backend's routing key, read BEFORE `platform.type`. Mirrors `environment.sdk.type`. */
  source_sdk?: 'javascript';
  /**
   * The originating platform — the OS, as `environment.platform.type` reports it (the Rust SDK's
   * conformance suite asserts the two are equal). Mirrored by COPY, so it follows that field wherever
   * it goes; used as the platform fallback.
   */
  source_platform?: string;
}

/** A crash.json exception (Android managed-exception parity; recursive `cause` chain). */
export interface CrashException {
  name: string;
  reason?: string;
  frames: CrashFrame[];
  cause?: CrashException;
}

/** The crash.json bundle file — the Android managed-exception container the worker reads. */
export interface CrashJson extends CrashProvenance {
  exception_type: 'error';
  ndkCrash: false;
  handled: boolean;
  exception: CrashException;
}

/** The NATIVE crash.json — a Crashpad/native segfault (Electron/Node native addon). The worker keys off
 *  `minidumpFile` (present) and stackwalks the attached `.dmp`; the exception + signal are derived there.
 *  See `docs/design/electron-native-crashes.md`. */
export interface NativeCrashJson extends CrashProvenance {
  exception_type: 'native';
  ndkCrash: true;
  /** The name of the minidump file attached to the bundle (the worker downloads + stackwalks it). */
  minidumpFile: string;
}

/**
 * Add to a parsed stack before it becomes wire frames. Given the error the frames came from, returns the
 * frames to use (typically the same array with `variables` filled in).
 */
export type FrameEnricher = (error: unknown, frames: StackFrame[]) => StackFrame[];

/**
 * Chain frame enrichers left to right, each seeing what the previous added.
 *
 * Returns `undefined` for an empty list rather than an identity function, so a platform that enabled
 * nothing passes no `enrichFrames` at all and the crash path keeps its original array untouched.
 */
export function composeFrameEnrichers(
  enrichers: readonly FrameEnricher[],
): FrameEnricher | undefined {
  if (enrichers.length === 0) {
    return undefined;
  }
  return (error, frames) => enrichers.reduce((current, enrich) => enrich(error, current), frames);
}

export interface BuildCrashOptions {
  /** Runtime stack parser (default {@link parseV8Stack}; the browser tier injects its multi-engine parser). */
  parseStack?: (stack: string) => StackFrame[];
  /** Debug-ID registration global (default `globalThis`). */
  globalObject?: unknown;
  /** Whether this was a handled (logException) vs an uncaught crash. Default false. */
  handled?: boolean;
  /**
   * The CALLER's frames, for a thrown value that carries no stack of its own (see
   * {@link callSiteFrames}). Ignored for a real Error, which has its own. Absent or empty keeps the
   * previous frameless behaviour rather than losing the crash.
   */
  syntheticFrames?: StackFrame[];
  /**
   * Last chance to add to the parsed frames before they become wire frames — the seam the node tier
   * attaches captured LOCAL VARIABLES through.
   *
   * It lives here rather than in the parser because it needs the ERROR, not just its stack string: the
   * locals were captured when that specific object was thrown, and matching them to any other error's
   * frames would be worse than attaching none. Runtime-portable: core defines the seam and never
   * implements one (the inspector is node-only).
   */
  enrichFrames?: FrameEnricher;
}

/** The Android cause-chain depth cap (matches the mobile serializer). */
const MAX_CAUSE_DEPTH = 10;

/** Format a frame as a single `at fn (file:line:col)` trace line — WITHOUT a debugId suffix (the debug_id
 *  is a separate structured field in the contract). */
function frameTrace(frame: StackFrame): string {
  const fn = frame.function ?? '<anonymous>';
  const location =
    frame.line !== undefined && frame.column !== undefined
      ? `${frame.file}:${frame.line}:${frame.column}`
      : (frame.file ?? '<unknown>');
  return `at ${fn} (${location})`;
}

function toCrashFrame(frame: StackFrame): CrashFrame {
  const data: NonNullable<CrashFrame['data']> = {};
  if (frame.file !== undefined) {
    data.source = frame.file;
  }
  if (frame.function !== undefined) {
    data.member = frame.function;
  }
  if (frame.line !== undefined) {
    data.line = frame.line;
  }
  if (frame.column !== undefined) {
    data.column = frame.column;
  }
  const crashFrame: CrashFrame = { trace: frameTrace(frame), user: isUserFrame(frame) };
  if (Object.keys(data).length > 0) {
    crashFrame.data = data;
  }
  if (frame.debugId !== undefined) {
    crashFrame.debug_id = frame.debugId;
  }
  if (frame.variables !== undefined) {
    crashFrame.variables = frame.variables;
  }
  if (frame.context !== undefined) {
    crashFrame.context = frame.context;
  }
  return crashFrame;
}

/**
 * Is this frame the APPLICATION's, as opposed to the SDK's or the runtime's?
 *
 * The SDK sits between the throw and the capture, so its own frames are on every stack it records.
 * Reporting them as the user's put SDK internals at the top of each trace and fed them into
 * grouping, which is what a reader has to skip past before reaching the fault.
 *
 * Deliberately narrow: only frames the SDK can identify with certainty — its own packages, and the
 * runtime's internal modules — are excluded. Third-party `node_modules` frames stay the user's;
 * treating every dependency as foreign is a defensible product choice, but a different one, and
 * getting it wrong hides the frame the reader actually needs.
 */
export function isUserFrame(frame: StackFrame): boolean {
  const file = frame.file;
  if (file === undefined) return true; // nothing to judge by; assume the application's
  // `node:internal/...`, `node:events` — the runtime's own modules, never application code.
  if (file.startsWith('node:')) return false;
  // The SDK's published packages. Anchored on the path separator so an APPLICATION file that merely
  // mentions bugsee (`src/bugsee-client.ts`) is not mistaken for one of ours.
  return !(file.includes('/@bugsee/') || file.includes('\\@bugsee\\'));
}

function buildException(
  error: Error,
  parseStack: (stack: string) => StackFrame[],
  globalObject: unknown,
  seen: Set<unknown>,
  depth: number,
  enrichFrames?: FrameEnricher,
): CrashException {
  const parsed = error.stack !== undefined ? parseStack(error.stack) : [];
  applyDebugIds(parsed, { globalObject, parseStack });
  // Runs per exception in the `cause` chain, not just the outermost: the frames that matter are often
  // the original cause's, and a chained error is exactly where "which value was it, three throws ago"
  // is hardest to answer from the stack alone.
  const frames = enrichFrames === undefined ? parsed : enrichFrames(error, parsed);

  const exception: CrashException = {
    name: error.name || 'Error',
    frames: frames.map(toCrashFrame),
  };
  if (error.message) {
    exception.reason = error.message;
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && !seen.has(cause) && depth < MAX_CAUSE_DEPTH) {
    seen.add(cause);
    exception.cause = buildException(
      cause,
      parseStack,
      globalObject,
      seen,
      depth + 1,
      enrichFrames,
    );
  }
  return exception;
}

/**
 * Build the structured crash.json container from a thrown value. A non-Error gets a SYNTHETIC
 * exception rather than nothing at all — see {@link syntheticException}.
 */
/**
 * The exception for a value that is NOT an Error.
 *
 * JS throws non-Errors routinely — a string, a plain object, a rejected promise's value — and
 * `logException` accepts them. Returning nothing here meant the bundle carried no `crash.json` at
 * all, so the report had a summary and nothing else and the backend answered "Crash data for the
 * issue was not found": an issue that exists, is counted, and cannot be acted on. A synthetic
 * exception makes it usable.
 *
 * The frames are the CALLER's, supplied by {@link callSiteFrames}. The value never had a stack, and the
 * SDK's own frames would describe the SDK rather than the fault — but strip those and what remains is
 * the application code that called us, which IS the fault site. Without them the backend emits no
 * grouping signature at all (worker/crash/managed/common.py:88), so every occurrence became a new
 * issue instead of another event on an existing one.
 */
function syntheticException(
  value: unknown,
  frames: StackFrame[] = [],
  enrichFrames?: FrameEnricher,
): CrashException {
  // The enricher runs here too. It used to run only on the Error path, so `logException('payment
  // failed')` shipped frames with neither locals nor source context — on the one path where the frames
  // are the CALLER's own and a report-site capture lines up with them exactly. Skipped when there are no
  // frames, so a bare non-Error costs nothing.
  const enriched =
    enrichFrames !== undefined && frames.length > 0 ? enrichFrames(value, frames) : frames;
  // Through the SAME conversion a real Error's frames take, so a synthetic frame is indistinguishable
  // downstream: it carries `trace`, the `user` classification and any debug-id, and symbolicates the
  // same way.
  const exception: CrashException = { name: typeTag(value), frames: enriched.map(toCrashFrame) };
  const reason = renderThrowable(value);
  if (reason !== '') {
    exception.reason = reason;
  }
  return exception;
}

/** A display name for a thrown value: its own `name`, else its class, else its primitive type. */
function typeTag(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const named = (value as { name?: unknown }).name;
    if (typeof named === 'string' && named !== '') return named;
    const ctor = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return typeof ctor === 'string' && ctor !== '' ? ctor : 'Object';
  }
  if (value === null) return 'Null';
  // 'string' -> 'String', matching how the mobile SDKs label a thrown primitive.
  const type = typeof value;
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** A bounded, never-throwing rendering of a thrown value for `exception.reason`. */
function renderThrowable(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
    try {
      // A circular or getter-throwing object must not take the report down with it.
      return JSON.stringify(value) ?? String(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

export function buildCrashJson(error: unknown, options: BuildCrashOptions = {}): CrashJson {
  if (!(error instanceof Error)) {
    return {
      exception_type: 'error',
      ndkCrash: false,
      handled: options.handled ?? false,
      exception: syntheticException(error, options.syntheticFrames, options.enrichFrames),
    };
  }
  const parseStack = options.parseStack ?? parseV8Stack;
  const globalObject = options.globalObject ?? (globalThis as unknown);
  return {
    exception_type: 'error',
    ndkCrash: false,
    handled: options.handled ?? false,
    exception: buildException(
      error,
      parseStack,
      globalObject,
      new Set<unknown>([error]),
      0,
      options.enrichFrames,
    ),
  };
}

/**
 * Stamp the {@link CrashProvenance} triple onto a crash document, COPYING both values out of the
 * environment envelope that the same bundle emits as `request.json.environment`.
 *
 * Copying is the point. report-bundle-structure's mirror rule forbids an independent probe here: a
 * consumer substitutes `source_platform` for `environment.platform.type`, so two probes that could drift
 * would reintroduce the very disagreement the triple exists to eliminate. Taking both from the assembled
 * environment makes them incapable of disagreeing.
 *
 * Returns a new object — the {@link Report} holds the original, and a report can be assembled more than
 * once (capture recovery re-assembles a drained session).
 */
export function stampCrashProvenance<T extends CrashJson | NativeCrashJson>(
  crash: T,
  environment: EnvironmentEnvelope,
): T {
  return {
    ...crash,
    source_sdk: environment.sdk.type,
    source_platform: environment.platform.type,
  };
}
