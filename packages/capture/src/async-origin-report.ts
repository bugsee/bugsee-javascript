// Turning a recorded async origin (async-origin.ts) into what a report carries: call-site FRAMES (the enricher, fed to
// `buildCrashJson` through `enrichFrames`) and a one-line description of the TARGET the call was made on, read at REPORT time
// (docs/design/async-origin-capture.md §4.3, §4.5). Runtime-portable: the target is read by duck typing, never by a DOM type.
import type { FrameEnricher, StackFrame } from '@bugsee/core';
import { sanitizeErrorMessage, sanitizeUrl } from '@bugsee/protocol';
import type { AsyncOrigin, AsyncOriginRecorder } from './async-origin';

/**
 * A {@link FrameEnricher}: for an error that has NO frames of its own (an async platform rejection), the frames of the recorded call
 * site, each marked `origin: 'call'` so a consumer can tell "where it was called" from "where it was thrown". An error with its own
 * frames is returned as it is; so is anything the recorder knows nothing about. Never throws.
 */
export function createAsyncOriginEnricher(
  recorder: AsyncOriginRecorder,
  parseStack: (stack: string) => StackFrame[],
): FrameEnricher {
  // Where the wrapper calls the platform method: the frame after the thrower (the first frame) in the recorder's probe stack. Read once.
  let site: StackFrame | undefined;
  let siteRead = false;
  const wrapperSite = (): StackFrame | undefined => {
    if (!siteRead) {
      siteRead = true;
      try {
        // The probe throws from its own first frame, so the wrapper's call site is the next frame that is not engine-native
        // (JavaScriptCore may show `apply@[native code]` between them). Found by POSITION, not by the thrower's name: a minifier
        // renames it.
        const frames = parseStack(recorder.probeStack ?? '');
        site = frames.slice(1).find((frame) => !/native code/.test(frame.file ?? ''));
      } catch {
        site = undefined;
      }
    }
    return site;
  };
  const isWrapper = (frame: StackFrame, at: StackFrame): boolean =>
    frame.file === at.file && frame.line === at.line && frame.column === at.column;

  return (error, given) => {
    // An API that rejects with a stack of its own (argument validation) has the WRAPPER on top of it. That frame is the SDK's, and as
    // the top `user` frame it would decide the issue's grouping location, so it goes.
    const at = given.length > 0 ? wrapperSite() : undefined;
    const frames = at === undefined ? given : dropWrapper(given, at, isWrapper);
    if (frames.length > 0) {
      return frames;
    }
    try {
      const origin = recorder.originOf(error);
      const stack = origin?.holder.stack;
      if (origin === undefined || typeof stack !== 'string') {
        return given;
      }
      return parseStack(stack)
        .slice(origin.skip)
        .map((frame) => ({ ...frame, origin: 'call' as const }));
    } catch {
      return given;
    }
  };
}

// The frames without the ones at `at`; the SAME array when none matched (callers compare identity).
function dropWrapper(
  frames: StackFrame[],
  at: StackFrame,
  isWrapper: (frame: StackFrame, at: StackFrame) => boolean,
): StackFrame[] {
  const kept = frames.filter((frame) => !isWrapper(frame, at));
  return kept.length === frames.length ? frames : kept;
}

type Probe = Record<string, unknown>;

// Page-controlled text in a one-line description: control characters (newline included) and quotes go, and it is clipped.
const FIELD_LIMIT = 80;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069"]+/g;
// Page-controlled text is redacted (`sanitizeErrorMessage`: emails, tokens, URL credentials) BEFORE it is clipped, so a secret cannot
// survive by being cut in half, and then stripped of control characters.
const field = (raw: string): string =>
  sanitizeErrorMessage(raw).replace(UNSAFE, ' ').slice(0, FIELD_LIMIT);

