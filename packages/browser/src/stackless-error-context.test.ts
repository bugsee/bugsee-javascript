import { describe, expect, it } from 'vitest';
import {
  createStacklessFrameEnricher,
  describeStacklessContext,
  detectModuleLoadFailure,
  engineLocationFrame,
  IMPORT_FRAME_FUNCTION,
  type StacklessEnv,
  stacklessFrames,
  UNKNOWN_MODULE,
} from './stackless-error-context';

const ORIGIN = 'https://app.example.com';

function entry(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    initiatorType: 'script',
    startTime: 0,
    responseEnd: 900,
    transferSize: 500,
    encodedBodySize: 300,
    decodedBodySize: 900,
    ...overrides,
  };
}

const FAILED = { transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 };

function env(entries: Record<string, unknown>[], extra: Partial<StacklessEnv> = {}): StacklessEnv {
  return {
    performance: { getEntriesByType: () => entries, now: () => 1000 },
    location: {
      href: `${ORIGIN}/#/apps/9?x=1`,
      origin: ORIGIN,
      pathname: '/',
      hash: '#/apps/9?x=1',
    },
    navigator: { onLine: true },
    ...extra,
  };
}

const safari = () => new TypeError('Importing a module script failed.');

describe('detectModuleLoadFailure', () => {
  it('is undefined for an ordinary error', () => {
    expect(detectModuleLoadFailure(new Error('boom'), env([]))).toBeUndefined();
    expect(detectModuleLoadFailure('Importing a module script failed.', env([]))).toBeUndefined();
    expect(detectModuleLoadFailure(null, env([]))).toBeUndefined();
  });

  it('reads the module from Chrome and Firefox messages', () => {
    const chrome = new TypeError(
      `Failed to fetch dynamically imported module: ${ORIGIN}/chunk-AAA.js?token=secret`,
    );
    const firefox = new TypeError(
      `error loading dynamically imported module: ${ORIGIN}/chunk-BBB.js`,
    );
    expect(detectModuleLoadFailure(chrome, env([]))?.failedUrl).toContain(`${ORIGIN}/chunk-AAA.js`);
    expect(detectModuleLoadFailure(chrome, env([]))?.failedUrl).not.toContain('secret');
    expect(detectModuleLoadFailure(chrome, env([]))?.source).toBe('message');
    expect(detectModuleLoadFailure(firefox, env([]))?.failedUrl).toBe(`${ORIGIN}/chunk-BBB.js`);
  });

  it("infers Safari's nameless failure from the newest zero-size same-origin script", () => {
    const entries = [
      entry(`${ORIGIN}/main.js`),
      entry(`${ORIGIN}/chunk-OLD.js`, FAILED),
      entry(`${ORIGIN}/chunk-LAZY.js`, FAILED),
    ];
    const failure = detectModuleLoadFailure(safari(), env(entries));
    expect(failure?.failedUrl).toBe(`${ORIGIN}/chunk-LAZY.js`);
    expect(failure?.source).toBe('timing');
    expect(failure?.recentScripts).toEqual([`${ORIGIN}/main.js`]);
  });

  it('does not blame a cross-origin script, whose sizes are zero without Timing-Allow-Origin', () => {
    const failure = detectModuleLoadFailure(
      safari(),
      env([entry('https://cdn.other.com/lib.js', FAILED)]),
    );
    expect(failure?.failedUrl).toBeUndefined();
  });

  it('trusts responseStatus over sizes, for any origin', () => {
    const failure = detectModuleLoadFailure(
      safari(),
      env([entry('https://cdn.other.com/lib.js', { responseStatus: 404 })]),
    );
    expect(failure?.failedUrl).toBe('https://cdn.other.com/lib.js');
    const ok = detectModuleLoadFailure(
      safari(),
      env([entry(`${ORIGIN}/ok.js`, { ...FAILED, responseStatus: 200 })]),
    );
    expect(ok?.failedUrl).toBeUndefined();
    expect(ok?.recentScripts).toEqual([`${ORIGIN}/ok.js`]);
  });

  it('ignores a stale failed entry', () => {
    const failure = detectModuleLoadFailure(
      safari(),
      env([entry(`${ORIGIN}/old.js`, { ...FAILED, responseEnd: 1 })], {
        performance: {
          getEntriesByType: () => [entry(`${ORIGIN}/old.js`, { ...FAILED, responseEnd: 1 })],
          now: () => 600_000,
        },
      }),
    );
    expect(failure?.failedUrl).toBeUndefined();
  });

  it('survives a performance API that throws', () => {
    const throwing: StacklessEnv = {
      performance: {
        getEntriesByType: () => {
          throw new Error('nope');
        },
        now: () => {
          throw new Error('nope');
        },
      },
    };
    expect(detectModuleLoadFailure(safari(), throwing)).toEqual({ recentScripts: [] });
  });
});

