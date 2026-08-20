import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachBugseeOtelProvider, type OtelTracerModules } from './otel-provider';

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
