import type { StackFrame } from '@bugsee/core';
import { REDACTED } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  alignReportSite,
  attachLocals,
  collectScope,
  createFrameEnricher,
  createInspectorSession,
  createLocalVariablesCapture,
  type InspectorSessionLike,
  type LocalVariablesCapture,
  type LocalVariablesOptions,
  type ReportSiteFrame,
  renderValue,
} from './local-variables';

/** A fake inspector session: records posts, answers `Runtime.getProperties` from a script. */
function fakeSession(properties: Record<string, readonly unknown[]> = {}) {
  const posts: Array<{ method: string; params?: unknown }> = [];
  let paused: ((message: { params: unknown }) => void) | undefined;
  let parsed: ((message: { params: unknown }) => void) | undefined;
  const session: InspectorSessionLike = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    post: vi.fn((method, params, callback) => {
      posts.push({ method, params });
      if (method === 'Runtime.getProperties' && callback !== undefined) {
        const id = (params as { objectId: string }).objectId;
        // Synchronous callback: the real session is async, but ordering is what these tests are about.
        callback(null, { result: properties[id] ?? [] });
      }
    }),
    on: vi.fn((event, handler) => {
      if (event === 'Debugger.paused') paused = handler;
      if (event === 'Debugger.scriptParsed') parsed = handler;
    }),
  };
  const scope = (objectId: string) => ({ type: 'local', object: { objectId } });
  return {
    session,
    posts,
    methods: () => posts.map((p) => p.method),
    fire: (params: unknown) => paused?.({ params }),
    /** Announce a script, as the real session does on `Debugger.enable`. */
    parse: (scriptId: string, url: string) => parsed?.({ params: { scriptId, url } }),
    scope,
  };
}

