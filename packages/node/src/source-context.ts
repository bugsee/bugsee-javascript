import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import type { FrameContext, StackFrame } from '@bugsee/core';

// Source context: the line that threw, plus a little either side, read from disk at report time.
// Node-only by nature — core is runtime-portable and has no filesystem.
//
// WHICH FRAMES. Only ones whose `file` is an ABSOLUTE path, which after the frame-path scrubbing means
// application code: a dependency frame reads `node_modules/express/lib/router/index.js` and does not
// resolve, and reading a dependency's source is neither useful in a report nor something the SDK should
// be doing. That makes the rule a happy consequence of the privacy fix rather than a limitation.

export interface SourceContextOptions {
  /**
   * Where a relative frame path is resolved from. Default `process.cwd()`.
   *
   * Load-bearing since frame paths became relative: application frames now read `./src/app.js` (the
   * privacy fix), and this reader accepted only absolute paths — so source context silently stopped
   * working for exactly the application files it exists for. Two features each correct in isolation
   * and wrong together; only a real end-to-end run showed it.
   */
  appRoot?: string;
  /** Lines of context on EACH side of the throwing line. Default 5. */
  contextLines?: number;
  /** How many frames from the top to read context for. Default 5. */
  maxFrames?: number;
  /** Longest line kept, in characters. Default 200 — a minified bundle is one enormous line. */
  maxLineLength?: number;
  /** How many files to keep read. Default 50. */
  maxCachedFiles?: number;
  /** Test seam / integrator override for reading a source file. */
  readFile?: (path: string) => string | undefined;
  onError?: (error: unknown) => void;
}

/** `process.cwd()` throws when the working directory has been deleted out from under the process. */
const safeCwd = (): string => {
  try {
    return process.cwd();
  } catch {
    return '';
  }
};

const DEFAULT_READ = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined; // deleted, unreadable, or a path that was never a real file
  }
};

/**
 * The context window around a 1-based `line` of `source`.
 *
 * Returns undefined when the line is not in the file at all, which is the normal outcome for a stack
 * that has been through a build: reporting the wrong lines with confidence is worse than reporting none.
 */
export function readContext(
  source: string,
  line: number,
  contextLines: number,
  maxLineLength: number,
): FrameContext | undefined {
  const lines = source.split('\n');
  const index = line - 1; // stack frames are 1-based
  if (index < 0 || index >= lines.length) {
    return undefined;
  }
  const clip = (value: string): string =>
    value.length > maxLineLength ? `${value.slice(0, maxLineLength)}…` : value;
  const context: FrameContext = { line: clip(lines[index] as string) };
  const pre = lines.slice(Math.max(0, index - contextLines), index).map(clip);
  const post = lines.slice(index + 1, index + 1 + contextLines).map(clip);
  // Omitted rather than empty at the top or bottom of a file — an empty array on the wire says
  // "we looked and there was nothing", which is not the same as "there is no line 0".
  if (pre.length > 0) {
    context.pre = pre;
  }
  if (post.length > 0) {
    context.post = post;
  }
  return context;
}

/** Is this a path this tier can actually read? See the note above on which frames qualify. */
export function isReadablePath(file: string | undefined): file is string {
  return (
    file !== undefined &&
    (file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) || file.startsWith('./'))
  );
}

/** Resolve a frame path to something on disk: `./x` against the app root, absolute paths unchanged. */
export function resolveFramePath(file: string, appRoot: string): string {
  return file.startsWith('./') ? join(appRoot, file.slice(2)) : file;
}

/**
 * Build a frame enricher that attaches source context, reading each file at most once per report run
 * and caching a bounded number of them.
 */
export function createSourceContextEnricher(
  options: SourceContextOptions = {},
): (error: unknown, frames: StackFrame[]) => StackFrame[] {
  const {
    contextLines = 5,
    maxFrames = 5,
    maxLineLength = 200,
    maxCachedFiles = 50,
    appRoot = safeCwd(),
  } = options;
  const read = options.readFile ?? DEFAULT_READ;
  const onError = options.onError ?? ((): void => {});
  // `undefined` is cached too: a file that could not be read once will not become readable within a
  // process, and re-attempting it on every frame of every crash is pure syscall churn.
  const cache = new Map<string, string | undefined>();

  const load = (path: string): string | undefined => {
    if (cache.has(path)) {
      return cache.get(path);
    }
    let source: string | undefined;
    try {
      source = read(path);
    } catch (error) {
      onError(error);
    }
    if (cache.size >= maxCachedFiles) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    cache.set(path, source);
    return source;
  };

  return (_error, frames) => {
    let changed = false;
    const out = frames.map((frame, index) => {
      if (index >= maxFrames || frame.line === undefined || !isReadablePath(frame.file)) {
        return frame;
      }
      const source = load(resolveFramePath(frame.file, appRoot));
      if (source === undefined) {
        return frame;
      }
      const context = readContext(source, frame.line, contextLines, maxLineLength);
      if (context === undefined) {
        return frame;
      }
      changed = true;
      return { ...frame, context };
    });
    // The same array back when nothing was added, so a report with no readable frames copies nothing.
    return changed ? out : frames;
  };
}
