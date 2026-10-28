import { afterEach, describe, expect, it } from 'vitest';
import {
  callSiteFrames,
  formatStack,
  frameUrlCacheSize,
  parseLocation,
  parseV8Stack,
  type StackFrame,
  setStackAppRoot,
} from './stack';

describe('parseV8Stack', () => {
  it("keeps Firefox's eval suffix while sanitizing the script URL", () => {
    expect(parseLocation('https://app.test/a.js?token=S line 2 > Function:1:5').file).toBe(
      'https://app.test/a.js?token=%3Credacted%3E line 2 > Function',
    );
    expect(parseLocation('https://app.test/a.js line 2 > eval line 5 > eval:1:1').file).toBe(
      'https://app.test/a.js line 2 > eval line 5 > eval',
    );
  });

  it('returns the same sanitized URL for repeated frames, and survives more distinct URLs than the cache holds', () => {
    const one = parseLocation('https://app.test/a.js?token=S:1:1').file;
    expect(parseLocation('https://app.test/a.js?token=S:2:2').file).toBe(one);
    for (let i = 0; i < 1500; i += 1) {
      expect(parseLocation(`https://app.test/chunk-${i}.js?token=S:1:1`).file).toBe(
        `https://app.test/chunk-${i}.js?token=%3Credacted%3E`,
      );
    }
    expect(parseLocation('https://app.test/a.js?token=S:3:3').file).toBe(one);
  });

  it("sanitizes the script URL INSIDE Chrome's eval wrapper, keeping the wrapper text and the position", () => {
    const frames = parseV8Stack(
      'Error: x\n    at eval (eval at f (https://x.com/app.js?token=S3:1:2), <anonymous>:1:1)',
    );
    expect(frames[0]?.file).toBe(
      'eval at f (https://x.com/app.js?token=%3Credacted%3E:1:2), <anonymous>',
    );
    expect(JSON.stringify(frames)).not.toContain('S3');
  });

  it('sanitizes every URL of a nested eval chain and leaves non-URL text alone', () => {
    const file = parseLocation(
      'eval at a (eval at b (https://u:pw@x.com/a.js?sig=1&token=S:3:4), <anonymous>), <anonymous>',
    ).file;
    expect(file).not.toMatch(/pw|=S\b/);
    expect(file).toContain('eval at a (eval at b (');
    expect(file).toContain(':3:4)');
  });

  it('an eval wrapper around a plain script URL is unchanged (the position is not doubled)', () => {
    expect(
      parseV8Stack(
        'Error: x\n    at eval (eval at f (https://x.com/app.js:1:2), <anonymous>:1:1)',
      )[0]?.file,
    ).toBe('eval at f (https://x.com/app.js:1:2), <anonymous>');
  });

  it('keeps a port and a route group inside an eval-wrapped URL (only the trailing position is cut)', () => {
    expect(
      parseV8Stack(
        'Error: x\n    at eval (eval at f (https://x.com:8080/app/(dash)/a.js:1:2), <anonymous>:1:1)',
      )[0]?.file,
    ).toBe('eval at f (https://x.com:8080/app/(dash)/a.js:1:2), <anonymous>');
  });

  it('an eval-wrapped URL whose query holds :digits keeps them inside the redacted value', () => {
    expect(
      parseV8Stack(
        'Error: x\n    at eval (eval at f (https://x.com/a.js?token=abc:123:4:5), <anonymous>:1:1)',
      )[0]?.file,
    ).toBe('eval at f (https://x.com/a.js?token=%3Credacted%3E:4:5), <anonymous>');
  });

  it('an eval-wrapped URL with a route group AND a signed query is redacted (parens belong to the URL)', () => {
    expect(
      parseV8Stack(
        'Error: x\n    at eval (eval at f (https://x.com/(dash)/a.js?token=S:1:2), <anonymous>:1:1)',
      )[0]?.file,
    ).toBe('eval at f (https://x.com/(dash)/a.js?token=%3Credacted%3E:1:2), <anonymous>');
  });

  it('an eval wrapper whose origin has a sourceURL has no position, and is still sanitized', () => {
    const real =
      'Error: x\n    at eval (eval at <anonymous> (https://cdn.x.com/a.js?token=S3), <anonymous>:1:1)';
    expect(parseV8Stack(real)[0]?.file).toBe(
      'eval at <anonymous> (https://cdn.x.com/a.js?token=%3Credacted%3E), <anonymous>',
    );
  });

  it('a blob:/filesystem: URL inside the wrapper is sanitized too', () => {
    expect(parseLocation('eval at f (blob:https://u:pw@x.com/uuid:1:2), <anonymous>').file).toBe(
      'eval at f (blob:https://u:%3Credacted%3E@x.com/uuid:1:2), <anonymous>',
    );
    expect(
      parseLocation('eval at f (filesystem:https://u:pw@x.com/temporary/a.js:1:2), <anonymous>')
        .file,
    ).toBe('eval at f (filesystem:https://u:%3Credacted%3E@x.com/temporary/a.js:1:2), <anonymous>');
  });

  it('a route group followed by a signed query never closes the wrapper early (position-less form)', () => {
    expect(parseLocation('eval at f (https://x.com/(dash)/a.js?token=S3), <anonymous>').file).toBe(
      'eval at f (https://x.com/(dash)/a.js?token=%3Credacted%3E), <anonymous>',
    );
  });

  it('a URL OUTSIDE any wrapper is sanitized to the next whitespace', () => {
    const file = parseLocation(
      'eval at a (eval at b (https://x.com/a.js:3:4), <anonymous>), https://y.com/b.js?token=T:5:6',
    ).file;
    expect(file).toBe(
      'eval at a (eval at b (https://x.com/a.js:3:4), <anonymous>), https://y.com/b.js?token=%3Credacted%3E',
    );
  });

  it.each([
    [
      'a route group',
      'https://y.com/(g)/b.js?token=T',
      'https://y.com/(g)/b.js?token=%3Credacted%3E',
    ],
    [
      'a comma in the path',
      'https://y.com/a,b/c.js?token=T',
      'https://y.com/a,b/c.js?token=%3Credacted%3E',
    ],
    [
      'a closing paren in the query',
      'https://y.com/b.js?a=b)&token=T',
      'https://y.com/b.js?a=b)&token=%3Credacted%3E',
    ],
    [
      'a comma in the query',
      'https://y.com/b.js?a=1,2&token=T',
      'https://y.com/b.js?a=1,2&token=%3Credacted%3E',
    ],
  ])('a free URL OUTSIDE a wrapper keeps its parens and commas (%s)', (_name, url, expected) => {
    expect(
      parseLocation(`eval at a (eval at b (https://x.com/a.js:3:4), <anonymous>), ${url}`).file,
    ).toBe(`eval at a (eval at b (https://x.com/a.js:3:4), <anonymous>), ${expected}`);
  });

  it('a bare frame whose file starts with the letters `async` is not an async frame', () => {
    expect(parseV8Stack('Error: x\n    at async.js:1:2')[0]).toEqual({
      file: 'async.js',
      line: 1,
      column: 2,
    });
    expect(parseV8Stack('Error: x\n    at /async/x.js:1:2')[0]).toEqual({
      file: '/async/x.js',
      line: 1,
      column: 2,
    });
    expect(parseV8Stack('Error: x\n    at asyncFn (/a.js:1:2)')[0]?.function).toBe('asyncFn');
  });

  it('a URL BEFORE a wrapper in the same string is sanitized too', () => {
    expect(
      parseLocation(
        'eval at a https://y.com/b.js?token=T (eval at b (https://x.com/a.js:3:4), <anonymous>)',
      ).file,
    ).toBe(
      'eval at a https://y.com/b.js?token=%3Credacted%3E (eval at b (https://x.com/a.js:3:4), <anonymous>)',
    );
  });

  it('a wrapper that ends the string (no trailing comma) is matched', () => {
    expect(parseLocation('eval at f (https://x.com/a.js?token=S:1:2)').file).toBe(
      'eval at f (https://x.com/a.js?token=%3Credacted%3E:1:2)',
    );
  });

  describe('parentheses and commas inside the URL never close the eval wrapper early', () => {
    const R = '%3Credacted%3E';
    it.each([
      [
        'nested calls in the query (real Node 24)',
        'https://x.com/app.js?q=and(eq(a,1),eq(b,2))&token=SECRETB',
        ':5:40',
        `https://x.com/app.js?q=and(eq(a,1),eq(b,2))&token=${R}`,
      ],
      [
        'paren groups separated by a comma',
        'https://x.com/app.js?f=(a),(b)&token=SECRETB',
        ':1:2',
        `https://x.com/app.js?f=(a),(b)&token=${R}`,
      ],
      [
        'doubly nested parens',
        'https://x.com/app.js?q=f(g(x))&token=SECRETB',
        ':1:2',
        `https://x.com/app.js?q=f(g(x))&token=${R}`,
      ],
      [
        'parens and a comma in the fragment',
        'https://x.com/app.js#a=(b),c&access_token=SECRETB',
        ':1:2',
        `https://x.com/app.js#a=(b),c&access_token=${R}`,
      ],
      [
        'the position-less (sourceURL) form with paren groups',
        'https://x.com/app.js?f=(a),(b)&token=SECRETB',
        '',
        `https://x.com/app.js?f=(a),(b)&token=${R}`,
      ],
      [
        'a route group and a paren query',
        'https://x.com/(dash)/a.js?f=(a),(b)&token=SECRETB',
        ':3:4',
        `https://x.com/(dash)/a.js?f=(a),(b)&token=${R}`,
      ],
    ])('%s', (_name, url, position, expected) => {
      const file = parseLocation(`eval at d (${url}${position}), <anonymous>`).file ?? '';
      expect(file).toBe(`eval at d (${expected}${position}), <anonymous>`);
      expect(file).not.toContain('SECRETB');
    });
    it('the same through a real V8 stack line', () => {
      const frames = parseV8Stack(
        'Error: x\n    at eval (eval at d (https://x.com/app.js?q=and(eq(a,1),eq(b,2))&token=SECRETB:5:40), <anonymous>:1:1)',
      );
      expect(JSON.stringify(frames)).not.toContain('SECRETB');
      expect(frames[0]?.line).toBe(1);
    });
    it('a nested eval chain ends the inner wrapper with a run of `)`', () => {
      expect(
        parseLocation(
          'eval at <anonymous> (eval at nested (https://x.com/app.js?token=S:4:31)), <anonymous>',
        ).file,
      ).toBe(
        `eval at <anonymous> (eval at nested (https://x.com/app.js?token=${R}:4:31)), <anonymous>`,
      );
    });
    it('a wrapper followed by whitespace-less text is not closed by a `)` mid-URL', () => {
      // `)` followed by `/` or `&` etc. belongs to the URL; only `)` + any `)` + `, ` or the end closes the wrapper
      expect(parseLocation('eval at f (https://x.com/a(b)/c.js?token=S), <anonymous>').file).toBe(
        `eval at f (https://x.com/a(b)/c.js?token=${R}), <anonymous>`,
      );
    });
  });

  describe('hostile `)` runs are linear (ratio against the same input without the run)', () => {
    // The verdict is a RATIO against the same input without the run, never a wall-clock budget (a fixed
    // 25/50 ms floor read 25-35 ms on shared CI runners and failed healthy code). Three things keep the ratio
    // honest on a noisy runner:
    //  1. BATCHING: the control is a few microseconds per call, which is at timer-granularity and GC-pause
    //     scale, so a single call (or a handful) gives a meaningless quotient. Each timed sample runs a batch
    //     calibrated to take at least MIN_SAMPLE_MS on the control, and both sides run the same batch size.
    //  2. WARM-UP + INTERLEAVING + MINIMUM: both sides are warmed first, then timed alternately and the best
    //     of each is kept. Noise only ever adds time, so the minimum is the least contaminated estimate.
    //  3. ATTEMPTS: a regression is a deterministic 100x-1000x gap, a scheduling stall is a transient one. A
    //     noisy attempt is therefore re-measured (up to ATTEMPTS times) and the LOWEST ratio is the verdict;
    //     a genuinely super-linear parser exceeds the threshold on every attempt, so this cannot hide it.
    const MIN_SAMPLE_MS = 4;
    const REPS = 15;
    const ATTEMPTS = 4;
    const DECISIVE = 3;
    const ABORT_SAMPLE_MS = 250; // a single hostile sample this slow is already a verdict; stop spending time
    const now = (): number =>
      (globalThis as unknown as { performance: { now(): number } }).performance.now();
    const timeBatch = (fn: () => void, batch: number): number => {
      const started = now();
      for (let i = 0; i < batch; i += 1) fn();
      return now() - started;
    };
    const measureRatio = (hostile: () => void, control: () => void): number => {
      hostile();
      for (let i = 0; i < 5; i += 1) control();
      let batch = 1;
      while (timeBatch(control, batch) < MIN_SAMPLE_MS && batch < 1_000_000) batch *= 2;
      let bestHostile = Number.POSITIVE_INFINITY;
      let bestControl = Number.POSITIVE_INFINITY;
      for (let rep = 0; rep < REPS; rep += 1) {
        const h = timeBatch(hostile, batch);
        bestHostile = Math.min(bestHostile, h);
        bestControl = Math.min(bestControl, timeBatch(control, batch));
        if (h > ABORT_SAMPLE_MS) break;
      }
      return bestHostile / bestControl;
    };
    const costRatio = (hostile: () => void, control: () => void, limit: number): number => {
      let best = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < ATTEMPTS && best >= limit; attempt += 1) {
        best = Math.min(best, measureRatio(hostile, control));
        if (best > limit * DECISIVE) break; // 3x past the threshold is a verdict, not noise: fail fast
      }
      return best;
    };

    it('a run of `)` costs linear time (no quadratic rescan of the lazy URL)', () => {
      const frames = (fill: string): string[] =>
        Array.from(
          { length: 50 },
          () => `eval at f (https://x.com/a.js?token=S${fill.repeat(4000)}x`,
        );
      const hostile = frames(')');
      const benign = frames('a');
      // healthy code measures ~2x the control; the quadratic rescan ~600x. 40 is the geometric middle.
      const ratio = costRatio(
        () => {
          for (const input of hostile) parseLocation(input);
        },
        () => {
          for (const input of benign) parseLocation(input);
        },
        40,
      );
      expect(ratio).toBeLessThan(40);
      expect(parseLocation(hostile[0] as string).file).not.toContain('token=S)');
    });

    it('many URL starts followed by a long run of `)` cost about the same as the same input without the run (the reviewer repro)', () => {
      const build = (fill: string): string =>
        `eval at ${'(https://'.repeat(152)}${fill.repeat(2700)} x`;
      const hostile = build(')');
      const benign = build('a');
      // healthy code measures ~5x the control; without the `(?<!\))` lookbehind ~2000x. 100 is the geometric middle.
      const ratio = costRatio(
        () => parseLocation(hostile),
        () => parseLocation(benign),
        100,
      );
      expect(ratio).toBeLessThan(100);
    });
  });

  it('an unusual-but-valid wrapper whose URL ends in `)` is still sanitized', () => {
    expect(parseLocation('eval at f (https://x.com/(g)), <anonymous>').file).toBe(
      'eval at f (https://x.com/(g)), <anonymous>',
    );
    expect(parseLocation('eval at f (https://x.com/(g)?token=S), <anonymous>').file).toBe(
      'eval at f (https://x.com/(g)?token=%3Credacted%3E), <anonymous>',
    );
  });

  describe('real V8 async frames: `at async <location>` (no function name, no parentheses)', () => {
    it('sanitizes a signed URL and drops the password', () => {
      const frames = parseV8Stack(
        'Error: x\n    at async https://u:pw@cdn.x.com/_next/static/a.js?token=SECRET&v=2:4:22',
      );
      expect(frames[0]).toEqual({
        file: 'https://u:%3Credacted%3E@cdn.x.com/_next/static/a.js?token=%3Credacted%3E&v=2',
        line: 4,
        column: 22,
      });
    });
    it('strips file:// and relativizes against the app root like a synchronous frame', () => {
      setStackAppRoot('/Users/alice/app');
      try {
        expect(
          parseV8Stack('Error: x\n    at async file:///Users/alice/app/src/main.mjs:3:1')[0],
        ).toEqual({
          file: './src/main.mjs',
          line: 3,
          column: 1,
        });
      } finally {
        setStackAppRoot(undefined);
      }
    });
    it('a NAMED async frame keeps its function name', () => {
      expect(parseV8Stack('Error: x\n    at async Promise.all (index 0)')[0]?.function).toBe(
        'async Promise.all',
      );
    });
  });

  describe('the 4096-character clip fails closed', () => {
    const wrapper = (total: number): string => {
      const base = 'eval at  (https://x.com/a.js?token=SECRET:1:2), <anonymous>';
      return `eval at ${'x'.repeat(total - base.length)} (https://x.com/a.js?token=SECRET:1:2), <anonymous>`;
    };
    it.each([
      [4095, false],
      [4096, false],
      [4097, true],
    ])('a wrapper of exactly %i characters (clipped: %s)', (total, clipped) => {
      const input = wrapper(total);
      expect(input.length).toBe(total);
      const out = parseLocation(input).file ?? '';
      expect(out.endsWith('…')).toBe(clipped);
      expect(out).not.toContain('SECRET');
    });
    it('a clip that lands inside the userinfo of the LAST url, with a real 4070-character prefix', () => {
      const pad = 'p'.repeat(4096 - 'eval at  (https://user:SECRETPAS'.length);
      const input = `eval at ${pad} (https://user:SECRETPASSWORD@x.com/a.js:1:2), <anonymous>`;
      const out = parseLocation(input).file ?? '';
      expect(out).not.toMatch(/SECRETPAS/);
      expect(out.endsWith('…')).toBe(true);
      expect(out.startsWith('eval at ppp')).toBe(true);
    });

    it('only the LAST open URL is dropped when an earlier URL precedes it', () => {
      const tail = '(https://user:SECRETPASSWORD@x.com/b.js:1:2)';
      const head = 'eval at  (https://x.com/a.js:1:2), <anonymous> ';
      const pad = 'p'.repeat(4096 - head.length - 'x'.length - '(https://user:SECRETPAS'.length);
      const out =
        parseLocation(`eval at ${pad} (https://x.com/a.js:1:2), <anonymous> ${tail}`).file ?? '';
      expect(out).not.toMatch(/SECRETPAS/);
      expect(out).toContain('(https://x.com/a.js:1:2), <anonymous> ');
    });

    it('the open URL is dropped exactly from its start (exact output)', () => {
      const pad = 'p'.repeat(4096 - 'eval at  (https://user:SECRETPAS'.length);
      const out = parseLocation(
        `eval at ${pad} (https://user:SECRETPASSWORD@x.com/a.js:1:2), <anonymous>`,
      ).file;
      expect(out).toBe(`eval at ${pad} (…`);
    });

    it('a URL followed by a TAB (not a space) before the cut is not open and is kept', () => {
      const input = `eval at (https://x.com/a.js:1:2),\t${'q'.repeat(5000)}`;
      expect(parseLocation(input).file).toBe(`${input.slice(0, 4096)}…`);
    });

    it('a clip AFTER the last URL ended (whitespace follows it) keeps everything before the cut', () => {
      const input = `eval at (https://x.com/a.js:1:2), <anonymous> ${'q'.repeat(5000)}`;
      const out = parseLocation(input).file ?? '';
      expect(out.startsWith('eval at (https://x.com/a.js:1:2), <anonymous> qqq')).toBe(true);
      expect(out.endsWith('…')).toBe(true);
    });

    it('a URL whose end is past the clip is sanitized, never shipped raw', () => {
      const out =
        parseLocation(
          `eval at f (https://cdn.x.com/app.js?token=eyJSECRET${'A'.repeat(4200)}:1:2), <anonymous>`,
        ).file ?? '';
      expect(out).not.toContain('eyJSECRET');
      expect(out.endsWith('…')).toBe(true);
      expect(out.length).toBeLessThanOrEqual(4097);
    });
  });

  it('script URL frames with any whitespace after the URL keep it (a tab, not just a space)', () => {
    expect(parseLocation('https://x.com/a.js?token=S\tline 2 > Function').file).toBe(
      'https://x.com/a.js?token=%3Credacted%3E\tline 2 > Function',
    );
  });

  it('the sanitized-URL cache stays bounded however many distinct URLs pass through', () => {
    for (let i = 0; i < 3000; i += 1) parseLocation(`https://x.com/c${i}.js?token=S:1:1`);
    expect(frameUrlCacheSize()).toBeLessThanOrEqual(512);
    expect(frameUrlCacheSize()).toBeGreaterThan(0);
  });

  it('redacts the password of a filesystem: frame URL', () => {
    expect(parseLocation('filesystem:https://u:pw@x.com/temporary/a.js:1:1').file).toBe(
      'filesystem:https://u:%3Credacted%3E@x.com/temporary/a.js',
    );
  });

  it('a wrapper longer than 4096 characters is clipped, never scanned whole', () => {
    const out =
      parseLocation(
        `eval at ${'x'.repeat(10_000)} (https://x.com/a.js?token=S:1:2), <anonymous>:1:1`,
      ).file ?? '';
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(4097);
  });

  describe('a signed script URL is sanitized WHOLE (up to the first whitespace), whatever it contains', () => {
    const cloudfront =
      'https://d1.cloudfront.net/_next/static/chunks/app/(dashboard)/settings/page-4f2a.js?Expires=1&Signature=AbC123SECRET~xyz&Key-Pair-Id=K2ABC';
    it('a CloudFront chunk in a route group (the real stack shape)', () => {
      const frames = parseV8Stack(`Error: x\n    at Settings (${cloudfront}:1:2345)`);
      expect(frames[0]?.file).toBe(
        'https://d1.cloudfront.net/_next/static/chunks/app/(dashboard)/settings/page-4f2a.js?Expires=1&Signature=%3Credacted%3E&Key-Pair-Id=K2ABC',
      );
      expect(JSON.stringify(frames)).not.toContain('SECRET');
    });
    it.each([
      [
        'a comma in the value',
        'https://x.com/a.js?token=abc,def',
        'https://x.com/a.js?token=%3Credacted%3E',
      ],
      [
        'a closing paren in the value',
        'https://x.com/a.js?token=a)b',
        'https://x.com/a.js?token=%3Credacted%3E',
      ],
      [
        'parens around part of the value',
        'https://x.com/a.js?token=abc(def)',
        'https://x.com/a.js?token=%3Credacted%3E',
      ],
      [
        'digits after a colon in the value',
        'https://x.com/a.js?token=abc:123',
        'https://x.com/a.js?token=%3Credacted%3E',
      ],
    ])('%s', (_name, url, expected) => {
      expect(parseLocation(`${url}:1:1`).file).toBe(expected);
      expect(parseLocation(url).file).toBe(expected);
    });
  });

  it('redacts the password of a blob: frame URL', () => {
    expect(parseLocation('blob:https://u:pw@x.com/uuid-1:2:3').file).toBe(
      'blob:https://u:%3Credacted%3E@x.com/uuid-1',
    );
  });

  it('a long run of letters with no URL in it costs linear time and is returned as is', () => {
    const long = `${'a'.repeat(200_000)}://`; // `://` present, but no token can start inside the run
    const started = Date.now();
    parseLocation(`${long}:1:1`);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('redacts credentials and signed query values in a script URL frame, keeps an ordinary one', () => {
    expect(parseLocation('https://u:pw@app.test/a.js?token=SECRET&v=2:3:4').file).toBe(
      'https://u:%3Credacted%3E@app.test/a.js?token=%3Credacted%3E&v=2',
    );
    expect(parseLocation('https://app.test/a.js?v=2:3:4').file).toBe('https://app.test/a.js?v=2');
    expect(parseV8Stack('Error: x\n    at fn (https://app.test/a.js?token=S:1:2)')[0]?.file).toBe(
      'https://app.test/a.js?token=%3Credacted%3E',
    );
  });

  it('parses a typical Node stack into structured frames', () => {
    const stack = [
      'Error: boom',
      '    at doWork (/app/src/work.js:10:15)',
      '    at /app/src/index.js:5:1',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n');
    expect(parseV8Stack(stack)).toEqual([
      { function: 'doWork', file: '/app/src/work.js', line: 10, column: 15 },
      { file: '/app/src/index.js', line: 5, column: 1 },
      {
        function: 'process.processTicksAndRejections',
        file: 'node:internal/process/task_queues',
        line: 95,
        column: 5,
      },
    ]);
  });

  it('skips the header line and any non-frame lines', () => {
    expect(parseV8Stack('Error: nope\nsome noise\n    at f (/a.js:1:2)')).toEqual([
      { function: 'f', file: '/a.js', line: 1, column: 2 },
    ]);
  });

  it('strips a file:// URL from a frame path', () => {
    expect(parseV8Stack('    at Object.<anonymous> (file:///app/main.js:1:1)')).toEqual([
      { function: 'Object.<anonymous>', file: '/app/main.js', line: 1, column: 1 },
    ]);
  });

  it('normalizes a webpack:// frame path to a friendly path', () => {
    expect(parseV8Stack('    at mod (webpack:///./src/app.ts:3:7)')).toEqual([
      { function: 'mod', file: './src/app.ts', line: 3, column: 7 },
    ]);
  });

  it('handles an anonymous frame with no function name', () => {
    expect(parseV8Stack('    at /lib/x.js:42:9')).toEqual([
      { file: '/lib/x.js', line: 42, column: 9 },
    ]);
  });

  it('splits at the first " (" so a parenthesized path stays in the location', () => {
    expect(parseV8Stack('    at handler (/app (prod)/server.js:8:3)')).toEqual([
      { function: 'handler', file: '/app (prod)/server.js', line: 8, column: 3 },
    ]);
  });

  it('handles a location without line/column (e.g. <anonymous>)', () => {
    expect(parseV8Stack('    at Generator.next (<anonymous>)')).toEqual([
      { function: 'Generator.next', file: '<anonymous>' },
    ]);
  });

  it('omits the function key entirely for a bare-location frame (no function: undefined)', () => {
    const frame = parseV8Stack('    at /lib/x.js:42:9')[0];
    expect(frame).not.toHaveProperty('function');
  });

  it('does not split "fn (loc" without a closing paren (the path keeps the " (")', () => {
    // endsWith(")") guards the split; a truncated line is treated as a bare location.
    expect(parseV8Stack('    at fn (/a.js:1:2')).toEqual([
      { file: 'fn (/a.js', line: 1, column: 2 },
    ]);
  });

  it('does not treat a noise line merely starting with "at" as a frame (the space matters)', () => {
    expect(parseV8Stack('Error\natypical noise here')).toEqual([]);
  });

  it('does not treat a trailing ")" without a " (" as a function split', () => {
    // Pins the `open !== -1` conjunct: "weird)" has no " (", so it stays a bare location.
    expect(parseV8Stack('    at weird)')).toEqual([{ file: 'weird)' }]);
  });

  it('returns an empty array for a stack with no frames', () => {
    expect(parseV8Stack('Error: just a message')).toEqual([]);
  });

  it('returns an empty array for an empty string', () => {
    expect(parseV8Stack('')).toEqual([]);
  });
});

describe('parseLocation', () => {
  it('parses file:line:column and scrubs the path (file:// and webpack://)', () => {
    expect(parseLocation('file:///app/main.js:1:1')).toEqual({
      file: '/app/main.js',
      line: 1,
      column: 1,
    });
    expect(parseLocation('webpack:///./src/app.ts:3:7')).toEqual({
      file: './src/app.ts',
      line: 3,
      column: 7,
    });
  });

  it('returns a bare scrubbed file when there is no line:column', () => {
    expect(parseLocation('<anonymous>')).toEqual({ file: '<anonymous>' });
    expect(parseLocation('file:///lib/x.js')).toEqual({ file: '/lib/x.js' });
  });

  it('only strips the full file:// and webpack:// prefixes, not a single-slash lookalike', () => {
    expect(parseLocation('file:/local/x.js')).toEqual({ file: 'file:/local/x.js' });
    expect(parseLocation('webpack:/local/x.js')).toEqual({ file: 'webpack:/local/x.js' });
  });

  it('does not split a location whose file part would be empty or non-numeric line/col', () => {
    // `(.+)` (not `.*`) requires a non-empty file; `(\\d+)` requires real digits.
    expect(parseLocation(':1:2')).toEqual({ file: ':1:2' });
    expect(parseLocation('a::2')).toEqual({ file: 'a::2' });
  });

  it('requires a fully-numeric column anchored to the end (no empty / trailing-garbage column)', () => {
    // Pins `(\\d+)$`: an empty column or trailing junk must NOT match (stays a bare file).
    expect(parseLocation('a:1:')).toEqual({ file: 'a:1:' });
    expect(parseLocation('a:1:2extra')).toEqual({ file: 'a:1:2extra' });
  });
});

describe('formatStack', () => {
  it('renders frames with function, file, line and column', () => {
    expect(formatStack([{ function: 'doWork', file: '/a.js', line: 10, column: 5 }])).toBe(
      '    at doWork (/a.js:10:5)',
    );
  });

  it('uses <anonymous> for a frame without a function name', () => {
    expect(formatStack([{ file: '/a.js', line: 1, column: 2 }])).toBe(
      '    at <anonymous> (/a.js:1:2)',
    );
  });

  it('omits line/column for a frame that has none', () => {
    expect(formatStack([{ function: 'f', file: '<anonymous>' }])).toBe('    at f (<anonymous>)');
  });

  it('omits the location numbers unless BOTH line and column are present', () => {
    // The `&&` is load-bearing: a half-located frame must not render ":undefined".
    expect(formatStack([{ function: 'f', file: '/a', line: 5 }])).toBe('    at f (/a)');
    expect(formatStack([{ function: 'f', file: '/a', column: 5 }])).toBe('    at f (/a)');
  });

  it('keeps an explicit empty function name (?? only fills undefined, not "")', () => {
    expect(formatStack([{ function: '', file: '/a', line: 1, column: 2 }])).toBe(
      '    at  (/a:1:2)',
    );
  });

  it('joins multiple frames with newlines and round-trips a parsed stack', () => {
    const stack = '    at a (/x.js:1:2)\n    at b (/y.js:3:4)';
    expect(formatStack(parseV8Stack(stack))).toBe(stack);
  });

  it('returns an empty string for no frames', () => {
    expect(formatStack([])).toBe('');
  });

  it('appends an additive ` debugId=<id>` suffix when a frame carries a debug-ID', () => {
    expect(
      formatStack([{ function: 'f', file: '/a.js', line: 1, column: 2, debugId: 'abc-123' }]),
    ).toBe('    at f (/a.js:1:2) debugId=abc-123');
  });

  it('omits the suffix for frames without a debug-ID', () => {
    expect(formatStack([{ function: 'f', file: '/a.js', line: 1, column: 2 }])).not.toContain(
      'debugId',
    );
  });
});

describe('callSiteFrames — a stack for a value that never had one', () => {
  // A thrown non-Error (a string, a plain object, null) carries no stack, so `crash.json` shipped
  // `frames: []`. That costs more than a location: worker/crash/managed/common.py:88 only emits
  // grouping signatures when it has a top frame, so EVERY occurrence became a new issue. Four
  // identical `logException('...')` calls produced SBROWSER-32/35/38/41, one event each.
  //
  // The caller's own frames are the fault site; only the SDK's frames have to go.

  it('drops the boundary and everything the SDK called above it (Error.captureStackTrace)', () => {
    const parse = (stack: string) =>
      stack
        .split('\n')
        .filter((l) => l.trim().startsWith('at '))
        .map((l) => ({ file: 'f', function: l.trim().slice(3).split(' ')[0] }) as StackFrame);

    function boundary(): StackFrame[] {
      return callSiteFrames(new Error(), boundary, parse);
    }
    function applicationCode(): StackFrame[] {
      return boundary();
    }

    const frames = applicationCode();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]?.function).toBe('applicationCode'); // the caller, not the SDK
    expect(frames.map((f) => f.function)).not.toContain('boundary');
  });

  it('falls back to dropping exactly the boundary frame where captureStackTrace is absent', () => {
    // Measured 2026-08-26: Chromium, Firefox AND WebKit all expose Error.captureStackTrace, so this
    // path is for older engines only. It stays deterministic by construction rather than by matching
    // function names (which minification renames): the Error is created INSIDE the boundary, so the
    // boundary is always frame 0 and dropping one frame is exact.
    const original = (Error as { captureStackTrace?: unknown }).captureStackTrace;
    (Error as { captureStackTrace?: unknown }).captureStackTrace = undefined;
    try {
      const parse = (): StackFrame[] => [
        { file: 'sdk', function: 'boundary' },
        { file: 'app', function: 'applicationCode' },
      ];
      const frames = callSiteFrames(new Error(), function boundary() {}, parse);
      expect(frames.map((f) => f.function)).toEqual(['applicationCode']);
    } finally {
      (Error as { captureStackTrace?: unknown }).captureStackTrace = original;
    }
  });

  it('fallback drops `sdkFrames` frames when the boundary is not the frame the Error is built in', () => {
    const original = (Error as { captureStackTrace?: unknown }).captureStackTrace;
    (Error as { captureStackTrace?: unknown }).captureStackTrace = undefined;
    try {
      const parse = (): StackFrame[] => [
        { file: 'sdk', function: 'internal' },
        { file: 'sdk', function: 'wrapper' },
        { file: 'app', function: 'applicationCode' },
      ];
      const frames = callSiteFrames(new Error(), function wrapper() {}, parse, 2);
      expect(frames.map((f) => f.function)).toEqual(['applicationCode']);
    } finally {
      (Error as { captureStackTrace?: unknown }).captureStackTrace = original;
    }
  });

  it('returns no frames when the engine produces no stack at all', () => {
    // Very old engines (and some embedded ones) leave `error.stack` undefined. `?? ''` keeps that a
    // frameless report rather than a thrown SDK — the same outcome as before this existed.
    const original = (Error as { captureStackTrace?: unknown }).captureStackTrace;
    (Error as { captureStackTrace?: unknown }).captureStackTrace = undefined;
    try {
      const noStack = new Error();
      Object.defineProperty(noStack, 'stack', { value: undefined });
      expect(callSiteFrames(noStack, function boundary() {}, parseV8Stack)).toEqual([]);
    } finally {
      (Error as { captureStackTrace?: unknown }).captureStackTrace = original;
    }
  });

  it('returns no frames when the engine produces no stack, WITH captureStackTrace present', () => {
    // Symmetric case: the capture runs but the engine leaves nothing readable on the target.
    const original = (Error as { captureStackTrace?: unknown }).captureStackTrace;
    (Error as { captureStackTrace?: unknown }).captureStackTrace = () => undefined;
    try {
      expect(callSiteFrames(new Error(), function boundary() {}, parseV8Stack)).toEqual([]);
    } finally {
      (Error as { captureStackTrace?: unknown }).captureStackTrace = original;
    }
  });

  // Recorded from the macOS `jsc` shell (JavaScriptCore, the engine under Safari and every iOS WebView),
  // 2026-10-12, paths shortened. JSC has no `at`: `function@location`.
  const JSC_BOUNDARY_DROPPED =
    'applicationCode@https://app.example.com/main.js:12:30\nglobal code@https://app.example.com/main.js:20:11';
  const JSC_FULL_STACK =
    'internalLog@https://app.example.com/sdk.js:2:41\nlogException@https://app.example.com/sdk.js:4:49\napplicationCode@https://app.example.com/main.js:12:30\nglobal code@https://app.example.com/main.js:20:11';
  const atParser = (stack: string): StackFrame[] =>
    stack
      .split('\n')
      .map((l) => l.split('@'))
      .map(([fn, file]) => ({ function: fn, file }) as StackFrame);

  it('captures into a plain holder, never re-capturing the Error: JSC ignores a second capture', () => {
    // JavaScriptCore does not re-capture an Error that already has a stack, so frame 0 stayed the SDK
    // frame. A fresh holder object has no stack to keep.
    const original = (Error as { captureStackTrace?: unknown }).captureStackTrace;
    const targets: object[] = [];
    (Error as { captureStackTrace?: unknown }).captureStackTrace = (t: { stack?: string }) => {
      targets.push(t);
      t.stack = JSC_BOUNDARY_DROPPED;
    };
    try {
      const error = new Error();
      const boundary = function boundary() {};
      const frames = callSiteFrames(error, boundary, atParser);
      expect(targets).toHaveLength(1);
      expect(targets[0]).not.toBe(error);
      expect(targets[0]).not.toBeInstanceOf(Error);
      expect(frames[0]?.function).toBe('applicationCode');
      expect(frames.map((f) => f.function)).toEqual(['applicationCode', 'global code']);
    } finally {
      (Error as { captureStackTrace?: unknown }).captureStackTrace = original;
    }
  });

  it('passes the boundary to captureStackTrace', () => {
    const original = (Error as { captureStackTrace?: unknown }).captureStackTrace;
    const seen: unknown[] = [];
    (Error as { captureStackTrace?: unknown }).captureStackTrace = (_t: object, fn: unknown) => {
      seen.push(fn);
    };
    try {
      const boundary = function boundary() {};
      callSiteFrames(new Error(), boundary, atParser);
      expect(seen).toEqual([boundary]);
    } finally {
      (Error as { captureStackTrace?: unknown }).captureStackTrace = original;
    }
  });

  it('fallback on a recorded JSC stack drops the SDK frames and leaves the application first', () => {
    const original = (Error as { captureStackTrace?: unknown }).captureStackTrace;
    (Error as { captureStackTrace?: unknown }).captureStackTrace = undefined;
    try {
      const error = new Error();
      Object.defineProperty(error, 'stack', { value: JSC_FULL_STACK });
      const frames = callSiteFrames(error, function logException() {}, atParser, 2);
      expect(frames[0]?.function).toBe('applicationCode');
    } finally {
      (Error as { captureStackTrace?: unknown }).captureStackTrace = original;
    }
  });

  it('never throws and never leaves the caller without an array', () => {
    const frames = callSiteFrames(
      new Error(),
      function boundary() {},
      () => {
        throw new Error('parser exploded');
      },
    );
    expect(frames).toEqual([]);
  });
});