describe('renderValue', () => {
  it.each([
    [{ type: 'number', value: 42 }, '42'],
    [{ type: 'boolean', value: false }, 'false'],
    [{ type: 'string', value: 'hi' }, 'hi'],
    [{ type: 'undefined' }, 'undefined'],
    [{ type: 'object', subtype: 'null' }, 'null'],
    [undefined, 'undefined'],
  ])('renders %o as %s', (input, expected) => {
    expect(renderValue(input, 120)).toBe(expected);
  });

  it("uses V8's own description for an object rather than calling user code", () => {
    // Never invoke a user `toString`: it can throw, and it can have side effects. The SDK sits inside
    // someone else's crash — it must not run their code to describe it.
    expect(renderValue({ type: 'object', description: 'Array(3)' }, 120)).toBe('Array(3)');
  });

  it('truncates a long value and marks it', () => {
    expect(renderValue({ type: 'string', value: 'x'.repeat(200) }, 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('falls back to the type when there is neither a value nor a description', () => {
    expect(renderValue({ type: 'symbol' }, 120)).toBe('symbol');
  });
});

describe('renderValue — one-level unrolling', () => {
  // V8 hands back an ObjectPreview in the SAME `Runtime.getProperties` response when
  // `generatePreview` is set, so the contents cost no extra round-trip and no extra pause time.
  const preview = (
    properties: Array<{ name: string; type: string; value: string }>,
    overflow = false,
  ) => ({ overflow, properties });

  it('renders an object’s own properties instead of the bare word "Object"', () => {
    // The whole point: `customer: "Object"` told a reader nothing at all.
    expect(
      renderValue(
        {
          type: 'object',
          description: 'Object',
          preview: preview([
            { name: 'tier', type: 'string', value: 'gold' },
            { name: 'seats', type: 'number', value: '7' },
          ]),
        },
        120,
      ),
    ).toBe("{tier: 'gold', seats: 7}");
  });

  it('renders an array with brackets and no keys', () => {
    expect(
      renderValue(
        {
          type: 'object',
          subtype: 'array',
          description: 'Array(3)',
          preview: preview([
            { name: '0', type: 'number', value: '1' },
            { name: '1', type: 'string', value: 'two' },
          ]),
        },
        120,
      ),
    ).toBe("[1, 'two']");
  });

  it('marks a truncated preview, so a short render is not mistaken for the whole object', () => {
    expect(
      renderValue(
        {
          type: 'object',
          description: 'Object',
          preview: preview([{ name: 'k0', type: 'number', value: '0' }], true),
        },
        120,
      ),
    ).toBe('{k0: 0, …}');
  });

  it('REDACTS a sensitive nested key, exactly as it does a top-level one', () => {
    // A secret does not stop being a secret one level down. `isSensitiveKey` is the SDK's single
    // definition and is applied at every depth we render.
    expect(
      renderValue(
        {
          type: 'object',
          description: 'Object',
          preview: preview([
            { name: 'user', type: 'string', value: 'ada' },
            { name: 'password', type: 'string', value: 'hunter2' },
          ]),
        },
        120,
      ),
    ).toBe("{user: 'ada', password: <redacted>}");
  });

  it('keeps a nested object opaque — one level only, never a deep walk', () => {
    expect(
      renderValue(
        {
          type: 'object',
          description: 'Object',
          preview: preview([{ name: 'nested', type: 'object', value: 'Object' }]),
        },
        120,
      ),
    ).toBe('{nested: Object}');
  });

  it('still honours maxValueLength once unrolled', () => {
    const rendered = renderValue(
      {
        type: 'object',
        description: 'Object',
        preview: preview([{ name: 'blob', type: 'string', value: 'x'.repeat(200) }]),
      },
      20,
    );
    expect(rendered.length).toBe(21); // 20 + the ellipsis
    expect(rendered.endsWith('…')).toBe(true);
  });

  it('falls back to the description when V8 sent no preview', () => {
    expect(renderValue({ type: 'object', description: 'Object' }, 120)).toBe('Object');
  });

  it('renders an EMPTY preview as an empty literal, not as "Object"', () => {
    expect(renderValue({ type: 'object', description: 'Object', preview: preview([]) }, 120)).toBe(
      '{}',
    );
  });
});

describe('collectScope', () => {
  it('REDACTS a variable whose NAME says it is a secret', () => {
    // Derived from `@bugsee/protocol`'s `isSensitiveKey` — the SDK's single definition of a sensitive
    // key, the same one that redacts headers and query params — never restated here. A local called
    // `password` is a password.
    const out = collectScope(
      [
        { name: 'password', value: { type: 'string', value: 'hunter2' } },
        { name: 'accessToken', value: { type: 'string', value: 'abc' } },
        { name: 'orderId', value: { type: 'number', value: 7 } },
      ],
      20,
      120,
    );
    expect(out).toEqual({ password: REDACTED, accessToken: REDACTED, orderId: '7' });
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('caps the number of variables it keeps', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      name: `v${i}`,
      value: { type: 'number', value: i },
    }));
    expect(Object.keys(collectScope(many, 3, 120))).toEqual(['v0', 'v1', 'v2']);
  });

  it('skips a property with no usable name rather than inventing one', () => {
    expect(collectScope([{ value: { type: 'number', value: 1 } }], 20, 120)).toEqual({});
  });
});

describe('createLocalVariablesCapture', () => {
  it('is INERT without an injected session', () => {
    const capture = createLocalVariablesCapture();
    expect(capture.lookup(new Error('x'))).toBeUndefined();
    expect(() => capture.stop()).not.toThrow();
  });

  it('pauses on UNCAUGHT exceptions only by default', () => {
    // ~36µs per caught throw was measured for 'all'; an app that throws in a hot path would pay it on
    // every one. So the expensive mode is an opt-in on top of an opt-in.
    const f = fakeSession();
    createLocalVariablesCapture({ session: f.session });
    expect(f.posts.find((p) => p.method === 'Debugger.setPauseOnExceptions')?.params).toEqual({
      state: 'uncaught',
    });
  });

  it('pauses on ALL exceptions when includeCaught is set', () => {
    const f = fakeSession();
    createLocalVariablesCapture({ session: f.session, includeCaught: true });
    expect(f.posts.find((p) => p.method === 'Debugger.setPauseOnExceptions')?.params).toEqual({
      state: 'all',
    });
  });

  it('asks V8 to PREVIEW each value, so an object arrives unrolled at no extra round-trip', () => {
    // Without `generatePreview` V8 sends only a description and every object renders as the word
    // "Object". Sentry pays a SECOND `Runtime.getProperties` per object-valued local instead; this
    // rides the response we were already waiting for, inside a paused process.
    const f = fakeSession({ 'scope-0': [] });
    createLocalVariablesCapture({ session: f.session });
    f.fire({ callFrames: [{ scopeChain: [f.scope('scope-0')] }], data: { objectId: 'thrown-1' } });

    const call = f.posts.find((p) => p.method === 'Runtime.getProperties');
    expect(call?.params).toEqual({
      objectId: 'scope-0',
      ownProperties: true,
      generatePreview: true,
    });
  });

  it('captures locals per frame and hands them back for the thrown error', () => {
    const f = fakeSession({
      'scope-0': [{ name: 'orderId', value: { type: 'object', subtype: 'null' } }],
      'scope-1': [{ name: 'attempt', value: { type: 'number', value: 2 } }],
    });
    const capture = createLocalVariablesCapture({ session: f.session });
    f.fire({
      callFrames: [{ scopeChain: [f.scope('scope-0')] }, { scopeChain: [f.scope('scope-1')] }],
      data: { objectId: 'thrown-1' },
    });
    // The stamp is what lets a pause be matched to the Error the SDK captures later.
    const stamp = f.posts.find((p) => p.method === 'Runtime.callFunctionOn');
    expect(stamp).toBeDefined();
    const id = /value:'([^']+)'/.exec(
      String((stamp?.params as { functionDeclaration: string }).functionDeclaration),
    )?.[1];
    const error = Object.defineProperty(new Error('boom'), '__bugsee_locals_id__', { value: id });
    expect(capture.lookup(error)).toEqual([{ orderId: 'null' }, { attempt: '2' }]);
  });

  it('ALWAYS resumes — a debugger that pauses and never resumes freezes the application', () => {
    // Strictly worse than having no local variables at all, so every path out of a pause resumes:
    // the happy path, a frame with no local scope, a getProperties error, and a malformed event.
    for (const event of [
      {
        callFrames: [{ scopeChain: [{ type: 'local', object: { objectId: 'nope' } }] }],
        data: { objectId: 't' },
      },
      { callFrames: [{ scopeChain: [] }], data: { objectId: 't' } },
      { callFrames: [], data: { objectId: 't' } },
      { callFrames: [{ scopeChain: [{ type: 'local', object: {} }] }] },
      {},
      null,
    ]) {
      const f = fakeSession();
      createLocalVariablesCapture({ session: f.session });
      f.fire(event);
      expect(f.methods(), `event ${JSON.stringify(event)} left the app paused`).toContain(
        'Debugger.resume',
      );
    }
  });

  it('resumes and keeps nothing when the thrown object cannot be identified', () => {
    // Without the thrown object's id the pause cannot be matched to any Error, so caching would be
    // guessing — and attaching one exception's locals to another is worse than attaching none.
    const f = fakeSession({ s: [{ name: 'a', value: { type: 'number', value: 1 } }] });
    const capture = createLocalVariablesCapture({ session: f.session });
    f.fire({ callFrames: [{ scopeChain: [f.scope('s')] }] }); // no `data`
    expect(f.methods()).toContain('Debugger.resume');
    expect(f.methods()).not.toContain('Runtime.callFunctionOn');
    expect(capture.lookup(new Error('x'))).toBeUndefined();
  });

  it('bounds the cache so a continuously-throwing app cannot grow it without limit', () => {
    const f = fakeSession({ s: [{ name: 'a', value: { type: 'number', value: 1 } }] });
    const capture = createLocalVariablesCapture({ session: f.session, maxCached: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      f.fire({ callFrames: [{ scopeChain: [f.scope('s')] }], data: { objectId: `t${i}` } });
      const stamps = f.posts.filter((p) => p.method === 'Runtime.callFunctionOn');
      const decl = String(
        (stamps[stamps.length - 1]?.params as { functionDeclaration: string }).functionDeclaration,
      );
      ids.push(/value:'([^']+)'/.exec(decl)?.[1] ?? '');
    }
    const at = (id: string) =>
      capture.lookup(Object.defineProperty(new Error('x'), '__bugsee_locals_id__', { value: id }));
    expect(at(ids[0] as string)).toBeUndefined(); // evicted
    expect(at(ids[1] as string)).toBeUndefined();
    expect(at(ids[3] as string)).toBeDefined(); // newest kept
  });

  it('reports a getProperties failure and still resumes', () => {
    const onError = vi.fn();
    const posts: string[] = [];
    const session: InspectorSessionLike = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      post: vi.fn((method, _params, callback) => {
        posts.push(method);
        if (method === 'Runtime.getProperties') callback?.(new Error('detached'));
      }),
      on: vi.fn(),
    };
    let paused: ((m: { params: unknown }) => void) | undefined;
    session.on = ((event: string, handler: (m: { params: unknown }) => void) => {
      if (event === 'Debugger.paused') paused = handler;
    }) as InspectorSessionLike['on'];
    createLocalVariablesCapture({ session, onError });
    paused?.({
      params: {
        callFrames: [{ scopeChain: [{ type: 'local', object: { objectId: 'x' } }] }],
        data: { objectId: 't' },
      },
    });
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(posts).toContain('Debugger.resume');
  });

  it('degrades to inert when the session refuses to start', () => {
    const onError = vi.fn();
    const session: InspectorSessionLike = {
      connect: () => {
        throw new Error('inspector unavailable');
      },
      disconnect: vi.fn(),
      post: vi.fn(),
      on: vi.fn(),
    };
    const capture = createLocalVariablesCapture({ session, onError });
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(capture.lookup(new Error('x'))).toBeUndefined();
  });

  it('stops cleanly, and a pause arriving after stop still resumes', () => {
    const f = fakeSession({ s: [{ name: 'a', value: { type: 'number', value: 1 } }] });
    const capture = createLocalVariablesCapture({ session: f.session });
    capture.stop();
    expect(f.methods()).toContain('Debugger.disable');
    expect(f.session.disconnect).toHaveBeenCalled();
    f.fire({ callFrames: [{ scopeChain: [f.scope('s')] }], data: { objectId: 't' } });
    expect(f.methods().filter((m) => m === 'Debugger.resume').length).toBeGreaterThan(0);
  });
});

