import type { StackFrame } from '@bugsee/core';
import { parseV8Stack } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import type { AsyncOrigin, AsyncOriginRecorder } from './async-origin';
import {
  createAsyncOriginEnricher,
  createAsyncOriginReporting,
  describeOriginTarget,
} from './async-origin-report';

const origin = (over: Partial<AsyncOrigin> = {}): AsyncOrigin => ({
  api: 'HTMLMediaElement.play',
  target: undefined,
  holder: {
    stack:
      'Error\n    at playClip (https://app.test/player.js:10:5)\n    at onClick (https://app.test/ui.js:3:1)',
  },
  skip: 0,
  ...over,
});

const recorderFor = (found: AsyncOrigin | undefined): AsyncOriginRecorder => ({
  originOf: () => found,
  originOfPromise: () => undefined,
  arm: () => undefined,
  installed: [],
  stop: () => undefined,
});

describe('createAsyncOriginEnricher', () => {
  const reason = { name: 'NotSupportedError' };

  it("turns the recorded call site into frames marked origin: 'call' when the error has none", () => {
    const enrich = createAsyncOriginEnricher(recorderFor(origin()), parseV8Stack);
    const frames = enrich(reason, []);
    expect(frames.map((f) => [f.function, f.file, f.line, f.column, f.origin])).toEqual([
      ['playClip', 'https://app.test/player.js', 10, 5, 'call'],
      ['onClick', 'https://app.test/ui.js', 3, 1, 'call'],
    ]);
  });

  it("leaves an error's own frames alone (a thrown stack beats a call site)", () => {
    const own: StackFrame[] = [{ function: 'thrower', file: 'a.js', line: 1, column: 1 }];
    expect(createAsyncOriginEnricher(recorderFor(origin()), parseV8Stack)(reason, own)).toBe(own);
  });

  it('drops the wrapper frames the engine could not omit (skip)', () => {
    const o = origin({
      skip: 1,
      holder: {
        stack:
          'Error\n    at wrapped (sdk.js:1:1)\n    at playClip (https://app.test/player.js:10:5)',
      },
    });
    const frames = createAsyncOriginEnricher(recorderFor(o), parseV8Stack)(reason, []);
    expect(frames.map((f) => f.function)).toEqual(['playClip']);
  });

  it('returns the frames untouched when there is no origin, no stack text, or the parser throws', () => {
    expect(createAsyncOriginEnricher(recorderFor(undefined), parseV8Stack)(reason, [])).toEqual([]);
    expect(
      createAsyncOriginEnricher(recorderFor(origin({ holder: {} })), parseV8Stack)(reason, []),
    ).toEqual([]);
    const boom = (): StackFrame[] => {
      throw new Error('parse');
    };
    expect(createAsyncOriginEnricher(recorderFor(origin()), boom)(reason, [])).toEqual([]);
  });
});

