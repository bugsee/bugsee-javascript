import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attachBugseeOtelProvider,
  loadOtelModules,
  type OtelImporters,
  type OtelTracerModules,
} from './otel-provider';

// A structural stand-in for the Bugsee SpanProcessor (attach only forwards it into createProvider).
const processor = {
  onStart() {},
  onEnd() {},
  forceFlush: async () => {},
  shutdown: async () => {},
} as never;

function fakeMods(over: Partial<OtelTracerModules> = {}): OtelTracerModules {
  return {
    setGlobalTracerProvider: vi.fn(() => true),
    createProvider: vi.fn((sps: unknown[]) => ({ provider: true, sps })),
    ...over,
  };
}

describe('attachBugseeOtelProvider', () => {
  // Only the real-peers test below touches the real global tracer provider; reset it so nothing leaks.
  afterEach(() => trace.disable());

  it('registers a provider carrying the Bugsee processor when the global slot is free', async () => {
    const mods = fakeMods();
    const outcome = await attachBugseeOtelProvider(processor, { load: async () => mods });

    expect(outcome).toBe('registered');
    expect(mods.createProvider).toHaveBeenCalledWith([processor]); // the provider carries our processor
    const built = (mods.createProvider as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    expect(mods.setGlobalTracerProvider).toHaveBeenCalledWith(built); // registered globally
  });

  it('does NOT clobber an existing provider (first-wins) and surfaces guidance via onError', async () => {
    const mods = fakeMods({ setGlobalTracerProvider: vi.fn(() => false) }); // slot already taken
    const onError = vi.fn();
    const outcome = await attachBugseeOtelProvider(processor, { load: async () => mods, onError });

    expect(outcome).toBe('existing-provider');
    const err = onError.mock.calls[0]?.[0];
    expect(err).toBeInstanceOf(Error);
    // The notice IS the product surface here: it must say what happened AND name both escape hatches, or the
    // user is left with a silently trace-less Next app and no idea why.
    const message = (err as Error).message;
    expect(message).toMatch(/already registered/); // what happened
    expect(message).toMatch(/registerOTel/); // how to feed spans through their own provider
    expect(message).toMatch(/onSpanProcessor/); // where to get the processor from
  });

  it('is disabled by setupOtelProvider: false (never loads the SDK)', async () => {
    const load = vi.fn(async () => fakeMods());
    const outcome = await attachBugseeOtelProvider(processor, { setupOtelProvider: false, load });

    expect(outcome).toBe('disabled');
    expect(load).not.toHaveBeenCalled();
  });

  // `=== false` meant `'false'`, `0` and `null` kept the zero-config global provider ON. It installs a
  // process-wide provider and consumes every span, so an invalid value is OFF and reported.
  it.each([
    ['false', '"false"'],
    [0, '0'],
    [null, 'null'],
    ['', '""'],
    ['true', '"true"'],
    [1, '1'],
    [{}, '[object Object]'],
  ])('an invalid setupOtelProvider %j is OFF (never loads the SDK) and is reported', async (value, text) => {
    const load = vi.fn(async () => fakeMods());
    const onError = vi.fn();
    const outcome = await attachBugseeOtelProvider(processor, {
      setupOtelProvider: value as never,
      load,
      onError,
    });
    expect(outcome).toBe('disabled');
    expect(load).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    const message = (onError.mock.calls[0]?.[0] as Error).message;
    expect(message).toContain('setupOtelProvider');
    expect(message).toContain('OFF');
    expect(message).toContain(`got ${text}`);
  });

  it.each([
    [undefined],
    [true],
  ])('setupOtelProvider %j sets the provider up and reports nothing', async (value) => {
    const mods = fakeMods();
    const onError = vi.fn();
    const outcome = await attachBugseeOtelProvider(processor, {
      ...(value === undefined ? {} : { setupOtelProvider: value }),
      load: async () => mods,
      onError,
    });
    expect(outcome).toBe('registered');
    expect(onError).not.toHaveBeenCalled();
  });

  it('an explicit false is silent', async () => {
    const onError = vi.fn();
    expect(await attachBugseeOtelProvider(processor, { setupOtelProvider: false, onError })).toBe(
      'disabled',
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('a rethrowing onError cannot make the invalid-value warning throw or reject', async () => {
    const onError = vi.fn(() => {
      throw new Error('the host sink rethrows');
    });
    await expect(
      attachBugseeOtelProvider(processor, { setupOtelProvider: 'no' as never, onError }),
    ).resolves.toBe('disabled');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('skips gracefully when the optional OTel SDK is not installed', async () => {
    const outcome = await attachBugseeOtelProvider(processor, { load: async () => undefined });
    expect(outcome).toBe('unavailable');
  });

  it('skips gracefully (and reports) when loading the SDK throws', async () => {
    const onError = vi.fn();
    const outcome = await attachBugseeOtelProvider(processor, {
      load: async () => {
        throw new Error('module resolution failed');
      },
      onError,
    });
    expect(outcome).toBe('unavailable');
    expect(onError).toHaveBeenCalled();
  });

  it('never throws — a provider construction error yields "error" + onError', async () => {
    const mods = fakeMods({
      createProvider: vi.fn(() => {
        throw new Error('bad provider');
      }),
    });
    const onError = vi.fn();
    const outcome = await attachBugseeOtelProvider(processor, { load: async () => mods, onError });

    expect(outcome).toBe('error');
    expect(onError).toHaveBeenCalled();
    expect(mods.setGlobalTracerProvider).not.toHaveBeenCalled(); // never reached the global registration
  });

  it('uses the real optional OTel peers when no load seam is injected (defaultLoad → real provider)', async () => {
    // @opentelemetry/api + @opentelemetry/sdk-trace-base are installed (dev), so defaultLoad resolves them
    // and registers a real BasicTracerProvider on the free global slot. afterEach's trace.disable() resets it.
    const outcome = await attachBugseeOtelProvider(processor);
    expect(outcome).toBe('registered');
  });

  // The outcome alone proves nothing about the ZERO-CONFIG PROMISE: "Next emits its built-in spans and
  // Bugsee consumes them, with no user OTel setup". `defaultLoad` is the only code path that wires the real
  // peers, so it is the only place that can get that wiring wrong — a provider built without our processor,
  // or a `createProvider` that yields nothing, still returns 'registered'. Drive a real span through the
  // GLOBAL tracer (what Next.js itself uses) and assert it lands on the Bugsee processor.
  it('makes the REAL global tracer deliver spans to the Bugsee processor (zero-config end to end)', async () => {
    const onEnd = vi.fn<(span: { name: string }) => void>();
    const realProcessor = {
      onStart() {},
      onEnd,
      forceFlush: async () => {},
      shutdown: async () => {},
    } as never;

    expect(await attachBugseeOtelProvider(realProcessor)).toBe('registered');

    // `trace.getTracer` resolves through the global provider we just installed — exactly how Next's own
    // instrumentation emits its spans.
    trace.getTracer('next.js').startSpan('next-span').end();

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd.mock.calls[0]?.[0]?.name).toBe('next-span');
  });

  // `attachBugseeOtelProvider` is fired FIRE-AND-FORGET (`void attach(...)`) by registerServer, so a throw
  // here is an unhandled rejection in the user's server — not a caught error. `onError` is optional, and
  // every defensive path must survive its absence.
  describe('never throws when no onError sink is provided', () => {
    it('load rejecting → "unavailable"', async () => {
      await expect(
        attachBugseeOtelProvider(processor, {
          load: async () => {
            throw new Error('module resolution failed');
          },
        }),
      ).resolves.toBe('unavailable');
    });

    it('slot already taken → "existing-provider" (the guidance notice has nowhere to go)', async () => {
      const mods = fakeMods({ setGlobalTracerProvider: vi.fn(() => false) });
      await expect(attachBugseeOtelProvider(processor, { load: async () => mods })).resolves.toBe(
        'existing-provider',
      );
    });

    it('provider construction throwing → "error"', async () => {
      const mods = fakeMods({
        createProvider: vi.fn(() => {
          throw new Error('bad provider');
        }),
      });
      await expect(attachBugseeOtelProvider(processor, { load: async () => mods })).resolves.toBe(
        'error',
      );
    });
  });
});

// OpenTelemetry JS 3.0 removed `@opentelemetry/sdk-trace-base` (and renamed `BasicTracerProvider` to
// `TracerProvider` in its replacement `@opentelemetry/sdk-trace`). Without a fallback the zero-config
// provider silently stays 'unavailable' for every OTel 3 install (issue #94).
describe('loadOtelModules (which OTel SDK package provides the provider)', () => {
  const absent = () => Promise.reject(new Error('Cannot find module'));
  const ctor = (tag: string) =>
    class {
      readonly tag = tag;
      constructor(readonly options: { spanProcessors: unknown[] }) {}
    };
  const api = () => Promise.resolve({ trace: { setGlobalTracerProvider: vi.fn(() => true) } });

  const importers = (over: Partial<OtelImporters>): OtelImporters => ({
    api,
    sdkTraceBase: absent,
    sdkTrace: absent,
    ...over,
  });

  it('builds a BasicTracerProvider from sdk-trace-base (OTel 1.x/2.x)', async () => {
    const mods = await loadOtelModules(
      importers({ sdkTraceBase: () => Promise.resolve({ BasicTracerProvider: ctor('base') }) }),
    );
    expect(mods?.createProvider([processor])).toMatchObject({
      tag: 'base',
      options: { spanProcessors: [processor] },
    });
  });

  it('falls back to a TracerProvider from sdk-trace when sdk-trace-base is not installed (OTel 3.x)', async () => {
    const mods = await loadOtelModules(
      importers({ sdkTrace: () => Promise.resolve({ TracerProvider: ctor('v3') }) }),
    );
    expect(mods?.createProvider([processor])).toMatchObject({
      tag: 'v3',
      options: { spanProcessors: [processor] },
    });
  });

  it('prefers sdk-trace-base when both are installed (existing 1.x/2.x behaviour is unchanged)', async () => {
    const mods = await loadOtelModules(
      importers({
        sdkTraceBase: () => Promise.resolve({ BasicTracerProvider: ctor('base') }),
        sdkTrace: () => Promise.resolve({ TracerProvider: ctor('v3') }),
      }),
    );
    expect(mods?.createProvider([processor])).toMatchObject({ tag: 'base' });
  });

  it('falls back when sdk-trace-base resolves but does not export a provider class', async () => {
    const mods = await loadOtelModules(
      importers({
        sdkTraceBase: () => Promise.resolve({}),
        sdkTrace: () => Promise.resolve({ TracerProvider: ctor('v3') }),
      }),
    );
    expect(mods?.createProvider([processor])).toMatchObject({ tag: 'v3' });
  });

  it('delegates global registration to @opentelemetry/api', async () => {
    const setGlobal = vi.fn(() => true);
    const mods = await loadOtelModules(
      importers({
        api: () => Promise.resolve({ trace: { setGlobalTracerProvider: setGlobal } }),
        sdkTrace: () => Promise.resolve({ TracerProvider: ctor('v3') }),
      }),
    );
    const provider = { p: 1 };
    expect(mods?.setGlobalTracerProvider(provider)).toBe(true);
    expect(setGlobal).toHaveBeenCalledWith(provider);
  });

  it('is undefined (unavailable) when no SDK package is installed', async () => {
    expect(await loadOtelModules(importers({}))).toBeUndefined();
  });

  it('is undefined when @opentelemetry/api is not installed', async () => {
    expect(
      await loadOtelModules(
        importers({ api: absent, sdkTrace: () => Promise.resolve({ TracerProvider: ctor('v3') }) }),
      ),
    ).toBeUndefined();
  });

  it('is undefined when the SDK module exports no provider class at all', async () => {
    expect(
      await loadOtelModules(
        importers({ sdkTraceBase: () => Promise.resolve({}), sdkTrace: () => Promise.resolve({}) }),
      ),
    ).toBeUndefined();
  });
});

describe('attachBugseeOtelProvider default loading on an OTel 3 install (sdk-trace-base removed)', () => {
  afterEach(() => {
    vi.doUnmock('@opentelemetry/sdk-trace-base');
    vi.doUnmock('@opentelemetry/sdk-trace');
    vi.resetModules();
    trace.disable();
  });

  it('registers a TracerProvider from sdk-trace through the real default loader', async () => {
    vi.resetModules();
    vi.doMock('@opentelemetry/sdk-trace-base', () => {
      throw new Error('Cannot find module @opentelemetry/sdk-trace-base');
    });
    const built: unknown[][] = [];
    vi.doMock('@opentelemetry/sdk-trace', () => ({
      TracerProvider: class {
        // Only the registration plumbing is under test here; the API calls are made on a global provider.
        constructor(options: { spanProcessors: unknown[] }) {
          built.push(options.spanProcessors);
        }
        getTracer() {
          return trace.getTracer('noop');
        }
      },
    }));
    const fresh = await import('./otel-provider');

    expect(await fresh.attachBugseeOtelProvider(processor)).toBe('registered');
    expect(built).toEqual([[processor]]);
  });

  it('reports unavailable when neither SDK package can be imported', async () => {
    vi.resetModules();
    vi.doMock('@opentelemetry/sdk-trace-base', () => {
      throw new Error('absent');
    });
    vi.doMock('@opentelemetry/sdk-trace', () => {
      throw new Error('absent');
    });
    const fresh = await import('./otel-provider');

    expect(await fresh.attachBugseeOtelProvider(processor)).toBe('unavailable');
  });
});
