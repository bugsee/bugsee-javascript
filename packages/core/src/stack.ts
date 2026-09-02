// V8 stack-trace parsing (design §14.3 step 5: frame-path scrubbing). Pure string work, so it lives
// in core and is shared by every V8 runtime (node/bun/deno + chromium browsers); the browser tier
// adds SpiderMonkey/JavaScriptCore parsers and a runtime-dispatching parseStack on top. The other
// §14.3 steps (ignoreErrors / denyUrls / shape-redaction on the message / errorMessageFilter) are
// config-driven and belong to the report path, not this pure parser.

/** Source lines around a frame: the line itself, plus a bounded window either side. */
export interface FrameContext {
  /** Lines BEFORE the throwing line, in file order. */
  pre?: string[];
  /** The line that threw. */
  line?: string;
  /** Lines AFTER it, in file order. */
  post?: string[];
}

export interface StackFrame {
  /** Function/method name; absent for anonymous frames. */
  function?: string;
  /** Source file/URL, with file:// stripped and webpack:// normalized. */
  file?: string;
  /** 1-based line number. */
  line?: number;
  /** 1-based column number. */
  column?: number;
  /** Source-map debug-ID for this frame's bundle (set when a build injected one). See debug-id.ts. */
  debugId?: string;
  /**
   * Local variables in scope at this frame, already stringified and scrubbed. Present only when the
   * platform captured them (node's opt-in inspector capture) — absent, never `{}`, when it did not, so
   * "we did not look" stays distinguishable from "there was nothing to see".
   */
  variables?: Record<string, string>;
  /**
   * The source around this frame — the line that threw, plus a little either side. Present only when
   * the platform read it (node's opt-in source-context capture).
   */
  context?: FrameContext;
}

// §14.3 step 5: strip file:// URLs; normalize webpack:/// (and friends) to a friendly path; and keep the
// customer's filesystem out of the report.
//
// A Node crash frame used to carry the FULL absolute path — the OS username, the home-directory layout,
// and often an internal project codename — in every report, against the SDK's own rule that
// privacy-relevant data is obscured to the maximum extent possible BY DEFAULT.
//
// Dependency frames truncate at the FIRST `/node_modules/`, never the last. That is load-bearing rather
// than a style choice: `file` is the key of the `file → debugId` source-map join (`debug-id.ts`), so two
// distinct files scrubbing to one string would hand a frame the WRONG debug id and symbolicate it against
// the wrong map — worse than the leak it fixes. Measured over a real 24,591-file pnpm tree, truncating at
// the LAST boundary collapsed 2,783 distinct files onto shared keys; at the first, none. It also keeps a
// nested copy distinguishable from a hoisted one (the duplicate-package signal) and preserves pnpm's
// `.pnpm/<pkg>@<version>/` directory, which carries the version for free.
function scrubFramePath(path: string): string {
  let scrubbed = path;
  if (scrubbed.startsWith('file://')) {
    scrubbed = scrubbed.slice('file://'.length);
  } else if (scrubbed.startsWith('webpack://')) {
    return scrubbed.replace(/^webpack:\/\/+/, '');
  } else if (scrubbed.includes('://')) {
    // A URL, so a browser frame: its ORIGIN is the useful part and there is no filesystem to leak.
    return scrubbed;
  }
  const dependency = scrubbed.indexOf('/node_modules/');
  return dependency >= 0 ? scrubbed.slice(dependency + 1) : scrubbed;
}

const LOCATION = /^(.+):(\d+):(\d+)$/;

/**
 * Parse a `file:line:column` location (or a bare file) into a path-scrubbed {@link StackFrame}
 * fragment (file/line/column, no function). Shared by the V8 parser and the browser tier's
 * SpiderMonkey/JavaScriptCore (`fn@location`) parser so the path-scrubbing rules are single-sourced.
 */
