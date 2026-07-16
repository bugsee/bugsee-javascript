// Structured crash.json builder (the JS crash wire contract — docs/design/javascript-application-type.md
// §5.4). The JS SDK's error reports carry a raw stack STRING in request.json.description; the backend crash
// pipeline instead needs a structured `crash.json` (Android managed-exception parity) with per-frame
// `debug_id` (each bundle/chunk its own source-map). This composes the existing `parseV8Stack` +
// `applyDebugIds` primitives into that container. Runtime-portable: the runtime-specific stack parser +
// debug-id registration global are injected seams (browser passes its multi-engine parser).
import { applyDebugIds } from './debug-id';
import { parseV8Stack, type StackFrame } from './stack';

/** A crash.json stack frame: an Android-parity `trace` string + the structured `data` the worker
 *  symbolicates against + the per-frame source-map `debug_id`. */
export interface CrashFrame {
  trace: string;
  user: boolean;
  data?: { source?: string; member?: string; line?: number; column?: number };
  debug_id?: string;
}

/** A crash.json exception (Android managed-exception parity; recursive `cause` chain). */
export interface CrashException {
  name: string;
  reason?: string;
  frames: CrashFrame[];
  cause?: CrashException;
}

/** The crash.json bundle file — the Android managed-exception container the worker reads. */
export interface CrashJson {
  exception_type: 'error';
  ndkCrash: false;
  handled: boolean;
  exception: CrashException;
}

/** The NATIVE crash.json — a Crashpad/native segfault (Electron/Node native addon). The worker keys off
 *  `minidumpFile` (present) and stackwalks the attached `.dmp`; the exception + signal are derived there.
 *  See `docs/design/electron-native-crashes.md`. */
export interface NativeCrashJson {
  exception_type: 'native';
  ndkCrash: true;
  /** The name of the minidump file attached to the bundle (the worker downloads + stackwalks it). */
  minidumpFile: string;
}

export interface BuildCrashOptions {
  /** Runtime stack parser (default {@link parseV8Stack}; the browser tier injects its multi-engine parser). */
  parseStack?: (stack: string) => StackFrame[];
  /** Debug-ID registration global (default `globalThis`). */
  globalObject?: unknown;
  /** Whether this was a handled (logException) vs an uncaught crash. Default false. */
  handled?: boolean;
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
  const crashFrame: CrashFrame = { trace: frameTrace(frame), user: true };
  if (Object.keys(data).length > 0) {
    crashFrame.data = data;
  }
  if (frame.debugId !== undefined) {
    crashFrame.debug_id = frame.debugId;
  }
  return crashFrame;
}

function buildException(
  error: Error,
  parseStack: (stack: string) => StackFrame[],
  globalObject: unknown,
  seen: Set<unknown>,
  depth: number,
): CrashException {
  const frames = error.stack !== undefined ? parseStack(error.stack) : [];
  applyDebugIds(frames, { globalObject, parseStack });

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
    exception.cause = buildException(cause, parseStack, globalObject, seen, depth + 1);
  }
  return exception;
}

/**
 * Build the structured crash.json container from a thrown value. Returns `undefined` for non-Errors (the
 * caller keeps the request.json summary/description fallback).
 */
export function buildCrashJson(
  error: unknown,
  options: BuildCrashOptions = {},
): CrashJson | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const parseStack = options.parseStack ?? parseV8Stack;
  const globalObject = options.globalObject ?? (globalThis as unknown);
  return {
    exception_type: 'error',
    ndkCrash: false,
    handled: options.handled ?? false,
    exception: buildException(error, parseStack, globalObject, new Set<unknown>([error]), 0),
  };
}
