// V8 stack-trace parsing (design §14.3 step 5: frame-path scrubbing). Pure string work, so it lives
// in core and is shared by every V8 runtime (node/bun/deno + chromium browsers); the browser tier
// adds SpiderMonkey/JavaScriptCore parsers and a runtime-dispatching parseStack on top. The other
// §14.3 steps (ignoreErrors / denyUrls / shape-redaction on the message / errorMessageFilter) are
// config-driven and belong to the report path, not this pure parser.

export interface StackFrame {
  /** Function/method name; absent for anonymous frames. */
  function?: string;
  /** Source file/URL, with file:// stripped and webpack:// normalized. */
  file?: string;
  /** 1-based line number. */
  line?: number;
  /** 1-based column number. */
  column?: number;
}

// §14.3 step 5: strip file:// URLs; normalize webpack:/// (and friends) to a friendly path.
function scrubFramePath(path: string): string {
  if (path.startsWith('file://')) {
    return path.slice('file://'.length);
  }
  if (path.startsWith('webpack://')) {
    return path.replace(/^webpack:\/\/+/, '');
  }
  return path;
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

/** Render scrubbed frames back into a stack string (one `at fn (file:line:col)` line per frame). */
export function formatStack(frames: StackFrame[]): string {
  return frames
    .map((frame) => {
      const fn = frame.function ?? '<anonymous>';
      const location =
        frame.line !== undefined && frame.column !== undefined
          ? `${frame.file}:${frame.line}:${frame.column}`
          : `${frame.file}`;
      return `    at ${fn} (${location})`;
    })
    .join('\n');
}
