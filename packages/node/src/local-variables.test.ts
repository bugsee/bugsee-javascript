import { REDACTED } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  attachLocals,
  collectScope,
  createFrameEnricher,
  createInspectorSession,
  createLocalVariablesCapture,
  type InspectorSessionLike,
  renderValue,
} from './local-variables';

/** A fake inspector session: records posts, answers `Runtime.getProperties` from a script. */
function fakeSession(properties: Record<string, readonly unknown[]> = {}) {
  const posts: Array<{ method: string; params?: unknown }> = [];
  let paused: ((message: { params: unknown }) => void) | undefined;
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
    }),
  };
  const scope = (objectId: string) => ({ type: 'local', object: { objectId } });
  return {
    session,
    posts,
    methods: () => posts.map((p) => p.method),
    fire: (params: unknown) => paused?.({ params }),
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
    expect(createInspectorSession({ inspectorUrl: () => 'ws://127.0.0.1:9229/abc' })).toBeUndefined();
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
      stop: () => {},
    });
    expect(enrich(new Error('match'), [{ file: 'a.js', line: 1 }])).toEqual([
      { file: 'a.js', line: 1, variables: { a: '1' } },
    ]);
  });

  it('returns the frames untouched for an error it has nothing for', () => {
    const enrich = createFrameEnricher({ lookup: () => undefined, stop: () => {} });
    const frames = [{ file: 'a.js', line: 1 }];
    expect(enrich(new Error('other'), frames)).toBe(frames);
  });
});
