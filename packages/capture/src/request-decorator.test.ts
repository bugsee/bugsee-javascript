import { describe, expect, it } from 'vitest';
import { createRequestDecoratorRegistry, type OutgoingRequest } from './request-decorator';

const req = (over: Partial<OutgoingRequest> = {}): OutgoingRequest => ({
  url: 'https://x/a',
  method: 'GET',
  headers: {},
  ...over,
});

describe('createRequestDecoratorRegistry', () => {
  it('returns undefined when no decorator is registered', () => {
    expect(createRequestDecoratorRegistry().run(req())).toBeUndefined();
  });

  it('returns undefined when every decorator returns nothing', () => {
    const r = createRequestDecoratorRegistry();
    r.addRequestDecorator(() => undefined);
    r.addRequestDecorator(() => {});
    expect(r.run(req())).toBeUndefined();
  });

  it('merges header additions across decorators (later wins on a key collision)', () => {
    const r = createRequestDecoratorRegistry();
    r.addRequestDecorator(() => ({ a: '1', shared: 'first' }));
    r.addRequestDecorator(() => ({ b: '2', shared: 'second' }));
    expect(r.run(req())).toEqual({ a: '1', b: '2', shared: 'second' });
  });

  it('passes the request to each decorator', () => {
    const r = createRequestDecoratorRegistry();
    const seen: OutgoingRequest[] = [];
    r.addRequestDecorator((x) => {
      seen.push({ url: x.url, method: x.method, headers: { ...x.headers } });
      return undefined;
    });
    r.run(req({ url: 'u', method: 'POST', headers: { h: '1' } }));
    expect(seen[0]).toEqual({ url: 'u', method: 'POST', headers: { h: '1' } });
  });

  it('unsubscribe removes the decorator, and a second unsubscribe is a no-op', () => {
    const r = createRequestDecoratorRegistry();
    const off = r.addRequestDecorator(() => ({ a: '1' }));
    expect(r.run(req())).toEqual({ a: '1' });
    off();
    expect(r.run(req())).toBeUndefined();
    off(); // already removed → no-op
    expect(r.run(req())).toBeUndefined();
  });
});
