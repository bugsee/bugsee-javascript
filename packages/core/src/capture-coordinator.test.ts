import { describe, expect, it, vi } from 'vitest';
import { createCaptureCoordinator } from './capture-coordinator';
import type { CaptureProvider, CaptureProviderInit, OptionsContainer } from './contracts';
import { createOptionsContainer } from './options';

const noop = () => {};
const init: CaptureProviderInit = {
  operations: { registerObserver: () => noop, onOperation: noop },
  captureAggregator: { addEntry: noop, addEntries: noop, clear: noop },
};
const options: OptionsContainer = createOptionsContainer({ captureNetwork: true });
const enableAll = () => true;

function makeProvider(name: string, controllingOption?: string): CaptureProvider {
  return {
    name,
    ...(controllingOption !== undefined ? { controllingOption } : {}),
    init: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

describe('createCaptureCoordinator — registration + init', () => {
  it('registers providers', () => {
    const co = createCaptureCoordinator(init);
    const p = makeProvider('a');
    co.addProvider(p);
    expect(co.providers).toContain(p);
  });

  it('inits a provider with the pipeline deps at registration, before any start', () => {
    const co = createCaptureCoordinator(init);
    const p = makeProvider('a');
    co.addProvider(p);
    expect(p.init).toHaveBeenCalledTimes(1);
    expect(p.init).toHaveBeenCalledWith(init);
    expect(p.start).not.toHaveBeenCalled();
  });

  it('inits a gated provider at registration regardless of enablement', () => {
    const co = createCaptureCoordinator(init);
    const p = makeProvider('net', 'captureNetwork');
    co.addProvider(p);
    expect(p.init).toHaveBeenCalledTimes(1);
    co.start(options, () => false); // gated off
    expect(p.start).not.toHaveBeenCalled();
  });

  it('throws on a duplicate provider name (and does not init the duplicate)', () => {
    const co = createCaptureCoordinator(init);
    co.addProvider(makeProvider('a'));
    const dup = makeProvider('a');
    expect(() => co.addProvider(dup)).toThrow(/already registered/);
    expect(dup.init).not.toHaveBeenCalled();
  });

  it('providers getter returns a copy', () => {
    const co = createCaptureCoordinator(init);
    co.addProvider(makeProvider('a'));
    const snapshot = co.providers as CaptureProvider[];
    snapshot.push(makeProvider('injected'));
    expect(co.providers).toHaveLength(1);
  });
});

describe('createCaptureCoordinator — start/stop with options', () => {
  it('starts a provider without a controllingOption, passing the launch options', () => {
    const co = createCaptureCoordinator(init);
    const p = makeProvider('a');
    co.addProvider(p);
    co.start(options, enableAll);
    expect(p.start).toHaveBeenCalledTimes(1);
    expect(p.start).toHaveBeenCalledWith(options);
  });

  it('starts a no-controllingOption provider even when the gate denies everything', () => {
    // pins the `controllingOption === undefined` short-circuit: the gate must not be consulted
    const co = createCaptureCoordinator(init);
    const p = makeProvider('a'); // no controllingOption
    co.addProvider(p);
    co.start(options, () => false);
    expect(p.start).toHaveBeenCalledTimes(1);
  });

  it('starts a provider whose controllingOption is enabled', () => {
    const co = createCaptureCoordinator(init);
    const p = makeProvider('net', 'captureNetwork');
    co.addProvider(p);
    co.start(options, (opt) => opt === 'captureNetwork');
    expect(p.start).toHaveBeenCalledTimes(1);
  });

  it('skips a provider whose controllingOption is disabled', () => {
    const co = createCaptureCoordinator(init);
    const p = makeProvider('net', 'captureNetwork');
    co.addProvider(p);
    co.start(options, () => false);
    expect(p.start).not.toHaveBeenCalled();
  });

  it('throws if started twice', () => {
    const co = createCaptureCoordinator(init);
    co.start(options, enableAll);
    expect(() => co.start(options, enableAll)).toThrow(/already started/);
  });

  it('stops only the providers that were started', () => {
    const co = createCaptureCoordinator(init);
    const on = makeProvider('on');
    const off = makeProvider('off', 'disabled');
    co.addProvider(on);
    co.addProvider(off);
    co.start(options, (opt) => opt !== 'disabled');
    co.stop();
    expect(on.stop).toHaveBeenCalledTimes(1);
    expect(off.stop).not.toHaveBeenCalled();
  });

  it('stop is a no-op when not started', () => {
    const co = createCaptureCoordinator(init);
    const p = makeProvider('a');
    co.addProvider(p);
    expect(() => co.stop()).not.toThrow();
    expect(p.stop).not.toHaveBeenCalled();
  });

  it('can be restarted after stop, re-starting (but not re-initing) the provider', () => {
    const co = createCaptureCoordinator(init);
    const p = makeProvider('a');
    co.addProvider(p);
    co.start(options, enableAll);
    co.stop();
    co.start(options, enableAll);
    expect(p.init).toHaveBeenCalledTimes(1); // init is one-time, at registration
    expect(p.start).toHaveBeenCalledTimes(2);
  });
});

describe('createCaptureCoordinator — providers added while running', () => {
  it('inits and starts a provider added while running (if enabled)', () => {
    const co = createCaptureCoordinator(init);
    co.start(options, enableAll);
    const p = makeProvider('late');
    co.addProvider(p);
    expect(p.init).toHaveBeenCalledTimes(1);
    expect(p.start).toHaveBeenCalledTimes(1);
    expect(p.start).toHaveBeenCalledWith(options);
  });

  it('inits but does not start a disabled provider added while running', () => {
    const co = createCaptureCoordinator(init);
    co.start(options, () => false);
    const p = makeProvider('late', 'off');
    co.addProvider(p);
    expect(p.init).toHaveBeenCalledTimes(1);
    expect(p.start).not.toHaveBeenCalled();
  });

  it('inits (does not start) a provider added while not running', () => {
    const co = createCaptureCoordinator(init);
    const p = makeProvider('a');
    co.addProvider(p);
    expect(p.init).toHaveBeenCalledTimes(1);
    expect(p.start).not.toHaveBeenCalled();
  });

  it('a provider added-while-running that was skipped is not stopped', () => {
    const co = createCaptureCoordinator(init);
    co.start(options, () => false);
    const p = makeProvider('late', 'off');
    co.addProvider(p);
    co.stop();
    expect(p.stop).not.toHaveBeenCalled();
  });
});