describe('stacklessFrames', () => {
  it('stands a failed import in as one frame naming the module', () => {
    const frames = stacklessFrames(safari(), env([entry(`${ORIGIN}/chunk-LAZY.js`, FAILED)]));
    expect(frames).toEqual([{ function: IMPORT_FRAME_FUNCTION, file: `${ORIGIN}/chunk-LAZY.js` }]);
  });

  it('uses one fixed placeholder when the module is unknown, so occurrences group', () => {
    expect(stacklessFrames(safari(), env([]))).toEqual([
      { function: IMPORT_FRAME_FUNCTION, file: UNKNOWN_MODULE },
    ]);
  });

  it("turns JavaScriptCore's sourceURL/line/column into a frame", () => {
    const error = Object.assign(new SyntaxError('Unexpected token'), {
      sourceURL: `${ORIGIN}/chunks/x.js`,
      line: 3,
      column: 9,
    });
    expect(engineLocationFrame(error)).toMatchObject({
      file: `${ORIGIN}/chunks/x.js`,
      line: 3,
      column: 9,
    });
    expect(stacklessFrames(error, env([]))).toHaveLength(1);
  });

  it('adds nothing for an ordinary stackless error', () => {
    expect(stacklessFrames(new Error('x'), env([]))).toEqual([]);
  });
});

describe('createStacklessFrameEnricher', () => {
  const enrich = createStacklessFrameEnricher(env([entry(`${ORIGIN}/chunk-LAZY.js`, FAILED)]));

  it('leaves a real stack alone', () => {
    const real = [{ file: 'a.js', line: 1, column: 1 }];
    expect(enrich(safari(), real)).toBe(real);
  });

  it('fills an empty stack', () => {
    expect(enrich(safari(), [])).toHaveLength(1);
  });

  it('keeps an empty stack empty when there is nothing to add', () => {
    const empty: never[] = [];
    expect(enrich(new Error('x'), empty)).toBe(empty);
  });
});

describe('describeStacklessContext', () => {
  it('names the module, page, connectivity and recent scripts', () => {
    const text = describeStacklessContext(
      safari(),
      env([entry(`${ORIGIN}/main.js`), entry(`${ORIGIN}/chunk-LAZY.js`, FAILED)], {
        navigator: { onLine: false },
      }),
    );
    expect(text).toBe(
      [
        `Failed module: ${ORIGIN}/chunk-LAZY.js (inferred from resource timing)`,
        `Page: ${ORIGIN}/#/apps/9`,
        'Online: false',
        'Recently loaded scripts (newest last):',
        `  ${ORIGIN}/main.js`,
      ].join('\n'),
    );
  });

  it('says so when the browser did not name the module', () => {
    expect(describeStacklessContext(safari(), env([]))).toContain(
      'Failed module: unknown (the browser did not name it)',
    );
  });

  it('is undefined for anything that is not a failed import', () => {
    expect(describeStacklessContext(new Error('x'), env([]))).toBeUndefined();
  });
});