export function parseLocation(location: string): StackFrame {
  const frame: StackFrame = {};
  const match = LOCATION.exec(location);
  if (match) {
    frame.file = scrubFramePath(match[1] as string);
    frame.line = Number(match[2]);
    frame.column = Number(match[3]);
  } else {
    frame.file = scrubFramePath(location);
  }
  return frame;
}

function parseFrame(site: string): StackFrame {
  // `site` is either "funcName (location)" or a bare "location". The FIRST " (" separates the
  // function from the location — a function name never contains " (", but a file path can (e.g. a
  // directory named "app (prod)"), so indexOf (not lastIndexOf) is correct.
  let location = site;
  let fn: string | undefined;
  const open = site.indexOf(' (');
  if (open !== -1 && site.endsWith(')')) {
    fn = site.slice(0, open);
    location = site.slice(open + 2, -1);
  }
  const frame = parseLocation(location);
  if (fn !== undefined) {
    frame.function = fn;
  }
  return frame;
}

/** Parse a V8/Node `Error.stack` string into structured, path-scrubbed frames. */
export function parseV8Stack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('at ')) {
      frames.push(parseFrame(line.slice('at '.length)));
    }
  }
  return frames;
}

/** Render scrubbed frames back into a stack string (one `at fn (file:line:col)` line per frame). A frame
 *  carrying a source-map debug-ID gets an additive ` debugId=<id>` suffix (the server ignores or joins on it). */
export function formatStack(frames: StackFrame[]): string {
  return frames
    .map((frame) => {
      const fn = frame.function ?? '<anonymous>';
      const location =
        frame.line !== undefined && frame.column !== undefined
          ? `${frame.file}:${frame.line}:${frame.column}`
          : `${frame.file}`;
      const debugId = frame.debugId !== undefined ? ` debugId=${frame.debugId}` : '';
      return `    at ${fn} (${location})${debugId}`;
    })
    .join('\n');
}

/**
 * The CALLER's frames, for a thrown value that never carried a stack of its own.
 *
 * JS throws non-Errors routinely — a string, a plain object, a rejected promise's value — and
 * `logException` accepts them. Those shipped `frames: []`, which costs more than a missing location:
 * the backend only emits grouping signatures when it has a top frame
 * (worker/crash/managed/common.py:88), so every occurrence became a NEW issue rather than another
 * event on an existing one.
 *
 * The SDK's own frames genuinely would describe the SDK rather than the fault — but strip those and
 * what remains is the application code that called us, which is exactly the fault site.
 *
 * `error` MUST be constructed inside `boundary` itself. Both paths below depend on it:
 *   - `Error.captureStackTrace(error, boundary)` removes every frame up to AND including `boundary`,
 *     so the SDK disappears however many helpers deep the capture happens to be. Measured 2026-08-26:
 *     Chromium, Firefox and WebKit all provide it.
 *   - Without it, the boundary is frame 0 by construction, so dropping exactly one frame is exact —
 *     and stays exact under minification, which any function-name matching would not.
 *
 * `Error.stackTraceLimit` is deliberately NOT raised. It is app-observable global state, and the
 * default (10 in V8) is ample for a location and a grouping signature; quietly mutating a global to
 * enrich our own telemetry is the kind of thing the SDK does not do to its host.
 */
export function callSiteFrames(
  error: Error,
  boundary: (...args: never[]) => unknown,
  parseStack: (stack: string) => StackFrame[],
): StackFrame[] {
  // Contained: `parseStack` is injected, and a report must never be lost to a parser that throws on
  // an engine whose stack format it did not expect. No frames is the pre-existing behaviour.
  try {
    const capture = (Error as { captureStackTrace?: (target: object, fn: unknown) => void })
      .captureStackTrace;
    if (typeof capture === 'function') {
      capture(error, boundary);
      return parseStack(error.stack ?? '');
    }
    return parseStack(error.stack ?? '').slice(1);
  } catch {
    return [];
  }
}
