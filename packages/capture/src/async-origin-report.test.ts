import type { StackFrame } from '@bugsee/core';
import { parseV8Stack } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import type { AsyncOrigin, AsyncOriginRecorder } from './async-origin';
import { createAsyncOriginEnricher, describeOriginTarget } from './async-origin-report';

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
