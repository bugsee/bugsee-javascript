import { describe, expect, it, vi } from 'vitest';
import type { Client, DetectionProvider } from './contracts';
import { createDetectionCoordinator } from './detection-coordinator';
import { createReportingRequest, type ReportingRequest } from './reporting';

const client = { tag: 'client' } as unknown as Client;
const enableAll = () => true;
const noReport: (request: ReportingRequest) => void = () => {};
const request = (id: string): ReportingRequest =>
  createReportingRequest({ source: { type: 'crash' }, id });

// A fake provider that captures the report callback so tests can submit a request through it.
function makeProvider(name: string, controllingOption?: string) {
  let captured: ((request: ReportingRequest) => void) | undefined;
  const provider: DetectionProvider = {
    name,
    ...(controllingOption !== undefined ? { controllingOption } : {}),
    start: vi.fn((_client: Client, report: (request: ReportingRequest) => void) => {
      captured = report;
    }),
    stop: vi.fn(),
  };
  return { provider, fire: (req: ReportingRequest) => captured?.(req) };
}

describe('createDetectionCoordinator', () => {
  it('registers providers', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('crash');
    co.addProvider(provider);
    expect(co.providers).toContain(provider);
  });

  it('throws on a duplicate provider name', () => {
    const co = createDetectionCoordinator();
    co.addProvider(makeProvider('crash').provider);
    expect(() => co.addProvider(makeProvider('crash').provider)).toThrow(/already registered/);
  });

  it('starts an enabled provider with the client and a report callback', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('crash', 'detectCrash');
    co.addProvider(provider);
    co.start(client, (opt) => opt === 'detectCrash', noReport);
    expect(provider.start).toHaveBeenCalledTimes(1);
    expect((provider.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(client);
    expect(typeof (provider.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe('function');
  });

  it('routes a submitted request to onReport', () => {
    const co = createDetectionCoordinator();
    const { provider, fire } = makeProvider('crash');
    const onReport = vi.fn();
    co.addProvider(provider);
    co.start(client, enableAll, onReport);
    const req = request('r1');
    fire(req);
    expect(onReport).toHaveBeenCalledWith(req);
  });

  it('starts a no-controllingOption provider even when the gate denies everything', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('crash');
    co.addProvider(provider);
    co.start(client, () => false, noReport);
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('skips a provider whose controllingOption is disabled', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('http', 'detectHttpErrors');
    co.addProvider(provider);
    co.start(client, () => false, noReport);
    expect(provider.start).not.toHaveBeenCalled();
  });

  it('throws if started twice', () => {
    const co = createDetectionCoordinator();
    co.start(client, enableAll, noReport);
    expect(() => co.start(client, enableAll, noReport)).toThrow(/already started/);
  });

  it('stops only started providers; idempotent when not started', () => {
    const co = createDetectionCoordinator();
    const on = makeProvider('on');
    const off = makeProvider('off', 'disabled');
    co.addProvider(on.provider);
    co.addProvider(off.provider);
    co.start(client, (opt) => opt !== 'disabled', noReport);
    co.stop();
    expect(on.provider.stop).toHaveBeenCalledTimes(1);
    expect(off.provider.stop).not.toHaveBeenCalled();
    expect(() => co.stop()).not.toThrow();
  });

  it('can be restarted after stop', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('crash');
    co.addProvider(provider);
    co.start(client, enableAll, noReport);
    co.stop();
    co.start(client, enableAll, noReport);
    expect(provider.start).toHaveBeenCalledTimes(2);
  });

  it('starts a provider added while running and wires its report callback', () => {
    const co = createDetectionCoordinator();
    const onReport = vi.fn();
    co.start(client, enableAll, onReport);
    const { provider, fire } = makeProvider('late');
    co.addProvider(provider);
    expect(provider.start).toHaveBeenCalledTimes(1);
    const req = request('late-1');
    fire(req);
    expect(onReport).toHaveBeenCalledWith(req);
  });

  it('only registers (does not start) a provider added while not running', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('crash');
    co.addProvider(provider);
    expect(provider.start).not.toHaveBeenCalled();
  });

  it('providers getter returns a copy', () => {
    const co = createDetectionCoordinator();
    co.addProvider(makeProvider('a').provider);
    const snapshot = co.providers as DetectionProvider[];
    snapshot.push(makeProvider('injected').provider);
    expect(co.providers).toHaveLength(1);
  });
});