describe('describeOriginTarget', () => {
  it('describes a media element: tag, id, scrubbed source, network/ready state and its error', () => {
    const video = {
      tagName: 'VIDEO',
      id: 'hero',
      currentSrc: 'https://cdn.test/v/clip.mp4?token=SECRET#t=3',
      networkState: 3,
      readyState: 0,
      error: { code: 4, message: 'DEMUXER_ERROR_COULD_NOT_OPEN' },
    };
    const text = describeOriginTarget(origin({ target: video }));
    expect(text).toBe(
      'Target: <video id="hero"> src=https://cdn.test/v/clip.mp4 networkState=3 readyState=0 error=4 "DEMUXER_ERROR_COULD_NOT_OPEN"',
    );
    expect(text).not.toContain('SECRET');
  });

  it('redacts credentials and path secrets in the source, not only the query', () => {
    const text = describeOriginTarget(
      origin({
        target: {
          tagName: 'VIDEO',
          currentSrc: 'https://user:pw@cdn.test/app;jsessionid=ABC123/clip.mp4?x=1',
        },
      }),
    );
    expect(text).not.toContain('pw@');
    expect(text).not.toContain('ABC123');
    expect(text).toContain('cdn.test');
  });

  it('keeps page-controlled strings on one line and short (id, font family, media error message)', () => {
    const text =
      describeOriginTarget(
        origin({
          target: {
            tagName: 'VIDEO',
            id: 'a"\nb',
            error: { code: 4, message: 'bad\nhttps://u:secret@h.test/x?token=TOP' },
          },
        }),
      ) ?? '';
    expect(text.split('\n')).toHaveLength(1);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('TOP');
    const font =
      describeOriginTarget(
        origin({
          api: 'FontFace.load',
          target: { family: `x\ny${'z'.repeat(500)}`, status: 'error' },
        }),
      ) ?? '';
    expect(font.split('\n')).toHaveLength(1);
    expect(font.length).toBeLessThan(200);
  });

  it('omits what a media element does not have', () => {
    expect(
      describeOriginTarget(
        origin({
          target: { tagName: 'AUDIO', currentSrc: '', networkState: 0, readyState: 0, error: null },
        }),
      ),
    ).toBe('Target: <audio> networkState=0 readyState=0');
  });

  it('describes an image, a font face and an audio context', () => {
    expect(
      describeOriginTarget(
        origin({
          api: 'HTMLImageElement.decode',
          target: {
            tagName: 'IMG',
            id: '',
            currentSrc: 'data:image/png;base64,AAAA',
            complete: false,
            naturalWidth: 0,
          },
        }),
      ),
    ).toBe('Target: <img> src=data: complete=false naturalWidth=0');
    expect(
      describeOriginTarget(
        origin({ api: 'FontFace.load', target: { family: 'Inter', status: 'error' } }),
      ),
    ).toBe('Target: FontFace "Inter" status=error');
    expect(
      describeOriginTarget(
        origin({ api: 'OfflineAudioContext.startRendering', target: { state: 'closed' } }),
      ),
    ).toBe('Target: AudioContext state=closed');
    expect(
      describeOriginTarget(origin({ api: 'AudioContext.resume', target: { state: 'closed' } })),
    ).toBe('Target: AudioContext state=closed');
    expect(
      describeOriginTarget(
        origin({
          api: 'BaseAudioContext.decodeAudioData',
          target: { state: 'suspended', sampleRate: 48000 },
        }),
      ),
    ).toBe('Target: AudioContext state=suspended sampleRate=48000');
  });

  it('has no description for an API without a describer, a missing target, or a hostile getter', () => {
    expect(describeOriginTarget(origin({ api: 'Clipboard.readText', target: {} }))).toBeUndefined();
    expect(describeOriginTarget(origin({ target: undefined }))).toBeUndefined();
    expect(describeOriginTarget(origin({ target: null }))).toBeUndefined();
    const hostile = {
      get tagName(): string {
        throw new Error('getter');
      },
    };
    expect(describeOriginTarget(origin({ target: hostile }))).toBeUndefined();
  });
});

describe('createAsyncOriginReporting', () => {
  const stackless = { name: 'NotSupportedError', message: 'm' };

  it('bundles the enricher and the target description for a reason the recorder knows', () => {
    const video = { tagName: 'VIDEO', id: '', networkState: 3, readyState: 0 };
    const reporting = createAsyncOriginReporting(
      recorderFor(origin({ target: video })),
      parseV8Stack,
    );
    expect(reporting.enrichFrames(stackless, []).map((f) => f.function)).toEqual([
      'playClip',
      'onClick',
    ]);
    expect(reporting.describeTarget(stackless)).toBe('Target: <video> networkState=3 readyState=0');
  });

  it('describeTarget is undefined for an unknown reason', () => {
    expect(
      createAsyncOriginReporting(recorderFor(undefined), parseV8Stack).describeTarget(stackless),
    ).toBeUndefined();
  });

  it('arms the recorder on a stackless object nobody could locate, and only then', () => {
    const arm = vi.fn();
    const known = createAsyncOriginReporting({ ...recorderFor(origin()), arm }, parseV8Stack);
    known.noteRejection(stackless); // located: nothing to learn
    expect(arm).not.toHaveBeenCalled();
    const unknown = createAsyncOriginReporting({ ...recorderFor(undefined), arm }, parseV8Stack);
    unknown.noteRejection(new Error('has its own stack'));
    unknown.noteRejection('a string');
    unknown.noteRejection(null);
    expect(arm).not.toHaveBeenCalled();
    unknown.noteRejection(stackless);
    expect(arm).toHaveBeenCalledTimes(1);
    unknown.noteRejection(Object.assign(new Error('x'), { stack: '' })); // an Error whose stack is empty counts as stackless
    expect(arm).toHaveBeenCalledTimes(2);
  });

  it('never throws, even when the recorder does', () => {
    const hostile: AsyncOriginRecorder = {
      ...recorderFor(undefined),
      originOf: () => {
        throw new Error('recorder broke');
      },
    };
    const reporting = createAsyncOriginReporting(hostile, parseV8Stack);
    expect(() => reporting.noteRejection(stackless)).not.toThrow();
    expect(reporting.describeTarget(stackless)).toBeUndefined();
  });
});