describe('createLocalVariablesCapture — the session failing mid-flight', () => {
  /** A session whose `post` throws for the named methods, so each failure path can be driven. */
  const throwingOn = (methods: readonly string[]) => {
    let paused: ((m: { params: unknown }) => void) | undefined;
    const posts: string[] = [];
    const session: InspectorSessionLike = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      post: vi.fn((method, params, callback) => {
        posts.push(method);
        if (methods.includes(method)) throw new Error(`${method} failed`);
        if (method === 'Runtime.getProperties' && callback !== undefined) {
          void params;
          callback(null, { result: [{ name: 'a', value: { type: 'number', value: 1 } }] });
        }
      }),
      on: ((event: string, handler: (m: { params: unknown }) => void) => {
        if (event === 'Debugger.paused') paused = handler;
      }) as InspectorSessionLike['on'],
    };
    return { session, posts, fire: (params: unknown) => paused?.({ params }) };
  };
  const localFrame = {
    callFrames: [{ scopeChain: [{ type: 'local', object: { objectId: 's' } }] }],
    data: { objectId: 't' },
  };

  it('reports a failure to RESUME rather than throwing out of the pause handler', () => {
    const onError = vi.fn();
    const t = throwingOn(['Debugger.resume']);
    createLocalVariablesCapture({ session: t.session, onError });
    expect(() => t.fire(localFrame)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('drops the cached locals when the thrown object cannot be STAMPED', () => {
    // Without the stamp nothing can ever look these up, so keeping them would only consume the bounded
    // cache and evict entries that are still reachable.
    const onError = vi.fn();
    const t = throwingOn(['Runtime.callFunctionOn']);
    const capture = createLocalVariablesCapture({ session: t.session, onError });
    t.fire(localFrame);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(t.posts).toContain('Debugger.resume'); // still resumed
    expect(
      capture.lookup(
        Object.defineProperty(new Error('x'), '__bugsee_locals_id__', { value: 'lv1' }),
      ),
    ).toBeUndefined();
  });

  it('reports a failure to shut the session down, rather than throwing out of stop()', () => {
    const onError = vi.fn();
    const t = throwingOn(['Debugger.disable']);
    const capture = createLocalVariablesCapture({ session: t.session, onError });
    expect(() => capture.stop()).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('attachLocals', () => {
  const frames = [
    { file: 'a.js', line: 1, function: 'top' },
    { file: 'b.js', line: 2, function: 'mid' },
    { file: 'c.js', line: 3, function: 'deep' },
  ];

  it('returns the SAME array when there is nothing to attach', () => {
    // The overwhelmingly common path: a process that never paused. It must not copy anything.
    expect(attachLocals(undefined, frames)).toBe(frames);
    expect(attachLocals([], frames)).toBe(frames);
  });

  it('attaches each scope to its own frame, top first', () => {
    const out = attachLocals([{ a: '1' }, { b: '2' }], frames);
    expect(out[0]?.variables).toEqual({ a: '1' });
    expect(out[1]?.variables).toEqual({ b: '2' });
  });

  it('leaves frames past the captured depth untouched', () => {
    // Capture is capped at maxFrames, so the deep frames of a long stack legitimately have none.
    expect(attachLocals([{ a: '1' }], frames)[2]).not.toHaveProperty('variables');
  });

  it('does not put an EMPTY scope on a frame', () => {
    // "No locals here" and "we captured nothing" should not look the same on the wire.
    expect(attachLocals([{}], frames)[0]).not.toHaveProperty('variables');
  });
});

describe('createInspectorSession — refusing to fight another debugger', () => {
  // `Debugger.enable` is not exclusive, but `setPauseOnExceptions` IS process-wide state: whichever
  // client sets it last wins. Attaching underneath a developer's `--inspect` session silently changes
  // where THEIR debugger stops, and our own resume can restart a process they deliberately paused.
  // Sentry refuses to start in the same situation for the same reason.
  it('returns no session when an inspector is already listening', () => {
    expect(
      createInspectorSession({ inspectorUrl: () => 'ws://127.0.0.1:9229/abc' }),
    ).toBeUndefined();
  });

  it('returns a session when nothing is attached', () => {
    expect(createInspectorSession({ inspectorUrl: () => undefined })).toBeDefined();
  });

  it('treats an unreadable url probe as "something is there" rather than assuming it is safe', () => {
    // Fail CLOSED: guessing "free" attaches a second debugger to a process we know nothing about,
    // and the cost of guessing "busy" is only that locals are missing.
    expect(
      createInspectorSession({
        inspectorUrl: () => {
          throw new Error('nope');
        },
      }),
    ).toBeUndefined();
  });
});

describe('createInspectorSession', () => {
  it('returns a usable session on a runtime that has node:inspector', () => {
    // Loaded lazily rather than by static import, because @bugsee/node's composition is reused verbatim
    // by the Bun and Deno tiers and a missing module must not break package load for a feature that is
    // off by default.
    const session = createInspectorSession();
    expect(session).toBeDefined();
    expect(typeof session?.connect).toBe('function');
    expect(typeof session?.post).toBe('function');
  });
});

describe('createFrameEnricher', () => {
  it('composes lookup + attach into the shape core asks for', () => {
    const enrich = createFrameEnricher({
      lookup: (error) => ((error as Error).message === 'match' ? [{ a: '1' }] : undefined),
      captureReportSite: () => {},
      takeReportSite: () => undefined,
      stop: () => {},
    });
    expect(enrich(new Error('match'), [{ file: 'a.js', line: 1 }])).toEqual([
      { file: 'a.js', line: 1, variables: { a: '1' } },
    ]);
  });

  it('returns the frames untouched for an error it has nothing for', () => {
    const enrich = createFrameEnricher({
      lookup: () => undefined,
      captureReportSite: () => {},
      takeReportSite: () => undefined,
      stop: () => {},
    });
    const frames = [{ file: 'a.js', line: 1 }];
    expect(enrich(new Error('other'), frames)).toBe(frames);
  });
});

describe('createLocalVariablesCapture — rate limiting caught exceptions', () => {
  /** A clock whose monotonic time only moves when a test moves it. */
  function fakeClock() {
    let now = 0;
    return {
      clock: { wallNow: () => 1_000 + now, monotonicNow: () => now },
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  /** A scheduler whose intervals only fire when a test fires them. */
  function fakeScheduler() {
    const timers = new Map<number, () => void>();
    let next = 0;
    return {
      scheduler: {
        setInterval: (callback: () => void) => {
          next += 1;
          timers.set(next, callback);
          return next;
        },
        clearInterval: (handle: unknown) => {
          timers.delete(handle as number);
        },
      },
      live: () => timers.size,
      tick: () => {
        for (const run of [...timers.values()]) run();
      },
    };
  }

  const pause = { callFrames: [{ scopeChain: [] }], data: { objectId: 't' } };

  /** Fire `count` exception pauses through the capture. */
  const storm = (f: ReturnType<typeof fakeSession>, count: number) => {
    for (let i = 0; i < count; i += 1) f.fire(pause);
  };

  const states = (f: ReturnType<typeof fakeSession>) =>
    f.posts
      .filter((p) => p.method === 'Debugger.setPauseOnExceptions')
      .map((p) => (p.params as { state: string }).state);

  it('does not rate-limit at all when only uncaught exceptions are captured', () => {
    // An uncaught exception happens once, at the end of a process. Rate-limiting it could only ever
    // throw away the one crash the feature exists to explain.
    const f = fakeSession();
    const s = fakeScheduler();
    const c = fakeClock();
    createLocalVariablesCapture({
      session: f.session,
      maxCaughtPerSecond: 2,
      clock: c.clock,
      scheduler: s.scheduler,
    });
    storm(f, 50);
    expect(states(f)).toEqual(['uncaught']); // the initial arming post, and nothing since
    expect(s.live()).toBe(0);
  });

  it('keeps pausing while the app throws under the limit', () => {
    const f = fakeSession();
    const s = fakeScheduler();
    const c = fakeClock();
    createLocalVariablesCapture({
      session: f.session,
      includeCaught: true,
      maxCaughtPerSecond: 10,
      clock: c.clock,
      scheduler: s.scheduler,
    });
    storm(f, 10);
    expect(states(f)).toEqual(['all']);
    expect(s.live()).toBe(0);
  });

  it('drops to uncaught-only once the app throws past the limit', () => {
    const f = fakeSession();
    const s = fakeScheduler();
    const c = fakeClock();
    createLocalVariablesCapture({
      session: f.session,
      includeCaught: true,
      maxCaughtPerSecond: 3,
      clock: c.clock,
      scheduler: s.scheduler,
    });
    storm(f, 4);
    expect(states(f)).toEqual(['all', 'uncaught']);
  });

  it('degrades ONCE per storm, however long the storm runs', () => {
    const f = fakeSession();
    const s = fakeScheduler();
    const c = fakeClock();
    createLocalVariablesCapture({
      session: f.session,
      includeCaught: true,
      maxCaughtPerSecond: 3,
      clock: c.clock,
      scheduler: s.scheduler,
    });
    storm(f, 500);
    expect(states(f)).toEqual(['all', 'uncaught']);
    expect(s.live()).toBe(1);
  });

  it('still captures the locals of the exception that tripped the limit', () => {
    // The process has already paid for that pause; throwing its locals away would waste it.
    const f = fakeSession({ s: [{ name: 'orderId', value: { type: 'string', value: 'ord_1' } }] });
    const s = fakeScheduler();
    const c = fakeClock();
    const capture = createLocalVariablesCapture({
      session: f.session,
      includeCaught: true,
      maxCaughtPerSecond: 1,
      clock: c.clock,
      scheduler: s.scheduler,
    });
    f.fire({ callFrames: [{ scopeChain: [f.scope('s')] }], data: { objectId: 't1' } });
    f.fire({ callFrames: [{ scopeChain: [f.scope('s')] }], data: { objectId: 't2' } });
    expect(states(f)).toEqual(['all', 'uncaught']);
    const stamps = f.posts.filter((p) => p.method === 'Runtime.callFunctionOn');
    expect(stamps).toHaveLength(2);
    const id = /value:'([^']+)'/.exec(
      String((stamps[1]?.params as { functionDeclaration: string }).functionDeclaration),
    )?.[1] as string;
    expect(
      capture.lookup(
        Object.defineProperty(new Error('x'), '__bugsee_locals_id__', { value: id }),
      )?.[0],
    ).toEqual({ orderId: 'ord_1' });
  });

  it('restores caught-exception capture once the backoff has elapsed, and stops ticking', () => {
    const f = fakeSession();
    const s = fakeScheduler();
    const c = fakeClock();
    createLocalVariablesCapture({
      session: f.session,
      includeCaught: true,
      maxCaughtPerSecond: 1,
      clock: c.clock,
      scheduler: s.scheduler,
    });
    storm(f, 2);
    c.advance(4_999);
    s.tick();
    expect(states(f)).toEqual(['all', 'uncaught']); // not yet
    c.advance(1);
    s.tick();
    expect(states(f)).toEqual(['all', 'uncaught', 'all']);
    expect(s.live()).toBe(0); // no timer left running once it has recovered
  });

  it('backs off exponentially when the storm returns immediately', () => {
    const f = fakeSession();
    const s = fakeScheduler();
    const c = fakeClock();
    createLocalVariablesCapture({
      session: f.session,
      includeCaught: true,
      maxCaughtPerSecond: 1,
      clock: c.clock,
      scheduler: s.scheduler,
    });
    storm(f, 2); // trip 1 → 5s
    c.advance(5_000);
    s.tick();
    storm(f, 2); // trip 2 → 10s
    c.advance(5_000);
    s.tick();
    expect(states(f)).toEqual(['all', 'uncaught', 'all', 'uncaught']); // still held at 5s
    c.advance(5_000);
    s.tick();
    expect(states(f)).toEqual(['all', 'uncaught', 'all', 'uncaught', 'all']);
  });

  it('resets the backoff when the next storm is a NEW one, an age later', () => {
    // Without this an app with one burst every few minutes escalates to the day-long ceiling and never
    // captures a caught exception again — Sentry's limiter has exactly that ratchet.
    const f = fakeSession();
    const s = fakeScheduler();
    const c = fakeClock();
    createLocalVariablesCapture({
      session: f.session,
      includeCaught: true,
      maxCaughtPerSecond: 1,
      clock: c.clock,
      scheduler: s.scheduler,
    });
    storm(f, 2); // trip 1 → 5s
    c.advance(5_000);
    s.tick(); // restored
    c.advance(60_000); // a quiet minute
    storm(f, 2); // a NEW storm → base backoff again, not 10s
    c.advance(5_000);
    s.tick();
    expect(states(f)).toEqual(['all', 'uncaught', 'all', 'uncaught', 'all']);
  });

  it('caps the backoff at a day however many times the storm returns', () => {
    const f = fakeSession();
    const s = fakeScheduler();
    const c = fakeClock();
    createLocalVariablesCapture({
      session: f.session,
      includeCaught: true,
      maxCaughtPerSecond: 1,
      clock: c.clock,
      scheduler: s.scheduler,
    });
    let held = 5_000;
    for (let trip = 0; trip < 20; trip += 1) {
      storm(f, 2);
      c.advance(held);
      s.tick();
      held = Math.min(held * 2, 86_400_000);
    }
    // 20 doublings from 5s would be 58 days; the cap is what makes the last few restore on schedule.
    expect(states(f).filter((state) => state === 'all')).toHaveLength(21);
  });

  it('clears a pending backoff timer on stop', () => {
    const f = fakeSession();
    const s = fakeScheduler();
    const c = fakeClock();
    const capture = createLocalVariablesCapture({
      session: f.session,
      includeCaught: true,
      maxCaughtPerSecond: 1,
      clock: c.clock,
      scheduler: s.scheduler,
    });
    storm(f, 2);
    expect(s.live()).toBe(1);
    capture.stop();
    expect(s.live()).toBe(0);
  });

  it('degrades to inert, rather than throwing out of launch, on a nonsense rate', () => {
    const onError = vi.fn();
    const f = fakeSession();
    const capture = createLocalVariablesCapture({
      session: f.session,
      includeCaught: true,
      maxCaughtPerSecond: 0,
      onError,
    });
    expect(onError).toHaveBeenCalledWith(expect.any(RangeError));
    expect(capture.lookup(new Error('x'))).toBeUndefined();
  });
});

describe('alignReportSite', () => {
  // The report site is the CATCH block, so the live stack there overlaps the thrown error's stack from
  // the catching function downwards. What can be matched across that overlap is FUNCTION NAMES and
  // nothing else — measured on Node 24 under tsx: the debugger reports TRANSPILED positions
  // (`lineNumber: 0, columnNumber: 602` for a whole file on one line) while `Error.stack` has already
  // been rewritten by source maps back to the original. Any application with source maps — which is
  // most of them — therefore has two irreconcilable vocabularies for `file` and `line`, and only the
  // function name survives both.
  const frame = (fn: string | undefined): StackFrame =>
    fn === undefined ? { file: './src/x.js' } : { function: fn, file: './src/x.js' };
  const live = (fn: string, locals: Record<string, string>) => ({
    function: fn,
    file: './dist/bundle.js',
    locals,
  });

  it('anchors on the longest run of matching frames and attaches from there down', () => {
    const result = alignReportSite(
      [live('checkout', { orderId: 'ord_1' }), live('handler', { req: 'Object' })],
      [frame('risky'), frame('checkout'), frame('handler')],
    );
    expect(result[0]?.variables).toBeUndefined(); // above the catch — not knowable from the report site
    expect(result[1]?.variables).toEqual({ orderId: 'ord_1' });
    expect(result[2]?.variables).toEqual({ req: 'Object' });
  });

  it('matches across a bundle boundary, where neither file nor line can agree', () => {
    // The live frames say `./dist/bundle.js`; the error's frames say `./src/checkout.ts`. Requiring
    // either to agree would switch this feature off for every application that ships source maps.
    const result = alignReportSite(
      [live('checkout', { orderId: 'ord_1' }), live('handler', { req: 'Object' })],
      [
        { function: 'checkout', file: './src/checkout.ts', line: 9 },
        { function: 'handler', file: './src/api.ts', line: 4 },
      ],
    );
    expect(result[0]?.variables).toEqual({ orderId: 'ord_1' });
  });

  it('accepts V8’s receiver-qualified name against the debugger’s bare one', () => {
    // `ModuleJob.run` in a stack string is `run` in a call frame. Measured, on the real bottom frames of
    // a real report-site pause.
    const result = alignReportSite(
      [live('checkout', { a: '1' }), live('run', { b: '2' })],
      [frame('checkout'), frame('ModuleJob.run')],
    );
    expect(result[1]?.variables).toEqual({ b: '2' });
  });

  it('treats the two vocabularies for an anonymous frame as the same frame', () => {
    // A module top level is `Object.<anonymous>` in a stack string and `''` in a call frame.
    const result = alignReportSite(
      [live('main', { a: '1' }), live('', { config: 'Object' })],
      [frame('main'), frame('Object.<anonymous>')],
    );
    expect(result[1]?.variables).toEqual({ config: 'Object' });
  });

  it('attaches NOTHING when nothing corresponds', () => {
    // An error thrown in an earlier tick and reported from an unrelated callback. Stamping this scope
    // onto those frames would be a confident lie, which is worse than the absence it replaces.
    const frames = [frame('load'), frame('tick')];
    expect(alignReportSite([live('respond', { status: '500' })], frames)).toBe(frames);
  });

  it('refuses a run of one — a single name in common is a coincidence, not an alignment', () => {
    const frames = [frame('checkout'), frame('somethingElse')];
    expect(alignReportSite([live('checkout', { a: '1' }), live('other', { b: '2' })], frames)).toBe(
      frames,
    );
  });

  it('stops at the first frame that stops corresponding', () => {
    const result = alignReportSite(
      [live('checkout', { a: '1' }), live('handler', { b: '2' }), live('elsewhere', { c: '3' })],
      [frame('checkout'), frame('handler'), frame('serve')],
    );
    expect(result[1]?.variables).toEqual({ b: '2' });
    expect(result[2]?.variables).toBeUndefined();
  });

  it('prefers the longest run when a name repeats', () => {
    const result = alignReportSite(
      [
        live('retry', { at: 'live-0' }),
        live('retry', { at: 'live-1' }),
        live('root', { at: 'live-2' }),
      ],
      [frame('retry'), frame('retry'), frame('root')],
    );
    expect(result.map((f) => f.variables?.at)).toEqual(['live-0', 'live-1', 'live-2']);
  });

  it('takes the LONGEST run, not the first one it finds', () => {
    // A short coincidental match near the top would otherwise win over the real overlap further down,
    // and every scope would land two frames from where it belongs.
    const result = alignReportSite(
      [
        live('a', { n: '0' }),
        live('b', { n: '1' }),
        live('p', { n: '2' }),
        live('q', { n: '3' }),
        live('r', { n: '4' }),
      ],
      [frame('a'), frame('b'), frame('z'), frame('p'), frame('q'), frame('r')],
    );
    expect(result.map((f) => f.variables?.n)).toEqual([
      undefined,
      undefined,
      undefined,
      '2',
      '3',
      '4',
    ]);
  });

  it('never overwrites locals already captured at the THROW site', () => {
    // Those are strictly better: the scope as it was when the value was thrown, not as it is several
    // frames and some unwinding later.
    const frames = [
      { ...frame('checkout'), variables: { at: 'throw' } },
      { ...frame('handler'), variables: { at: 'throw' } },
    ];
    const result = alignReportSite(
      [live('checkout', { at: 'report' }), live('handler', { at: 'report' })],
      frames,
    );
    expect(result[0]?.variables).toEqual({ at: 'throw' });
  });

  it('leaves a frame alone when the live scope was empty', () => {
    const result = alignReportSite(
      [live('checkout', {}), live('handler', { b: '2' })],
      [frame('checkout'), frame('handler')],
    );
    expect(result[0]?.variables).toBeUndefined();
    expect(result[1]?.variables).toEqual({ b: '2' });
  });

  it('returns the same array when there is no live capture to attach', () => {
    const frames = [frame('checkout')];
    expect(alignReportSite([], frames)).toBe(frames);
  });
});

interface LiveFrame {
  fn: string;
  scriptId: string;
  line: number;
  scope?: string;
}

/** A `Debugger.paused` payload, in the shape the real inspector sends (0-based line, no `url`). */
const paused = (frames: readonly LiveFrame[], reason = 'other') => ({
  reason,
  callFrames: frames.map((f) => ({
    functionName: f.fn,
    location: { scriptId: f.scriptId, lineNumber: f.line - 1, columnNumber: 0 },
    scopeChain: f.scope === undefined ? [] : [{ type: 'local', object: { objectId: f.scope } }],
  })),
});

/**
 * A session that answers `Debugger.pause` by dispatching a pause SYNCHRONOUSLY, inside the very post
 * that asked for it — measured on Node 24, and the property the whole feature rests on.
 */
function reportSiteSession(
  properties: Record<string, readonly unknown[]> = {},
  options: Partial<LocalVariablesOptions> = {},
  throwOn: readonly string[] = [],
  propertiesError = false,
) {
  let pauseParams: unknown;
  const posts: Array<{ method: string; params?: unknown }> = [];
  let onPaused: ((m: { params: unknown }) => void) | undefined;
  let onParsed: ((m: { params: unknown }) => void) | undefined;
  const session: InspectorSessionLike = {
    connect: () => {},
    disconnect: () => {},
    post: (method, params, callback) => {
      posts.push({ method, params });
      if (throwOn.includes(method)) throw new Error(`${method} failed`);
      if (method === 'Debugger.pause' && pauseParams !== undefined) {
        onPaused?.({ params: pauseParams });
      }
      if (method === 'Runtime.getProperties' && callback !== undefined) {
        if (propertiesError) {
          callback(new Error('detached'));
          return;
        }
        callback(null, { result: properties[(params as { objectId: string }).objectId] ?? [] });
      }
    },
    on: (event, handler) => {
      if (event === 'Debugger.paused') onPaused = handler;
      if (event === 'Debugger.scriptParsed') onParsed = handler;
    },
  };
  const capture = createLocalVariablesCapture({ session, ...options });
  return {
    capture,
    posts,
    session,
    methods: () => posts.map((p) => p.method),
    parse: (scriptId: string, url: string) => onParsed?.({ params: { scriptId, url } }),
    fire: (params: unknown) => onPaused?.({ params }),
    /** What the next `Debugger.pause` will report. */
    pauseWith: (frames: readonly LiveFrame[]) => {
      pauseParams = paused(frames);
    },
    /** As {@link pauseWith}, but with the payload given verbatim (to forge a different `reason`). */
    pauseWithRaw: (params: unknown) => {
      pauseParams = params;
    },
  };
}

describe('createLocalVariablesCapture — report-site capture', () => {
  it('listens for scriptParsed BEFORE enabling the debugger', () => {
    // `Debugger.enable` REPLAYS a scriptParsed for every script already parsed, synchronously, inside
    // that very post. Registering the listener afterwards therefore misses the entire program — which is
    // every script that matters, since the application was loaded before the SDK launched. The symptom
    // is not an error: report-site capture simply returns nothing, for ever.
    const order: string[] = [];
    const session: InspectorSessionLike = {
      connect: () => order.push('connect'),
      disconnect: () => {},
      post: (method) => order.push(`post:${method}`),
      on: (event) => order.push(`on:${event}`),
    };
    createLocalVariablesCapture({ session });
    expect(order.indexOf('on:Debugger.scriptParsed')).toBeGreaterThan(order.indexOf('connect'));
    expect(order.indexOf('on:Debugger.scriptParsed')).toBeLessThan(
      order.indexOf('post:Debugger.enable'),
    );
  });

  it('pauses the process on demand and reads the scope the report was made from', () => {
    const f = fakeSession({ s0: [{ name: 'orderId', value: { type: 'string', value: 'ord_1' } }] });
    const capture = createLocalVariablesCapture({ session: f.session });
    f.parse('1', 'file:///app/src/checkout.js');
    const err = new Error('boom');
    f.session.post = ((method: string, params?: unknown, cb?: unknown) => {
      (f.posts as Array<{ method: string; params?: unknown }>).push({ method, params });
      if (method === 'Debugger.pause') {
        // The real session dispatches the pause synchronously, inside this very call — measured on
        // Node 24. It is the whole reason a report-site capture is possible at all.
        f.fire(paused([{ fn: 'checkout', scriptId: '1', line: 21, scope: 's0' }]));
      }
      if (method === 'Runtime.getProperties') {
        (cb as (e: null, r: unknown) => void)(null, {
          result: [{ name: 'orderId', value: { type: 'string', value: 'ord_1' } }],
        });
      }
    }) as InspectorSessionLike['post'];
    capture.captureReportSite(err);
    expect(f.methods()).toContain('Debugger.pause');
    expect(f.methods()).toContain('Debugger.resume'); // never leave the app stopped
    const frames = capture.takeReportSite(err);
    expect(frames).toEqual([
      {
        function: 'checkout',
        file: '/app/src/checkout.js',
        line: 21,
        column: 1,
        locals: { orderId: 'ord_1' }, // a top-level string renders bare; quoting is a preview rule
      },
    ]);
  });

  it('skips the SDK’s own frames and the runtime’s, which sit above the application every time', () => {
    const f = reportSiteSession({
      s1: [{ name: 'orderId', value: { type: 'string', value: 'ord_1' } }],
    });
    f.parse('9', 'file:///app/node_modules/@bugsee/core/dist/index.js');
    f.parse('8', 'node:internal/process/task_queues');
    f.parse('1', 'file:///app/src/checkout.js');
    const err = new Error('boom');
    f.pauseWith([
      { fn: 'logException', scriptId: '9', line: 700, scope: 's9' },
      { fn: 'processTicks', scriptId: '8', line: 95, scope: 's8' },
      { fn: 'checkout', scriptId: '1', line: 21, scope: 's1' },
    ]);
    f.capture.captureReportSite(err);
    expect(f.capture.takeReportSite(err)?.map((frame) => frame.function)).toEqual(['checkout']);
    // and it never even asked for the scopes it was going to discard
    expect(
      f.posts
        .filter((p) => p.method === 'Runtime.getProperties')
        .map((p) => (p.params as { objectId: string }).objectId),
    ).toEqual(['s1']);
  });

  it('honours maxFrames over the application frames that remain', () => {
    const f = reportSiteSession({}, { maxFrames: 2 });
    f.parse('1', 'file:///app/src/a.js');
    const err = new Error('boom');
    f.pauseWith([
      { fn: 'one', scriptId: '1', line: 1, scope: 'x' },
      { fn: 'two', scriptId: '1', line: 2, scope: 'x' },
      { fn: 'three', scriptId: '1', line: 3, scope: 'x' },
    ]);
    f.capture.captureReportSite(err);
    expect(f.capture.takeReportSite(err)).toHaveLength(2);
  });

  it('is consumed once — a second read gets nothing', () => {
    // Otherwise a later UNCAUGHT crash of the same object would be stamped with a scope captured back
    // when it was merely logged, which describes a moment that has long passed.
    const f = reportSiteSession({ s1: [{ name: 'a', value: { type: 'number', value: 1 } }] });
    f.parse('1', 'file:///app/src/a.js');
    const err = new Error('boom');
    f.pauseWith([{ fn: 'checkout', scriptId: '1', line: 21, scope: 's1' }]);
    f.capture.captureReportSite(err);
    expect(f.capture.takeReportSite(err)).toBeDefined();
    expect(f.capture.takeReportSite(err)).toBeUndefined();
  });

  it('hands the capture only to the value it was taken for', () => {
    const f = reportSiteSession({ s1: [{ name: 'a', value: { type: 'number', value: 1 } }] });
    f.parse('1', 'file:///app/src/a.js');
    const err = new Error('boom');
    f.pauseWith([{ fn: 'checkout', scriptId: '1', line: 21, scope: 's1' }]);
    f.capture.captureReportSite(err);
    expect(f.capture.takeReportSite(new Error('other'))).toBeUndefined();
  });

  it('does not pause a stopped capture', () => {
    const f = reportSiteSession({});
    f.capture.stop();
    const before = f.posts.length;
    f.capture.captureReportSite(new Error('boom'));
    expect(f.posts.slice(before).map((p) => p.method)).not.toContain('Debugger.pause');
  });

  it('can be switched off while throw-site capture stays on', () => {
    const f = reportSiteSession({}, { reportSite: false });
    f.capture.captureReportSite(new Error('boom'));
    expect(f.methods()).not.toContain('Debugger.pause');
  });

  it('reports a failure to pause instead of throwing into the caller’s catch block', () => {
    const onError = vi.fn();
    const f = reportSiteSession({}, { onError }, ['Debugger.pause']);
    expect(() => f.capture.captureReportSite(new Error('boom'))).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('still takes the THROW-site path for a real exception pause', () => {
    // The two pauses arrive through the same listener and are told apart by `reason`. Mixing them up
    // would stamp a thrown object with a scope that has nothing to do with it.
    const f = reportSiteSession({ s1: [{ name: 'a', value: { type: 'number', value: 1 } }] });
    f.parse('1', 'file:///app/src/a.js');
    f.fire({
      ...paused([{ fn: 'checkout', scriptId: '1', line: 21, scope: 's1' }], 'exception'),
      data: { objectId: 'thrown-1' },
    });
    expect(f.methods()).toContain('Runtime.callFunctionOn'); // stamped, i.e. the throw-site path
    expect(f.capture.takeReportSite(new Error('x'))).toBeUndefined();
  });

  it('resumes and captures nothing when the pause reports no frames at all', () => {
    const f = reportSiteSession({});
    const err = new Error('boom');
    f.pauseWith([]);
    f.capture.captureReportSite(err);
    expect(f.capture.takeReportSite(err)).toBeUndefined();
    expect(f.methods()).toContain('Debugger.resume');
  });

  it('keeps the frame, without its scope, when the runtime refuses to describe it', () => {
    // The frame still carries its NAME, which is what alignment matches on — dropping it would shift
    // every frame below it onto the wrong scope, to avoid reporting one empty one.
    const onError = vi.fn();
    const f = reportSiteSession({}, { onError }, [], true);
    f.parse('1', 'file:///app/src/a.js');
    const err = new Error('boom');
    f.pauseWith([
      { fn: 'checkout', scriptId: '1', line: 21, scope: 's1' },
      { fn: 'handler', scriptId: '1', line: 40, scope: 's2' },
    ]);
    f.capture.captureReportSite(err);
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(f.capture.takeReportSite(err)).toEqual([
      { function: 'checkout', file: '/app/src/a.js', line: 21, column: 1, locals: {} },
      { function: 'handler', file: '/app/src/a.js', line: 40, column: 1, locals: {} },
    ]);
    expect(f.methods()).toContain('Debugger.resume');
  });

  it('reports a THROWING inspector at the report site and still resumes', () => {
    const onError = vi.fn();
    const f = reportSiteSession({}, { onError }, ['Runtime.getProperties']);
    f.parse('1', 'file:///app/src/a.js');
    const err = new Error('boom');
    f.pauseWith([{ fn: 'checkout', scriptId: '1', line: 21, scope: 's1' }]);
    expect(() => f.capture.captureReportSite(err)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(f.methods()).toContain('Debugger.resume'); // never leave the application stopped
  });

  it('does not mistake an exception that lands DURING the capture window for the report site', () => {
    // With `includeCaught` on, any throw between asking for the pause and getting it arrives through
    // this same listener. Telling them apart by `awaitingReportSite` alone is not enough: that flag is
    // set at exactly the moment such a throw is most likely, and reading the exception's stack as the
    // report site would both capture the wrong frames AND skip stamping the thrown object, losing the
    // throw-site locals entirely.
    const f = reportSiteSession({ s1: [{ name: 'a', value: { type: 'number', value: 1 } }] });
    f.parse('1', 'file:///app/src/a.js');
    const err = new Error('boom');
    f.pauseWithRaw({
      ...paused([{ fn: 'somethingElse', scriptId: '1', line: 3, scope: 's1' }], 'exception'),
      data: { objectId: 'thrown-1' },
    });
    f.capture.captureReportSite(err);
    expect(f.methods()).toContain('Runtime.callFunctionOn'); // the throw-site path ran
    expect(f.capture.takeReportSite(err)).toBeUndefined(); // and nothing was taken for the report
  });

  it('captures a frame with no local scope as a named, empty one', () => {
    // A frame the runtime reports no local scope for (a native or fully-optimised one) still holds its
    // POSITION in the stack. Recording it empty is what keeps the frames below it aligned.
    const f = reportSiteSession({ s1: [{ name: 'a', value: { type: 'number', value: 1 } }] });
    f.parse('1', 'file:///app/src/a.js');
    const err = new Error('boom');
    f.pauseWith([
      { fn: 'native', scriptId: '1', line: 2 }, // no scopeChain at all
      { fn: 'checkout', scriptId: '1', line: 21, scope: 's1' },
    ]);
    f.capture.captureReportSite(err);
    const frames = f.capture.takeReportSite(err);
    expect(frames?.map((frame) => frame.locals)).toEqual([{}, { a: '1' }]);
  });

  it('ignores a pause it did not ask for', () => {
    // Another debugger's `Debugger.pause`. We refuse to attach when one is already present, so this
    // should not happen — but consuming it would attribute a stranger's stack to our next report.
    const f = reportSiteSession({ s1: [{ name: 'a', value: { type: 'number', value: 1 } }] });
    f.parse('1', 'file:///app/src/a.js');
    const err = new Error('boom');
    f.fire(paused([{ fn: 'checkout', scriptId: '1', line: 21, scope: 's1' }]));
    expect(f.capture.takeReportSite(err)).toBeUndefined();
    expect(f.methods()).toContain('Debugger.resume'); // and it is still resumed
  });

  it('KEEPS a frame whose script it never saw announced, rather than shifting every frame below it', () => {
    // The captured array is matched positionally against the error's stack. Dropping an entry would
    // move every frame beneath it up one and attach each scope to its caller — silently, and wrongly.
    const f = reportSiteSession({ s1: [{ name: 'a', value: { type: 'number', value: 1 } }] });
    f.parse('1', 'file:///app/src/a.js');
    const err = new Error('boom');
    f.pauseWith([
      { fn: 'mystery', scriptId: 'never-parsed', line: 1, scope: 's0' },
      { fn: 'checkout', scriptId: '1', line: 21, scope: 's1' },
    ]);
    f.capture.captureReportSite(err);
    const frames = f.capture.takeReportSite(err);
    expect(frames?.map((frame) => frame.function)).toEqual(['mystery', 'checkout']);
    expect(frames?.[0]?.file).toBeUndefined(); // unlocatable, and honest about it
    expect(frames?.[1]?.locals).toEqual({ a: '1' });
  });
});

describe('createFrameEnricher — the two captures composed', () => {
  it('fills the report site in around the throw site, without displacing it', () => {
    // Both can be live at once (`includeCaught` plus a `logException` in the catch block). The throw
    // site wins wherever they overlap; the report site reaches the frames below it, which the throw-site
    // capture stops short of once `maxFrames` runs out.
    const err = new Error('boom');
    const capture: LocalVariablesCapture = {
      lookup: (value) => (value === err ? [{ at: 'throw' }] : undefined),
      captureReportSite: () => {},
      takeReportSite: (value): ReportSiteFrame[] | undefined =>
        value === err
          ? [
              {
                function: 'checkout',
                file: './src/checkout.js',
                line: 21,
                locals: { at: 'report' },
              },
              { function: 'handler', file: './src/api.js', line: 4, locals: { req: 'Object' } },
            ]
          : undefined,
      stop: () => {},
    };
    const enrich = createFrameEnricher(capture);
    const result = enrich(err, [
      { function: 'checkout', file: './src/checkout.js', line: 9 },
      { function: 'handler', file: './src/api.js', line: 4 },
    ]);
    expect(result[0]?.variables).toEqual({ at: 'throw' }); // throw site kept
    expect(result[1]?.variables).toEqual({ req: 'Object' }); // report site filled in below it
  });

  it('is a no-op when neither capture has anything for this value', () => {
    const capture: LocalVariablesCapture = {
      lookup: () => undefined,
      captureReportSite: () => {},
      takeReportSite: () => undefined,
      stop: () => {},
    };
    const frames = [{ function: 'checkout', file: './src/checkout.js', line: 9 }];
    expect(createFrameEnricher(capture)(new Error('x'), frames)).toBe(frames);
  });
});

describe('createLocalVariablesCapture — the inert capture', () => {
  it('answers every method safely when there is no session to attach to', () => {
    // Returned on every degradation path (no inspector, a refused session, another debugger present).
    // It is what runs on a runtime that cannot support the feature, so every method must be callable.
    const capture = createLocalVariablesCapture();
    const err = new Error('boom');
    expect(() => capture.captureReportSite(err)).not.toThrow();
    expect(capture.takeReportSite(err)).toBeUndefined();
    expect(capture.lookup(err)).toBeUndefined();
    expect(() => capture.stop()).not.toThrow();
  });
});

describe('createLocalVariablesCapture — the default scheduler', () => {
  it('recovers on real timers, and unrefs them so a CLI can still exit', () => {
    // The throttle's recovery tick is the only timer this feature owns. Left ref'd it would hold a
    // short-lived process open for the whole backoff — up to a day — which is a far worse bug than the
    // one the throttle exists to prevent.
    const unref = vi.fn();
    const setInterval = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof globalThis.setInterval>);
    const clearInterval = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
    try {
      const f = fakeSession();
      const capture = createLocalVariablesCapture({
        session: f.session,
        includeCaught: true,
        maxCaughtPerSecond: 1,
      }); // no scheduler injected — the real one
      f.fire({ callFrames: [{ scopeChain: [] }], data: { objectId: 'a' } });
      f.fire({ callFrames: [{ scopeChain: [] }], data: { objectId: 'b' } });
      expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 1_000);
      expect(unref).toHaveBeenCalled();
      capture.stop();
      expect(clearInterval).toHaveBeenCalled();
    } finally {
      setInterval.mockRestore();
      clearInterval.mockRestore();
    }
  });
});

describe('createLocalVariablesCapture — a session that fails only later', () => {
  it('reports a refused throttle instead of throwing out of the pause handler', () => {
    // Arming succeeds and the throttle then cannot disarm — a session that died between the two. The
    // failure belongs in onError; throwing here would escape into whatever the application was doing
    // when it threw, and leave the process paused.
    const onError = vi.fn();
    let armed = false;
    let onPaused: ((m: { params: unknown }) => void) | undefined;
    const posts: string[] = [];
    const session: InspectorSessionLike = {
      connect: () => {},
      disconnect: () => {},
      post: (method) => {
        posts.push(method);
        if (method === 'Debugger.setPauseOnExceptions') {
          if (armed) throw new Error('session gone');
          armed = true;
        }
      },
      on: (event, handler) => {
        if (event === 'Debugger.paused') onPaused = handler;
      },
    };
    createLocalVariablesCapture({
      session,
      includeCaught: true,
      maxCaughtPerSecond: 1,
      onError,
      scheduler: { setInterval: () => 1, clearInterval: () => {} },
    });
    onPaused?.({ params: { callFrames: [], data: { objectId: 'a' } } });
    expect(() => onPaused?.({ params: { callFrames: [], data: { objectId: 'b' } } })).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(posts).toContain('Debugger.resume');
  });
});