describe('hostile inputs never throw', () => {
  const hostile = (): unknown =>
    Object.defineProperty({}, 'message', {
      get() {
        throw new Error('getter');
      },
    });

  it('treats a same-origin responseStatus 0 as a failed fetch, a cross-origin one as unknown (an opaque success reports it too)', () => {
    const same = detectModuleLoadFailure(
      safari(),
      env([entry(`${ORIGIN}/lazy.js`, { responseStatus: 0, transferSize: 10 })]),
    );
    expect(same?.failedUrl).toBe(`${ORIGIN}/lazy.js`);
    const cross = detectModuleLoadFailure(
      safari(),
      env([entry('https://cdn.other.com/lib.js', { responseStatus: 0 })]),
    );
    expect(cross?.failedUrl).toBeUndefined();
    expect(cross?.recentScripts).toEqual(['https://cdn.other.com/lib.js']);
  });

  it('still trusts an explicit 4xx from another origin', () => {
    const failure = detectModuleLoadFailure(
      safari(),
      env([entry('https://cdn.other.com/gone.js', { responseStatus: 404 })]),
    );
    expect(failure?.failedUrl).toBe('https://cdn.other.com/gone.js');
  });

  it('names the failure that ended last, not the request that started last', () => {
    const failure = detectModuleLoadFailure(
      safari(),
      env([
        entry(`${ORIGIN}/a.js`, { ...FAILED, startTime: 0, responseEnd: 990 }),
        entry(`${ORIGIN}/b.js`, { ...FAILED, startTime: 100, responseEnd: 200 }),
      ]),
    );
    expect(failure?.failedUrl).toBe(`${ORIGIN}/a.js`);
  });

  it('does not name a failure older than ten seconds', () => {
    const failure = detectModuleLoadFailure(
      safari(),
      env([entry(`${ORIGIN}/old.js`, { ...FAILED, responseEnd: 1 })], {
        performance: {
          getEntriesByType: () => [entry(`${ORIGIN}/old.js`, { ...FAILED, responseEnd: 1 })],
          now: () => 20_000,
        },
      }),
    );
    expect(failure?.failedUrl).toBeUndefined();
  });

  it('keeps a hash route but never a fragment that carries a credential', () => {
    const at = (hash: string) =>
      describeStacklessContext(
        safari(),
        env([], {
          location: { href: '', origin: ORIGIN, pathname: '/auth/callback', hash },
        }),
      );
    expect(at('#/apps/9')).toContain(`Page: ${ORIGIN}/auth/callback#/apps/9`);
    const leaked = at('#access_token=eyJSECRET&refresh_token=r&token_type=bearer');
    expect(leaked).toContain(`Page: ${ORIGIN}/auth/callback`);
    expect(leaked).not.toContain('SECRET');
    expect(leaked).not.toContain('access_token');
  });

  it('survives global getters that throw while the environment is acquired', () => {
    const keys = ['performance', 'location', 'navigator'] as const;
    const saved = keys.map((k) => Object.getOwnPropertyDescriptor(globalThis, k));
    try {
      for (const k of keys) {
        Object.defineProperty(globalThis, k, {
          configurable: true,
          get() {
            throw new Error('hostile');
          },
        });
      }
      expect(() => stacklessFrames(safari())).not.toThrow();
      expect(describeStacklessContext(safari())).toContain('Failed module: unknown');
    } finally {
      keys.forEach((k, i) => {
        const descriptor = saved[i];
        if (descriptor === undefined) Reflect.deleteProperty(globalThis, k);
        else Object.defineProperty(globalThis, k, descriptor);
      });
    }
  });

  it('survives a message getter that throws', () => {
    expect(stacklessFrames(hostile(), env([]))).toEqual([]);
    expect(describeStacklessContext(hostile(), env([]))).toBeUndefined();
  });

  it('leaves the page out when location cannot be read', () => {
    const location = Object.defineProperty({ href: '', origin: ORIGIN, pathname: '/' }, 'hash', {
      get() {
        throw new Error('getter');
      },
    }) as StacklessEnv['location'];
    const text = describeStacklessContext(safari(), env([], { location }));
    expect(text).toContain('Failed module: unknown');
    expect(text).not.toContain('Page:');
  });
});
