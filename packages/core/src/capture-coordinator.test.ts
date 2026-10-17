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

describe('createCaptureCoordinator — one failing provider never costs the others', () => {
  const boom = (name: string, over: Partial<CaptureProvider> = {}): CaptureProvider => ({
    ...makeProvider(name),
    start: vi.fn(() => {
      throw new Error(`${name} start failed`);
    }),
    ...over,
  });

  it('a throwing start is reported, best-effort stopped (it may be half started) and does not stop later providers starting', () => {
    const errors: unknown[] = [];
    const co = createCaptureCoordinator(init, (e) => errors.push(e));
    const before = makeProvider('before');
    const bad = boom('bad');
    const after = makeProvider('after');
    for (const p of [before, bad, after]) co.addProvider(p);
    expect(() => co.start(options, enableAll)).not.toThrow();
    expect(before.start).toHaveBeenCalledTimes(1);
    expect(after.start).toHaveBeenCalledTimes(1);
    expect(bad.stop).toHaveBeenCalledTimes(1); // unwound: whatever it attached before throwing is released
    expect((errors[0] as Error).message).toBe('bad start failed');
    co.stop();
    expect(bad.stop).toHaveBeenCalledTimes(1); // not "started", so not stopped again
    expect(before.stop).toHaveBeenCalledTimes(1);
    expect(after.stop).toHaveBeenCalledTimes(1);
  });

  it('works without an error sink, and a throwing unwind stop() or reporter changes nothing', () => {
    const bad = boom('bad', {
      stop: vi.fn(() => {
        throw new Error('unwind failed');
      }),
    });
    const co = createCaptureCoordinator(init);
    co.addProvider(bad);
    expect(() => co.start(options, enableAll)).not.toThrow();
    const co2 = createCaptureCoordinator(init, () => {
      throw new Error('reporter');
    });
    co2.addProvider(boom('bad2'));
    expect(() => co2.start(options, enableAll)).not.toThrow();
  });

  it('a provider added after start that throws is isolated too', () => {
    const errors: unknown[] = [];
    const co = createCaptureCoordinator(init, (e) => errors.push(e));
    co.start(options, enableAll);
    expect(() => co.addProvider(boom('late'))).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it('a throwing stop() does not strand the other providers', () => {
    const errors: unknown[] = [];
    const co = createCaptureCoordinator(init, (e) => errors.push(e));
    const a = makeProvider('a');
    const b = makeProvider('b', undefined);
    (a.stop as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('a stop failed');
    });
    co.addProvider(a);
    co.addProvider(b);
    co.start(options, enableAll);
    expect(() => co.stop()).not.toThrow();
    expect(b.stop).toHaveBeenCalledTimes(1);
    expect((errors[0] as Error).message).toBe('a stop failed');
  });
});

describe('createCaptureCoordinator — re-entrancy and a hostile gate', () => {
  it('an onError that stops the coordinator mid-start ends the start: later providers are not started, nothing spurious is reported', () => {
    const errors: unknown[] = [];
    let co: ReturnType<typeof createCaptureCoordinator> | undefined;
    co = createCaptureCoordinator(init, (e) => {
      errors.push(e);
      co?.stop();
    });
    const bad = makeProvider('bad');
    (bad.start as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('bad start failed');
    });
    const plain = makeProvider('plain');
    const gated = makeProvider('gated', 'x');
    for (const p of [bad, plain, gated]) co.addProvider(p);
    expect(() => co?.start(options, enableAll)).not.toThrow();
    expect(plain.start).not.toHaveBeenCalled();
    expect(gated.start).not.toHaveBeenCalled();
    expect(errors.map((e) => (e as Error).message)).toEqual(['bad start failed']);
  });

  it('a throwing gate isolates that provider only: reported, the others still start', () => {
    const errors: unknown[] = [];
    const co = createCaptureCoordinator(init, (e) => errors.push(e));
    const a = makeProvider('a', 'boom');
    const b = makeProvider('b', 'fine');
    co.addProvider(a);
    co.addProvider(b);
    expect(() =>
      co.start(options, (opt) => {
        if (opt === 'boom') throw new Error('gate failed');
        return true;
      }),
    ).not.toThrow();
    expect(a.start).not.toHaveBeenCalled();
    expect(b.start).toHaveBeenCalledTimes(1);
    expect((errors[0] as Error).message).toBe('gate failed');
  });

  it('a provider added after a stop is not started by the stale session', () => {
    const co = createCaptureCoordinator(init);
    co.start(options, enableAll);
    co.stop();
    const late = makeProvider('late');
    co.addProvider(late);
    expect(late.start).not.toHaveBeenCalled();
  });
});

describe('createCaptureCoordinator — re-entrant reporters cannot corrupt a session', () => {
  it('a provider whose start() stops the coordinator is released, not recorded on the dead session', () => {
    let co: ReturnType<typeof createCaptureCoordinator> | undefined;
    co = createCaptureCoordinator(init);
    const p = makeProvider('p');
    (p.start as ReturnType<typeof vi.fn>).mockImplementation(() => co?.stop());
    co.addProvider(p);
    co.start(options, enableAll);
    expect(p.stop).toHaveBeenCalledTimes(1); // released immediately
    co.stop();
    expect(p.stop).toHaveBeenCalledTimes(1); // and not stopped again from a stale `started`
  });

  it('a failing start is unwound BEFORE it is reported, so a reporter that relaunches keeps its fresh provider', () => {
    const order: string[] = [];
    let attempt = 0;
    let co: ReturnType<typeof createCaptureCoordinator> | undefined;
    co = createCaptureCoordinator(init, () => {
      order.push('report');
      if (attempt === 1) {
        co?.stop();
        co?.start(options, enableAll); // relaunch from the reporter: the provider starts fine this time
      }
    });
    const p = makeProvider('p');
    (p.start as ReturnType<typeof vi.fn>).mockImplementation(() => {
      attempt += 1;
      order.push(`start${attempt}`);
      if (attempt === 1) throw new Error('first start fails');
    });
    (p.stop as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('stop'));
    co.addProvider(p);
    co.start(options, enableAll);
    expect(order).toEqual(['start1', 'stop', 'report', 'start2']); // no stale stop after the relaunch
    co.stop();
    expect(order.at(-1)).toBe('stop');
  });

  it('stop() reports stop failures only after every provider has stopped, so a relaunching reporter is not undone', () => {
    const order: string[] = [];
    let co: ReturnType<typeof createCaptureCoordinator> | undefined;
    let relaunched = false;
    co = createCaptureCoordinator(init, () => {
      order.push('report');
      if (!relaunched) {
        relaunched = true;
        co?.start(options, enableAll);
      }
    });
    const a = makeProvider('a');
    const b = makeProvider('b');
    (a.stop as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('a-stop');
      throw new Error('a stop failed');
    });
    (b.stop as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('b-stop'));
    co.addProvider(a);
    co.addProvider(b);
    co.start(options, enableAll);
    co.stop();
    expect(order).toEqual(['a-stop', 'b-stop', 'report']);
    expect(a.start).toHaveBeenCalledTimes(2); // the relaunch from the reporter really started again
    expect(b.stop).toHaveBeenCalledTimes(1); // and the old loop did not stop the fresh session's providers
    co.stop();
    expect(b.stop).toHaveBeenCalledTimes(2); // the relaunched session is still tracked and stops normally
  });
});