describe("scrubFramePath — the customer's filesystem must not ship in a crash", () => {
  // A Node crash frame carried the FULL absolute path: the OS username, the home-directory layout and
  // often an internal project codename, in every report. The SDK's rule is that privacy-relevant data is
  // obscured to the maximum extent possible BY DEFAULT, and this was shipped behaviour that broke it.

  it('truncates a dependency path at the FIRST node_modules boundary, not the last', () => {
    // Load-bearing. `file` is the key of the `file → debugId` source-map join, so two distinct files
    // scrubbing to one string would hand a frame the WRONG debug id and symbolicate it against the wrong
    // map — worse than the leak. Measured on a real 24,591-file pnpm tree: truncating at the LAST
    // boundary collapses 2,783 distinct files onto shared keys; at the FIRST, zero.
    expect(
      parseLocation('/Users/jane/app/node_modules/a/node_modules/lodash/index.js:1:1').file,
    ).toBe('node_modules/a/node_modules/lodash/index.js');
    // …so a nested copy stays distinguishable from a hoisted one, which is the whole duplicate-package
    // signal: same package, two versions, one process.
    expect(parseLocation('/Users/jane/app/node_modules/lodash/index.js:1:1').file).toBe(
      'node_modules/lodash/index.js',
    );
  });

  it('keeps the pnpm version directory, which carries the version for free', () => {
    expect(
      parseLocation('/Users/jane/app/node_modules/.pnpm/ipaddr.js@2.4.0/node_modules/ipaddr.js:1:1')
        .file,
    ).toBe('node_modules/.pnpm/ipaddr.js@2.4.0/node_modules/ipaddr.js');
  });

  it('leaves a URL alone — a browser frame is not a filesystem path', () => {
    // The leak is node-family only. Scrubbing a URL would destroy the origin, which IS the useful part.
    expect(parseLocation('https://app.example.com/static/js/main.abc.js:9:1').file).toBe(
      'https://app.example.com/static/js/main.abc.js',
    );
  });

  it('leaves an already-relative path alone', () => {
    expect(parseLocation('./src/app.ts:3:7').file).toBe('./src/app.ts');
  });
});

