import {
  type CaptureProvider,
  type CaptureProviderInit,
  createCaptureAggregator,
  createCaptureCoordinator,
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

// Integration (standards §3, cross-package boundary): the `controllingOption` promise — "it only warns when
// the user enabled the feature" — is NOT enforced by the shim itself. The CAPTURE COORDINATOR reads
// `provider.controllingOption` and skips the provider entirely when the launch gate says the option is off
// (packages/core/src/capture-coordinator.ts:41). Calling `provider.start()` directly, as the unit tests
// above do, bypasses that gate, so the gating contract only holds if the shim leaves `controllingOption`
// genuinely ABSENT when none was supplied — assigning `undefined` unconditionally would make every gated
// shim look ungated and warn on a feature the user never turned on.
describe('shims ⇄ core capture coordinator (controllingOption gating)', () => {
  const coordinatorFor = (provider: CaptureProvider, enabled: Record<string, boolean>) => {
    const store = createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY });
    const co = createCaptureCoordinator({
      operations: createOperationDispatcher(),
      captureAggregator: createCaptureAggregator(store),
    });
    co.addProvider(provider);
    return {
      start: () => co.start(createOptionsContainer(), (option: string) => enabled[option] === true),
      stop: () => co.stop(),
    };
  };

  it('never warns for a gated shim whose controlling option is DISABLED', () => {
    const { logger, warns } = realLogger();
    const p = createViewHierarchyProviderShim({
      runtime: 'cloudflare',
      logger,
      controllingOption: 'com.bugsee.option.capture.viewhierarchy',
    });
    coordinatorFor(p, { 'com.bugsee.option.capture.viewhierarchy': false }).start();
    expect(warns).toEqual([]); // the user never enabled it → no noise about it being a no-op
  });

  it('warns exactly once for a gated shim whose controlling option is ENABLED', () => {
    const { logger, warns } = realLogger();
    const p = createViewHierarchyProviderShim({
      runtime: 'cloudflare',
      logger,
      controllingOption: 'com.bugsee.option.capture.viewhierarchy',
    });
    coordinatorFor(p, { 'com.bugsee.option.capture.viewhierarchy': true }).start();
    expect(warns).toEqual(['viewHierarchyProvider is a no-op on cloudflare; ignored']);
  });

  it('starts an UNGATED shim even when the gate enables nothing (an absent controllingOption is not a gate)', () => {
    const { logger, warns } = realLogger();
    const p = createBreadcrumbsProviderShim({ runtime: 'cloudflare', logger });
    // `controllingOption` is an own property valued `undefined` here (the class field declaration is
    // emitted, so `'controllingOption' in p` is true either way) — what the coordinator reads is the
    // VALUE, and `undefined` means ungated: the provider must start regardless of the gate.
    expect(p.controllingOption).toBe(undefined);
    coordinatorFor(p, {}).start(); // gate says nothing is enabled — an ungated provider still starts
    expect(warns).toEqual(['breadcrumbsProvider is a no-op on cloudflare; ignored']);
  });
});
