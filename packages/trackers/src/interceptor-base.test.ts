import { describe, expect, it } from 'vitest';
import { InterceptorBase } from './interceptor-base';

interface Stages {
  tick: number;
}

class TestInterceptor extends InterceptorBase<Stages> {
  readonly name = 'test';
  activations = 0;
  deactivations = 0;
  protected onActivate(): void {
    this.activations += 1;
  }
  protected override onDeactivate(): void {
    this.deactivations += 1;
  }
  // expose emit so a test can drive a stage
  fireTick(n: number): void {
    this.emit('tick', n);
  }
}

describe('InterceptorBase — explicit start/stop activation', () => {
  it('activates on start() and deactivates on stop()', () => {
    const ic = new TestInterceptor();
    ic.start();
    expect(ic.activations).toBe(1);
    ic.stop();
    expect(ic.deactivations).toBe(1);
  });

  it('start() is idempotent (does not re-activate)', () => {
    const ic = new TestInterceptor();
    ic.start();
    ic.start();
    expect(ic.activations).toBe(1);
  });

  it('stop() while idle does not deactivate', () => {
    const ic = new TestInterceptor();
    ic.stop();
    expect(ic.deactivations).toBe(0);
  });

  it('exposes the subclass name', () => {
    expect(new TestInterceptor().name).toBe('test');
  });

  it('uses the base default onDeactivate when a subclass does not override it', () => {
    class Minimal extends InterceptorBase<Stages> {
      readonly name = 'minimal';
      protected onActivate(): void {}
    }
    const ic = new Minimal();
    ic.start();
    expect(() => ic.stop()).not.toThrow();
  });
});

describe('InterceptorBase — subscriber-presence activation', () => {
  it('activates on the first subscriber and deactivates when the last leaves', () => {
    const ic = new TestInterceptor();
    const off = ic.on('tick', () => {});
    expect(ic.activations).toBe(1);
    off();
    expect(ic.deactivations).toBe(1);
  });

  it('stays active across an explicit stop() while a subscriber remains', () => {
    const ic = new TestInterceptor();
    ic.start();
    ic.on('tick', () => {});
    expect(ic.activations).toBe(1);
    ic.stop(); // subscriber still present → still active
    expect(ic.deactivations).toBe(0);
  });

  it('stays active across unsubscribe while explicitly started', () => {
    const ic = new TestInterceptor();
    ic.start();
    const off = ic.on('tick', () => {});
    off(); // still started → still active
    expect(ic.deactivations).toBe(0);
  });

  it('deactivates only when both the explicit start and the last subscriber are gone', () => {
    const ic = new TestInterceptor();
    ic.start();
    const off = ic.on('tick', () => {});
    expect(ic.activations).toBe(1);
    ic.stop();
    off();
    expect(ic.deactivations).toBe(1);
  });

  it('delivers stage events to subscribers (it is an emitter)', () => {
    const ic = new TestInterceptor();
    const seen: number[] = [];
    ic.on('tick', (n) => seen.push(n));
    ic.fireTick(1);
    ic.fireTick(2);
    expect(seen).toEqual([1, 2]);
  });

  it('does not re-activate on a second subscriber', () => {
    const ic = new TestInterceptor();
    ic.on('tick', () => {});
    const off2 = ic.on('tick', () => {});
    expect(ic.activations).toBe(1);
    off2();
    expect(ic.deactivations).toBe(0); // one subscriber remains
  });
});
