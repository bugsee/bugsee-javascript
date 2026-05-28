import { describe, expect, it, vi } from 'vitest';
import type { Client } from './contracts';
import { InterceptorBase } from './interceptor-base';

interface Stages {
  tick: number;
  done: string;
}

class TestInterceptor extends InterceptorBase<Stages> {
  readonly name = 'test';
  startedWith: Client | null = null;
  stopped = 0;

  protected onStart(client: Client): void {
    this.startedWith = client;
  }
  protected override onStop(): void {
    this.stopped += 1;
  }

  // expose emit (protected-by-contract) so the test can drive a stage
  fireTick(n: number): void {
    this.emit('tick', n);
  }
}

const client = { tag: 'client' } as unknown as Client;

describe('InterceptorBase — lifecycle', () => {
  it('start passes the client to onStart', () => {
    const ic = new TestInterceptor();
    ic.start(client);
    expect(ic.startedWith).toBe(client);
  });

  it('stop calls onStop', () => {
    const ic = new TestInterceptor();
    ic.start(client);
    ic.stop();
    expect(ic.stopped).toBe(1);
  });

  it('exposes the subclass name', () => {
    expect(new TestInterceptor().name).toBe('test');
  });

  it('uses the base default onStop when a subclass does not override it', () => {
    class Minimal extends InterceptorBase<Stages> {
      readonly name = 'minimal';
      protected onStart(): void {}
    }
    const ic = new Minimal();
    ic.start(client);
    expect(() => ic.stop()).not.toThrow();
  });
});

describe('InterceptorBase — listenable (inherits the multi-key emitter)', () => {
  it('lets a subscriber observe a stage via on()', () => {
    const ic = new TestInterceptor();
    const seen: number[] = [];
    ic.on('tick', (n) => seen.push(n));
    ic.fireTick(1);
    ic.fireTick(2);
    expect(seen).toEqual([1, 2]);
  });

  it('off() (and the on() unsubscribe) stop delivery', () => {
    const ic = new TestInterceptor();
    const fn = vi.fn();
    const off = ic.on('tick', fn);
    off();
    ic.fireTick(1);
    expect(fn).not.toHaveBeenCalled();
  });
});
