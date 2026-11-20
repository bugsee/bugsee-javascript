import type { FrameEnricher, StackFrame } from '@bugsee/core';
import { parseLocation } from '@bugsee/core';

// Context for an error the browser reports WITHOUT a stack, so the report is more than "TypeError at Unknown location".
//
// The case that motivated it is a failed dynamic `import()` (a lazy route chunk that 404s, or whose connection drops):
//  - Safari rejects with a bare `TypeError: Importing a module script failed.` — no stack, no URL, and `window.onerror` never
//    fires. Chrome ("Failed to fetch dynamically imported module: <url>") and Firefox ("error loading dynamically imported
//    module: <url>") name the module in the MESSAGE but still ship no frames.
//  - JavaScriptCore attaches `sourceURL` / `line` / `column` to a SyntaxError or an evaluation error instead of a stack.
// Both are recoverable from what the page still has: the message, the error's own location fields and the Resource Timing
// buffer (a failed module fetch leaves an entry whose transfer and body sizes are zero). Everything here is best-effort and
// pure reads: it never throws and never invents a module it cannot point at.

const SAFARI_IMPORT_FAILED = /^importing a module script failed\.?$/i;
const CHROME_IMPORT_FAILED = /failed to fetch dynamically imported module:\s*(\S+)/i;
const FIREFOX_IMPORT_FAILED = /error loading dynamically imported module:?\s*(\S*)/i;

/** How recent a zero-size script entry must be to be blamed for a failure raised now. */
const FAILED_ENTRY_MAX_AGE_MS = 60_000;
/** Successfully loaded scripts listed as "where the page was" — enough to name the current chunk, not a waterfall. */
const RECENT_SCRIPTS = 5;

/** The failed module's frame function. Frames of one unknown module share a file so they group together. */
export const IMPORT_FRAME_FUNCTION = 'import()';
export const UNKNOWN_MODULE = '<unknown module>';

interface ResourceEntryLike {
  name: string;
  initiatorType?: string;
  startTime?: number;
  responseEnd?: number;
  transferSize?: number;
  encodedBodySize?: number;
  decodedBodySize?: number;
  responseStatus?: number;
}

export interface StacklessEnv {
  /** `performance.getEntriesByType('resource')` and `performance.now()`. */
  performance?: {
    getEntriesByType(type: string): unknown[];
    now(): number;
  };
  location?: { href: string; origin: string; pathname: string; hash: string };
  navigator?: { onLine?: boolean };
}

export interface ModuleLoadFailure {
  /** The module that failed, path-scrubbed; undefined when no source named it. */
  failedUrl?: string;
  /** Where the URL came from: the message ("message"), or the Resource Timing buffer ("timing", an inference). */
  source?: 'message' | 'timing';
  /** The last scripts that DID load, newest last — the chunk the page was running is among them. */
  recentScripts: string[];
}

function hostEnv(): StacklessEnv {
  const g = globalThis as unknown as {
    performance?: StacklessEnv['performance'];
    location?: StacklessEnv['location'];
    navigator?: StacklessEnv['navigator'];
  };
  return { performance: g.performance, location: g.location, navigator: g.navigator };
}

function scrub(url: string): string {
  return parseLocation(url).file ?? url;
}

function messageOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const message = (value as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

/** The module URL a Chrome/Firefox message names, `''` for Safari's nameless message, undefined when this is not an import failure. */
function importFailureMessage(message: string | undefined): string | undefined {
  if (message === undefined) return undefined;
  if (SAFARI_IMPORT_FAILED.test(message.trim())) return '';
  const named = CHROME_IMPORT_FAILED.exec(message) ?? FIREFOX_IMPORT_FAILED.exec(message);
  return named === null ? undefined : (named[1] ?? '');
}

function scriptEntries(env: StacklessEnv): ResourceEntryLike[] {
  try {
    const entries = env.performance?.getEntriesByType('resource') ?? [];
    return entries.filter((entry): entry is ResourceEntryLike => {
      const e = entry as ResourceEntryLike;
      // `script` for a module import in Safari/Chrome, `other` for Firefox's module fetches.
      return (
        typeof e.name === 'string' &&
        (e.initiatorType === 'script' || e.initiatorType === 'other') &&
        /\.m?js(?:$|[?#])/i.test(e.name)
      );
    });
  } catch {
    return [];
  }
}

function sameOrigin(env: StacklessEnv, url: string): boolean {
  const origin = env.location?.origin;
  return origin !== undefined && url.startsWith(`${origin}/`);
}

/**
 * Did this fetch fail? With `responseStatus` (Chrome, newer Safari) a 4xx/5xx or 0 is decisive for any origin. Without it, a
 * body of zero bytes with zero transfer is the signature of a failed request — but a cross-origin entry without
 * `Timing-Allow-Origin` reports zero sizes for a SUCCESS too, so that inference is limited to the page's own origin.
 */
function looksFailed(env: StacklessEnv, entry: ResourceEntryLike): boolean {
  if (typeof entry.responseStatus === 'number' && entry.responseStatus !== 0) {
    return entry.responseStatus >= 400;
  }
  if (typeof entry.responseStatus === 'number' && entry.responseStatus === 0) {
    return true;
  }
  return (
    sameOrigin(env, entry.name) &&
    entry.transferSize === 0 &&
    entry.encodedBodySize === 0 &&
    entry.decodedBodySize === 0
  );
}

/**
 * Describe a failed dynamic import, or undefined when `value` is not one. Chrome/Firefox name the module in the message;
 * Safari does not, so the newest recent same-origin script entry that looks failed is named instead (flagged as inferred).
 */
export function detectModuleLoadFailure(
  value: unknown,
  env: StacklessEnv = hostEnv(),
): ModuleLoadFailure | undefined {
  const named = importFailureMessage(messageOf(value));
  if (named === undefined) return undefined;

  const entries = scriptEntries(env);
  const now = (() => {
    try {
      return env.performance?.now();
    } catch {
      return undefined;
    }
  })();
  const recentScripts = entries
    .filter((entry) => !looksFailed(env, entry))
    .slice(-RECENT_SCRIPTS)
    .map((entry) => scrub(entry.name));

  if (named !== '') {
    return { failedUrl: scrub(named), source: 'message', recentScripts };
  }
  const failed = entries
    .filter((entry) => looksFailed(env, entry))
    .filter(
      (entry) =>
        now === undefined ||
        entry.responseEnd === undefined ||
        now - entry.responseEnd <= FAILED_ENTRY_MAX_AGE_MS,
    )
    .pop();
  return failed === undefined
    ? { recentScripts }
    : { failedUrl: scrub(failed.name), source: 'timing', recentScripts };
}

/** JavaScriptCore's own location for an error that has no stack: `sourceURL`, `line`, `column`. */
export function engineLocationFrame(value: unknown): StackFrame | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { sourceURL, line, column } = value as {
    sourceURL?: unknown;
    line?: unknown;
    column?: unknown;
  };
  if (typeof sourceURL !== 'string' || sourceURL === '' || typeof line !== 'number')
    return undefined;
  const frame = parseLocation(sourceURL);
  frame.line = line;
  if (typeof column === 'number') frame.column = column;
  return frame;
}

/** The frame that stands for a failed import: the module when known, else one fixed placeholder so occurrences group. */
function importFrame(failure: ModuleLoadFailure): StackFrame {
  return { function: IMPORT_FRAME_FUNCTION, file: failure.failedUrl ?? UNKNOWN_MODULE };
}

/** The route the user is on: path plus hash route, with query strings and credentials dropped. */
function pageOf(env: StacklessEnv): string | undefined {
  const loc = env.location;
  if (loc === undefined) return undefined;
  try {
    const hashPath = loc.hash.split('?')[0] ?? '';
    return `${loc.origin}${loc.pathname}${hashPath}`;
  } catch {
    return undefined;
  }
}

/** Frames for a stackless error, or `[]` when there is nothing to say. */
export function stacklessFrames(value: unknown, env: StacklessEnv = hostEnv()): StackFrame[] {
  try {
    const failure = detectModuleLoadFailure(value, env);
    if (failure !== undefined) return [importFrame(failure)];
    const located = engineLocationFrame(value);
    return located === undefined ? [] : [located];
  } catch {
    return [];
  }
}

/** A frame enricher that fills ONLY an empty stack, so a real stack and the async-origin enricher keep precedence. */
export function createStacklessFrameEnricher(env?: StacklessEnv): FrameEnricher {
  return (error, frames) => {
    if (frames.length > 0) return frames;
    const added = stacklessFrames(error, env);
    return added.length > 0 ? added : frames;
  };
}

/** Report-description lines for a failed import: which module, where the page was, what had just loaded, connectivity. */
export function describeStacklessContext(
  value: unknown,
  env: StacklessEnv = hostEnv(),
): string | undefined {
  try {
    const failure = detectModuleLoadFailure(value, env);
    if (failure === undefined) return undefined;
    const lines: string[] = [];
    if (failure.failedUrl === undefined) {
      lines.push('Failed module: unknown (the browser did not name it)');
    } else if (failure.source === 'timing') {
      lines.push(`Failed module: ${failure.failedUrl} (inferred from resource timing)`);
    } else {
      lines.push(`Failed module: ${failure.failedUrl}`);
    }
    const page = pageOf(env);
    if (page !== undefined) lines.push(`Page: ${page}`);
    const online = env.navigator?.onLine;
    if (typeof online === 'boolean') lines.push(`Online: ${online}`);
    if (failure.recentScripts.length > 0) {
      lines.push('Recently loaded scripts (newest last):');
      for (const script of failure.recentScripts) lines.push(`  ${script}`);
    }
    return lines.join('\n');
  } catch {
    return undefined;
  }
}
