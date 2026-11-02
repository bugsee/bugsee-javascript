// Turning a recorded async origin (async-origin.ts) into what a report carries: call-site FRAMES (the enricher, fed to
// `buildCrashJson` through `enrichFrames`) and a one-line description of the TARGET the call was made on, read at REPORT time
// (docs/design/async-origin-capture.md §4.3, §4.5). Runtime-portable: the target is read by duck typing, never by a DOM type.
import type { FrameEnricher, StackFrame } from '@bugsee/core';
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
  return (error, frames) => {
    if (frames.length > 0) {
      return frames;
    }
    try {
      const origin = recorder.originOf(error);
      const stack = origin?.holder.stack;
      if (origin === undefined || typeof stack !== 'string') {
        return frames;
      }
      return parseStack(stack)
        .slice(origin.skip)
        .map((frame) => ({ ...frame, origin: 'call' as const }));
    } catch {
      return frames;
    }
  };
}

type Probe = Record<string, unknown>;

// A URL for a report: no query, no fragment (tokens live there), and a data:/blob: URL is only its scheme (it can be megabytes).
const scrubSource = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string' || raw === '') {
    return undefined;
  }
  const scheme = /^(data|blob):/.exec(raw);
  return scheme !== null ? scheme[0] : (raw.split(/[?#]/)[0] as string);
};

const tag = (target: Probe): string => {
  const name = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : 'element';
  const id = typeof target.id === 'string' && target.id !== '' ? ` id="${target.id}"` : '';
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
      ? `error=${error.code}${typeof error.message === 'string' && error.message !== '' ? ` "${error.message}"` : ''}`
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
    typeof target.family === 'string' ? `"${target.family}"` : undefined,
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