describe('setStackAppRoot — application paths must not carry the machine', () => {
  afterEach(() => {
    setStackAppRoot(undefined); // module state: every test must leave it as it found it
  });

  it('relativises a frame beneath the app root', () => {
    // The other half of the frame-path leak. Dependency frames have `node_modules` as a landmark;
    // application frames have none, so the platform has to say where the project starts.
    setStackAppRoot('/Users/jane/work/acme-secret');
    expect(parseLocation('/Users/jane/work/acme-secret/src/checkout.js:9:3').file).toBe(
      './src/checkout.js',
    );
  });

  it('accepts a root that already ends in a separator', () => {
    setStackAppRoot('/Users/jane/app/');
    expect(parseLocation('/Users/jane/app/src/a.js:1:1').file).toBe('./src/a.js');
  });

  it('does NOT match a sibling directory that merely shares a prefix', () => {
    // `/app` must not swallow `/apples`. Storing the root with its separator is what prevents it.
    setStackAppRoot('/app');
    expect(parseLocation('/apples/x.js:1:1').file).toBe('/apples/x.js');
  });

  it('leaves a frame OUTSIDE the app root alone', () => {
    setStackAppRoot('/Users/jane/app');
    expect(parseLocation('/usr/local/lib/tool.js:1:1').file).toBe('/usr/local/lib/tool.js');
  });

  it('still truncates dependencies at node_modules, root or no root', () => {
    // Order matters: a dependency inside the project would otherwise relativise to
    // `./node_modules/express/...`, which is longer and says nothing extra.
    setStackAppRoot('/Users/jane/app');
    expect(parseLocation('/Users/jane/app/node_modules/express/index.js:1:1').file).toBe(
      'node_modules/express/index.js',
    );
  });

  it('restores absolute paths when the root is cleared', () => {
    setStackAppRoot('/Users/jane/app');
    setStackAppRoot(undefined);
    expect(parseLocation('/Users/jane/app/src/a.js:1:1').file).toBe('/Users/jane/app/src/a.js');
  });

  it('ignores an empty root rather than relativising everything to nothing', () => {
    setStackAppRoot('');
    expect(parseLocation('/Users/jane/app/src/a.js:1:1').file).toBe('/Users/jane/app/src/a.js');
  });

  it('leaves URLs alone, root or no root', () => {
    setStackAppRoot('/Users/jane/app');
    expect(parseLocation('https://app.test/static/main.js:1:1').file).toBe(
      'https://app.test/static/main.js',
    );
  });

  it('reaches the appended console stack too, not just crash frames', () => {
    // `console.trace` appends `formatStack` into the log MESSAGE, which is why this is scrubbed at parse
    // time rather than in the crash path: a fix that covered only crash frames would leave logs.json
    // carrying the same absolute paths.
    setStackAppRoot('/Users/jane/app');
    const formatted = formatStack(parseV8Stack('Error\n    at run (/Users/jane/app/src/a.js:2:1)'));
    expect(formatted).toContain('./src/a.js');
    expect(formatted).not.toContain('/Users/jane');
  });
});
