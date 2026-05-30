import {
  type CaptureProviderInit,
  createCaptureAggregator,
  createCaptureExporter,
  createMemoryCaptureStore,
  createOperationDispatcher,
  createOptionsContainer,
} from '@bugsee/core';
import { createLogger, type LogLevel } from '@bugsee/logger';
import { describe, expect, it, vi } from 'vitest';
import {
  createBreadcrumbsProviderShim,
  createNoopCaptureProvider,
  createNoopInterceptor,
  createViewHierarchyProviderShim,
  createXhrInterceptorShim,
} from './index';

const fakeLogger = () => ({ warnOnce: vi.fn() });

// A real logger + a capturing handler, to validate the END-TO-END "warns at most once" behavior
// (the dedup lives in Logger.warnOnce, keyed by the shim's name).
const realLogger = () => {
  const warns: string[] = [];
  const logger = createLogger('warn');
  logger.addHandler((level: LogLevel, args: readonly unknown[]) => {
    if (level === 'warn') {
      warns.push(String(args[0]));
    }
  });
  return { logger, warns };
};

const buildInit = (): { init: CaptureProviderInit; drain: () => Promise<number> } => {
  const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
  const init: CaptureProviderInit = {
    operations: createOperationDispatcher(),
    captureAggregator: createCaptureAggregator(store),
  };
  return { init, drain: async () => (await createCaptureExporter(store).drain()).size };
};

describe('createNoopCaptureProvider', () => {
  it('does not warn at construction (no import/build side effects)', () => {
    const logger = fakeLogger();
    createNoopCaptureProvider({ name: 'X', runtime: 'cloudflare', logger });
    expect(logger.warnOnce).not.toHaveBeenCalled();
  });

  it('carries its name and an optional controllingOption', () => {
    const logger = fakeLogger();
    const p = createNoopCaptureProvider({
      name: 'X',
      runtime: 'cloudflare',
      logger,
      controllingOption: 'com.bugsee.option.capture.x',
    });
    expect(p.name).toBe('X');
    expect(p.controllingOption).toBe('com.bugsee.option.capture.x');
    expect(
      createNoopCaptureProvider({ name: 'Y', runtime: 'deno', logger }).controllingOption,
    ).toBe(undefined);
  });

  it('warns once with the runtime message when started, keyed by name', () => {
    const logger = fakeLogger();
    const p = createNoopCaptureProvider({ name: 'X', runtime: 'cloudflare', logger });
    p.start(createOptionsContainer());
    expect(logger.warnOnce).toHaveBeenCalledWith('shim:X', 'X is a no-op on cloudflare; ignored');
  });

  it('captures nothing (the aggregator receives no entries)', async () => {
    const logger = fakeLogger();
    const { init, drain } = buildInit();
    const p = createNoopCaptureProvider({ name: 'X', runtime: 'cloudflare', logger });
    p.init(init);
    p.start(createOptionsContainer());
    p.stop();
    expect(await drain()).toBe(0);
  });

  it('surfaces the warning at most once across repeated starts (real logger)', () => {
    const { logger, warns } = realLogger();
    const p = createNoopCaptureProvider({ name: 'X', runtime: 'cloudflare', logger });
    p.start(createOptionsContainer());
    p.stop();
    p.start(createOptionsContainer());
    expect(warns).toEqual(['X is a no-op on cloudflare; ignored']); // exactly one, not two
  });
});

describe('createNoopInterceptor', () => {
  it('does not warn at construction', () => {
    const logger = fakeLogger();
    createNoopInterceptor({ name: 'xhrInterceptor', runtime: 'node', logger });
    expect(logger.warnOnce).not.toHaveBeenCalled();
  });

  it('is a valid Interceptor that warns once when explicitly started', () => {
    const logger = fakeLogger();
    const i = createNoopInterceptor({ name: 'xhrInterceptor', runtime: 'node', logger });
    expect(i.name).toBe('xhrInterceptor');
    i.start();
    expect(logger.warnOnce).toHaveBeenCalledWith(
      'shim:xhrInterceptor',
      'xhrInterceptor is a no-op on node; ignored',
    );
    i.stop(); // must not throw
  });

  it('activates (and warns) via subscriber presence, not just explicit start', () => {
    const logger = fakeLogger();
    const i = createNoopInterceptor({ name: 'xhrInterceptor', runtime: 'node', logger });
    const off = i.onAny(() => {}); // first listener → active → onActivate
    expect(logger.warnOnce).toHaveBeenCalledTimes(1);
    off();
  });

  it('surfaces the warning at most once across re-activation (real logger)', () => {
    const { logger, warns } = realLogger();
    const i = createNoopInterceptor({ name: 'xhrInterceptor', runtime: 'node', logger });
    i.start();
    i.stop();
    i.start();
    expect(warns).toEqual(['xhrInterceptor is a no-op on node; ignored']);
  });
});

describe('named convenience shims', () => {
  it('viewHierarchy + breadcrumbs providers fix their names and pass through controllingOption', () => {
    const logger = fakeLogger();
    const vh = createViewHierarchyProviderShim({
      runtime: 'cloudflare',
      logger,
      controllingOption: 'opt.vh',
    });
    const bc = createBreadcrumbsProviderShim({ runtime: 'cloudflare', logger });
    expect(vh.name).toBe('viewHierarchyProvider');
    expect(vh.controllingOption).toBe('opt.vh');
    expect(bc.name).toBe('breadcrumbsProvider');
    vh.start(createOptionsContainer());
    expect(logger.warnOnce).toHaveBeenCalledWith(
      'shim:viewHierarchyProvider',
      'viewHierarchyProvider is a no-op on cloudflare; ignored',
    );
  });

  it('xhrInterceptor shim fixes its name', () => {
    const logger = fakeLogger();
    const i = createXhrInterceptorShim({ runtime: 'deno', logger });
    expect(i.name).toBe('xhrInterceptor');
    i.start();
    expect(logger.warnOnce).toHaveBeenCalledWith(
      'shim:xhrInterceptor',
      'xhrInterceptor is a no-op on deno; ignored',
    );
  });
});