// A URL for a report: no query, no fragment (tokens live there), userinfo and path secrets redacted (`sanitizeUrl`), and a
// data:/blob: URL is only its scheme (it can be megabytes).
const scrubSource = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string' || raw === '') {
    return undefined;
  }
  const scheme = /^(data|blob):/.exec(raw);
  return scheme !== null ? scheme[0] : field(sanitizeUrl(raw.split(/[?#]/)[0] as string));
};

const tag = (target: Probe): string => {
  const name = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : 'element';
  const id = typeof target.id === 'string' && target.id !== '' ? ` id="${field(target.id)}"` : '';
  return `<${name}${id}>`;
};

const parts = (...items: (string | undefined)[]): string =>
  items.filter((item) => item !== undefined).join(' ');

const describeMedia = (target: Probe): string => {
  const error = target.error as { code?: unknown; message?: unknown } | null | undefined;
  const src = scrubSource(target.currentSrc);
  return parts(
    tag(target),
    src === undefined ? undefined : `src=${src}`,
    typeof target.networkState === 'number' ? `networkState=${target.networkState}` : undefined,
    typeof target.readyState === 'number' ? `readyState=${target.readyState}` : undefined,
    error !== null && error !== undefined && typeof error.code === 'number'
      ? `error=${error.code}${typeof error.message === 'string' && error.message !== '' ? ` "${field(sanitizeErrorMessage(error.message))}"` : ''}`
      : undefined,
  );
};

const describeImage = (target: Probe): string => {
  const src = scrubSource(target.currentSrc);
  return parts(
    tag(target),
    src === undefined ? undefined : `src=${src}`,
    typeof target.complete === 'boolean' ? `complete=${target.complete}` : undefined,
    typeof target.naturalWidth === 'number' ? `naturalWidth=${target.naturalWidth}` : undefined,
  );
};

const describeFont = (target: Probe): string =>
  parts(
    'FontFace',
    typeof target.family === 'string' ? `"${field(target.family)}"` : undefined,
    typeof target.status === 'string' ? `status=${target.status}` : undefined,
  );

const describeAudio = (target: Probe): string =>
  parts(
    'AudioContext',
    typeof target.state === 'string' ? `state=${target.state}` : undefined,
    typeof target.sampleRate === 'number' ? `sampleRate=${target.sampleRate}` : undefined,
  );

const DESCRIBERS: Readonly<Record<string, (target: Probe) => string>> = {
  HTMLMediaElement: describeMedia,
  HTMLImageElement: describeImage,
  FontFace: describeFont,
  BaseAudioContext: describeAudio,
  AudioContext: describeAudio,
  OfflineAudioContext: describeAudio,
};

/**
 * One line describing what an async call was made ON ("<video id="hero"> src=… networkState=3 …"), for the report, or undefined
 * when the API has no describer (the call site alone is reported) or the target cannot be read (a null, a hostile getter). Read at report time, because the
 * media `error` event fires after the rejection in some engines. Never throws.
 */
export function describeOriginTarget(origin: AsyncOrigin): string | undefined {
  const describe = DESCRIBERS[origin.api.split('.')[0] as string];
  const target = origin.target;
  if (describe === undefined || typeof target !== 'object') {
    return undefined;
  }
  try {
    return `Target: ${describe(target as Probe)}`;
  } catch {
    return undefined;
  }
}

/** What a detection provider needs to report an async platform rejection with its call site. */
export interface AsyncOriginReporting {
  /** Feed to `buildCrashJson({ enrichFrames })`. */
  enrichFrames: FrameEnricher;
  /** The target line for the report description, for a reason the recorder located. */
  describeTarget(reason: unknown): string | undefined;
  /**
   * Call for every rejection reason that reaches a report. The FIRST stackless object nobody could locate is the signal that an
   * armed API is failing, so the armed rows are installed (they cost nothing until then, see `arm()`).
   */
  noteRejection(reason: unknown): void;
  /** Link the origin recorded for `promise` (fallback mode) to `reason`; both come from an `unhandledrejection` event. Never throws. */
  adoptPromise(reason: unknown, promise: unknown): void;
}

export function createAsyncOriginReporting(
  recorder: AsyncOriginRecorder,
  parseStack: (stack: string) => StackFrame[],
): AsyncOriginReporting {
  const enrich = createAsyncOriginEnricher(recorder, parseStack);

  // "Stackless" is decided by FRAMES, as everywhere else: no `.stack`, or one that parses to nothing (Chromium's async DOMExceptions
  // carry only the `Name: message` header line).
  const noteRejection = (reason: unknown): void => {
    try {
      if (typeof reason !== 'object' || reason === null) {
        return;
      }
      // A `stack` getter that throws is a reason with no usable stack: stackless, so it may be the armed API failing.
      let stack: unknown;
      try {
        stack = (reason as { stack?: unknown }).stack;
      } catch {
        stack = undefined;
      }
      const hasOwnFrames = typeof stack === 'string' && parseStack(stack).length > 0;
      if (!hasOwnFrames && recorder.originOf(reason) === undefined) {
        recorder.arm();
      }
    } catch {
      // reporting must never fail because the recorder did
    }
  };

  return {
    // The enricher runs on EVERY report path (unhandledrejection, window error, logException: React boundary, Vue errorHandler and the
    // like never raise `unhandledrejection`), so arming from here covers all of them.
    // Only for the error being reported (depth 0), never for one found in its `cause` chain: a framework links a frameless Error there
    // (React's component stack), which is not an armed API failing.
    enrichFrames(error, frames, info) {
      const enriched = enrich(error, frames, info);
      if (
        frames.length === 0 &&
        enriched.length === 0 &&
        (info === undefined || info.depth === 0)
      ) {
        noteRejection(error);
      }
      return enriched;
    },
    describeTarget(reason) {
      try {
        const origin = recorder.originOf(reason);
        return origin === undefined ? undefined : describeOriginTarget(origin);
      } catch {
        return undefined;
      }
    },
    noteRejection,
    adoptPromise(reason, promise) {
      try {
        recorder.adoptPromise(reason, promise);
      } catch {
        // reporting must never fail because the recorder did
      }
    },
  };
}
