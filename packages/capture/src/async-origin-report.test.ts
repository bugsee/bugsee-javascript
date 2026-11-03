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

const recorderFor = (
  found: AsyncOrigin | undefined,
  probeStack?: string,
  arm: () => void = () => undefined,
): AsyncOriginRecorder => ({
  originOf: () => found,
  probeStack,
  originOfPromise: () => undefined,
  adoptPromise: () => undefined,
  arm,
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

describe("createAsyncOriginEnricher - the wrapper frame in an error's own stack", () => {
  const reason = { name: 'TypeError' };
  const probe =
    'Error: probe\n    at probeThrower (https://app.test/sdk.js:50:9)\n    at Permissions.query (https://app.test/sdk.js:40:22)\n    at probeStackOf (https://app.test/sdk.js:60:5)';
  const wrapperFrame: StackFrame = {
    function: 'Permissions.query',
    file: 'https://app.test/sdk.js',
    line: 40,
    column: 22,
  };
  const appFrame: StackFrame = {
    function: 'startQuery',
    file: 'https://app.test/app.js',
    line: 7,
    column: 3,
  };

  it('removes the frame at the wrapper call site, so the app frame is the top one (grouping location)', () => {
    const enrich = createAsyncOriginEnricher(recorderFor(undefined, probe), parseV8Stack);
    expect(enrich(reason, [wrapperFrame, appFrame])).toEqual([appFrame]);
  });

  it('keeps every frame when nothing sits at the wrapper site', () => {
    // same file, line or column as the wrapper site but never all three
    const own: StackFrame[] = [
      appFrame,
      { ...wrapperFrame, column: 99 },
      { ...wrapperFrame, line: 41 },
      { ...wrapperFrame, file: 'https://app.test/other.js' },
    ];
    expect(
      createAsyncOriginEnricher(recorderFor(undefined, probe), parseV8Stack)(reason, own),
    ).toBe(own);
  });

  it('a stack that was ONLY the wrapper falls back to the recorded call site', () => {
    const enrich = createAsyncOriginEnricher(recorderFor(origin(), probe), parseV8Stack);
    expect(enrich(reason, [wrapperFrame]).map((f) => f.origin)).toEqual(['call', 'call']);
  });

  it('finds the wrapper site WITHOUT relying on the thrower being named (a minifier renames it)', () => {
    const minified =
      'Error: probe\n    at t (https://app.test/sdk.min.js:1:500)\n    at e (https://app.test/sdk.js:40:22)\n    at n (https://app.test/sdk.min.js:1:900)';
    const enrich = createAsyncOriginEnricher(recorderFor(undefined, minified), parseV8Stack);
    expect(enrich(reason, [wrapperFrame, appFrame])).toEqual([appFrame]);
  });

  it('skips a native frame between the thrower and the wrapper (apply@[native code] in JavaScriptCore)', () => {
    const jsc =
      'probeThrower@https://app.test/sdk.js:50:9\napply@[native code]\nwrapped@https://app.test/sdk.js:40:22';
    const enrich = createAsyncOriginEnricher(recorderFor(undefined, jsc), (stack) =>
      stack.split('\n').map((line) => {
        const [fn, rest] = line.split('@') as [string, string];
        const m = /^(.*):(\d+):(\d+)$/.exec(rest);
        return m
          ? { function: fn, file: m[1] as string, line: Number(m[2]), column: Number(m[3]) }
          : { function: fn, file: rest };
      }),
    );
    expect(enrich(reason, [wrapperFrame, appFrame])).toEqual([appFrame]);
  });

  it('leaves frames alone when the probe stack is missing, has no thrower frame, or does not parse', () => {
    const own: StackFrame[] = [wrapperFrame, appFrame];
    const boom = (): StackFrame[] => {
      throw new Error('parse');
    };
    expect(
      createAsyncOriginEnricher(recorderFor(undefined, undefined), parseV8Stack)(reason, own),
    ).toBe(own);
    expect(
      createAsyncOriginEnricher(
        recorderFor(undefined, 'Error\n    at other (a.js:1:1)'),
        parseV8Stack,
      )(reason, own),
    ).toBe(own);
    expect(createAsyncOriginEnricher(recorderFor(undefined, probe), boom)(reason, own)).toBe(own);
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
            id: 'a"\nb\u2028c\u0085d\u202ee\u2029f\u202ag\u2067h',
            error: { code: 4, message: 'bad\nhttps://u:secret@h.test/x?token=TOP' },
          },
        }),
      ) ?? '';
    expect(text.split('\n')).toHaveLength(1);
    expect(text).not.toMatch(/[\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069]/);
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

  // Page-controlled text goes through the SAME sanitiser as network error messages (`sanitizeErrorMessage`): token shapes (a JWT, a
  // `sk_live_` key) are redacted. Email addresses are NOT part of that shared definition, and this does not add a second one.
  it('redacts token shapes in page-controlled text: an element id or a font family can carry one', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU';
    const text =
      describeOriginTarget(
        origin({
          target: { tagName: 'VIDEO', id: `player sk_live_4eC39HqLyjWDarjtT1zdp7dc ${jwt}` },
        }),
      ) ?? '';
    expect(text).not.toContain('sk_live_4eC39HqLyjWDarjtT1zdp7dc');
    expect(text).not.toContain(jwt);
    expect(text).toContain('<video id="player');
    const font =
      describeOriginTarget(
        origin({ api: 'FontFace.load', target: { family: `Brand ${jwt}`, status: 'error' } }),
      ) ?? '';
    expect(font).not.toContain(jwt);
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

// `arm()` installs the armed rows. It must fire for EVERY report path that meets a stackless reason nobody could locate: a React
// boundary, Vue's errorHandler, window `error` and `logException` never raise `unhandledrejection`.
describe('createAsyncOriginReporting - arming', () => {
  const headerOnly = Object.assign(new Error('x'), { name: 'NotAllowedError' });
  Object.defineProperty(headerOnly, 'stack', { value: 'NotAllowedError: x' });
  const withFrames = new Error('y');
  Object.defineProperty(withFrames, 'stack', { value: 'Error: y\n    at f (a.js:1:1)' });

  const reporting = (found: AsyncOrigin | undefined) => {
    const arm = vi.fn();
    return {
      arm,
      reporting: createAsyncOriginReporting(recorderFor(found, undefined, arm), parseV8Stack),
    };
  };

  it('noteRejection arms for a reason with no stack or a header-only stack nobody located', () => {
    const { arm, reporting: r } = reporting(undefined);
    r.noteRejection({ name: 'NotSupportedError' });
    r.noteRejection(headerOnly);
    expect(arm).toHaveBeenCalledTimes(2);
  });

  it('noteRejection does not arm for a reason with frames, a located one, or a primitive', () => {
    const none = reporting(undefined);
    none.reporting.noteRejection(withFrames);
    none.reporting.noteRejection('a string');
    none.reporting.noteRejection(null);
    const located = reporting(origin());
    located.reporting.noteRejection({ name: 'NotSupportedError' });
    expect(none.arm).not.toHaveBeenCalled();
    expect(located.arm).not.toHaveBeenCalled();
  });

  it('the enricher itself arms when it meets an unlocated stackless reason (so logException and window error arm too)', () => {
    const { arm, reporting: r } = reporting(undefined);
    expect(r.enrichFrames(headerOnly, [])).toEqual([]);
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it('the enricher does not arm when the error has frames or its origin is known', () => {
    const own: StackFrame[] = [{ function: 'f', file: 'a.js', line: 1, column: 1 }];
    const none = reporting(undefined);
    none.reporting.enrichFrames(withFrames, own);
    const located = reporting(origin());
    located.reporting.enrichFrames({ name: 'NotSupportedError' }, []);
    expect(none.arm).not.toHaveBeenCalled();
    expect(located.arm).not.toHaveBeenCalled();
  });

  it('arms for the reported error only, not for an error found in its cause chain (React links a frameless component-stack Error)', () => {
    const { arm, reporting: r } = reporting(undefined);
    r.enrichFrames(headerOnly, [], { depth: 1 }); // a cause
    expect(arm).not.toHaveBeenCalled();
    r.enrichFrames(headerOnly, [], { depth: 0 }); // the reported error
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it('a throwing stack getter counts as stackless (it arms), instead of silently not arming', () => {
    const { arm, reporting: r } = reporting(undefined);
    const hostile = {
      get stack(): string {
        throw new Error('stack getter');
      },
    };
    expect(() => r.noteRejection(hostile)).not.toThrow();
    expect(arm).toHaveBeenCalledTimes(1);
  });

  it('never fails the report because arming did', () => {
    const r = createAsyncOriginReporting(
      recorderFor(undefined, undefined, () => {
        throw new Error('arm failed');
      }),
      parseV8Stack,
    );
    expect(() => r.enrichFrames(headerOnly, [])).not.toThrow();
    expect(() => r.noteRejection(headerOnly)).not.toThrow();
  });
});

describe('createAsyncOriginReporting - adoptPromise', () => {
  it('passes the reason and the promise to the recorder, and never fails the report because it threw', () => {
    const adopt = vi.fn();
    const r = createAsyncOriginReporting(
      { ...recorderFor(undefined), adoptPromise: adopt },
      parseV8Stack,
    );
    const reason = {};
    const promise = Promise.resolve();
    r.adoptPromise(reason, promise);
    expect(adopt).toHaveBeenCalledWith(reason, promise);
    const boom = createAsyncOriginReporting(
      {
        ...recorderFor(undefined),
        adoptPromise: () => {
          throw new Error('adopt failed');
        },
      },
      parseV8Stack,
    );
    expect(() => boom.adoptPromise(reason, promise)).not.toThrow();
  });
});