describe('createDetectionCoordinator — one failing provider never costs the others', () => {
  const failing = (name: string) => {
    const p = makeProvider(name);
    (p.provider.start as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error(`${name} start failed`);
    });
    return p;
  };

  it('a throwing start is reported, best-effort stopped, and later providers still start', () => {
    const errors: unknown[] = [];
    const co = createDetectionCoordinator((e) => errors.push(e));
    const bad = failing('bad');
    const after = makeProvider('after');
    co.addProvider(bad.provider);
    co.addProvider(after.provider);
    expect(() => co.start(client, enableAll, noReport)).not.toThrow();
    expect(after.provider.start).toHaveBeenCalledTimes(1);
    expect(bad.provider.stop).toHaveBeenCalledTimes(1);
    expect((errors[0] as Error).message).toBe('bad start failed');
    co.stop();
    expect(bad.provider.stop).toHaveBeenCalledTimes(1);
    expect(after.provider.stop).toHaveBeenCalledTimes(1);
  });

  it('works without a sink; a throwing unwind or reporter changes nothing; a late provider is isolated', () => {
    const co = createDetectionCoordinator();
    const bad = failing('bad');
    (bad.provider.stop as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('unwind');
    });
    co.addProvider(bad.provider);
    expect(() => co.start(client, enableAll, noReport)).not.toThrow();
    const errors: unknown[] = [];
    const co2 = createDetectionCoordinator((e) => {
      errors.push(e);
      throw new Error('reporter');
    });
    co2.start(client, enableAll, noReport);
    expect(() => co2.addProvider(failing('late').provider)).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it('a throwing stop() does not strand the others', () => {
    const errors: unknown[] = [];
    const co = createDetectionCoordinator((e) => errors.push(e));
    const a = makeProvider('a');
    const b = makeProvider('b');
    (a.provider.stop as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('a stop failed');
    });
    co.addProvider(a.provider);
    co.addProvider(b.provider);
    co.start(client, enableAll, noReport);
    expect(() => co.stop()).not.toThrow();
    expect(b.provider.stop).toHaveBeenCalledTimes(1);
    expect((errors[0] as Error).message).toBe('a stop failed');
  });
});

describe('createDetectionCoordinator — re-entrancy and a hostile gate', () => {
  it('an onError that stops the coordinator mid-start ends the start with no spurious errors', () => {
    const errors: unknown[] = [];
    let co: ReturnType<typeof createDetectionCoordinator> | undefined;
    co = createDetectionCoordinator((e) => {
      errors.push(e);
      co?.stop();
    });
    const bad = makeProvider('bad');
    (bad.provider.start as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('bad start failed');
    });
    const after = makeProvider('after');
    const gated = makeProvider('gated', 'x');
    co.addProvider(bad.provider);
    co.addProvider(after.provider);
    co.addProvider(gated.provider);
    expect(() => co?.start(client, enableAll, noReport)).not.toThrow();
    expect(after.provider.start).not.toHaveBeenCalled();
    expect(gated.provider.start).not.toHaveBeenCalled();
    expect(errors.map((e) => (e as Error).message)).toEqual(['bad start failed']);
  });

  it('a throwing gate isolates that provider only', () => {
    const errors: unknown[] = [];
    const co = createDetectionCoordinator((e) => errors.push(e));
    const a = makeProvider('a', 'boom');
    const b = makeProvider('b', 'fine');
    co.addProvider(a.provider);
    co.addProvider(b.provider);
    expect(() =>
      co.start(
        client,
        (opt) => {
          if (opt === 'boom') throw new Error('gate failed');
          return true;
        },
        noReport,
      ),
    ).not.toThrow();
    expect(a.provider.start).not.toHaveBeenCalled();
    expect(b.provider.start).toHaveBeenCalledTimes(1);
    expect((errors[0] as Error).message).toBe('gate failed');
  });
});

describe('createDetectionCoordinator — re-entrant reporters cannot corrupt a session', () => {
  it('a provider whose start() stops the coordinator is released, not recorded on the dead session', () => {
    let co: ReturnType<typeof createDetectionCoordinator> | undefined;
    co = createDetectionCoordinator();
    const { provider } = makeProvider('p');
    (provider.start as ReturnType<typeof vi.fn>).mockImplementation(() => co?.stop());
    co.addProvider(provider);
    co.start(client, enableAll, noReport);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    co.stop();
    expect(provider.stop).toHaveBeenCalledTimes(1);
  });

  it('a failing start is unwound BEFORE it is reported, so a relaunching reporter keeps its fresh provider', () => {
    const order: string[] = [];
    let attempt = 0;
    let co: ReturnType<typeof createDetectionCoordinator> | undefined;
    co = createDetectionCoordinator(() => {
      order.push('report');
      if (attempt === 1) {
        co?.stop();
        co?.start(client, enableAll, noReport);
      }
    });
    const { provider } = makeProvider('p');
    (provider.start as ReturnType<typeof vi.fn>).mockImplementation(() => {
      attempt += 1;
      order.push(`start${attempt}`);
      if (attempt === 1) throw new Error('first start fails');
    });
    (provider.stop as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('stop'));
    co.addProvider(provider);
    co.start(client, enableAll, noReport);
    expect(order).toEqual(['start1', 'stop', 'report', 'start2']);
  });

  it('stop() reports stop failures only after every provider has stopped', () => {
    const order: string[] = [];
    let co: ReturnType<typeof createDetectionCoordinator> | undefined;
    let relaunched = false;
    co = createDetectionCoordinator(() => {
      order.push('report');
      if (!relaunched) {
        relaunched = true;
        co?.start(client, enableAll, noReport);
      }
    });
    const a = makeProvider('a');
    const b = makeProvider('b');
    (a.provider.stop as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('a-stop');
      throw new Error('a stop failed');
    });
    (b.provider.stop as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('b-stop'));
    co.addProvider(a.provider);
    co.addProvider(b.provider);
    co.start(client, enableAll, noReport);
    co.stop();
    expect(order).toEqual(['a-stop', 'b-stop', 'report']);
    expect(b.provider.stop).toHaveBeenCalledTimes(1);
    co.stop();
    expect(b.provider.stop).toHaveBeenCalledTimes(2); // the relaunched session is still tracked
  });
});
