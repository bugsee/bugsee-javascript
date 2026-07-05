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
    expect((err as Error).message).toMatch(/registerOTel/); // tells the user how to feed spans instead
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
});
