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

  // A decorator runs INLINE in the app's own fetch()/xhr.send(). Whatever it does must never become the
  // app's outcome: a throw here used to propagate out of the patched call, so the app's request failed
  // (fetch threw synchronously; send() threw) because of Bugsee — including our own propagation
  // decorator, which reads the active span through the performance extension.
  describe('a misbehaving decorator can never break the request', () => {
    it("skips a throwing decorator and keeps every sibling's additions", () => {
      const r = createRequestDecoratorRegistry();
      r.addRequestDecorator(() => ({ a: '1' }));
      r.addRequestDecorator(() => {
        throw new Error('decorator bug');
      });
      r.addRequestDecorator(() => ({ b: '2' }));
      expect(r.run(req())).toEqual({ a: '1', b: '2' });
    });

    it('returns undefined when the only decorator throws', () => {
      const r = createRequestDecoratorRegistry();
      r.addRequestDecorator(() => {
        throw new Error('decorator bug');
      });
      expect(r.run(req())).toBeUndefined();
    });

    it('takes NOTHING from a result that throws while being read — not even the keys read before the throw', () => {
      const r = createRequestDecoratorRegistry();
      r.addRequestDecorator(() => ({ keep: '1' }));
      r.addRequestDecorator(
        () =>
          ({
            partial: 'x',
            get boom(): string {
              throw new Error('hostile getter');
            },
          }) as unknown as Record<string, string>,
      );
      expect(r.run(req())).toEqual({ keep: '1' });
    });

    it('ignores a result that is not an object', () => {
      const r = createRequestDecoratorRegistry();
      r.addRequestDecorator(() => 'traceparent' as unknown as Record<string, string>);
      r.addRequestDecorator(() => ({ a: '1' }));
      expect(r.run(req())).toEqual({ a: '1' });
    });

    // The browser REJECTS these synchronously (`setRequestHeader` throws SyntaxError, `new Headers` a
    // TypeError), so passing one through would fail the app's request just as a throw would.
    it.each([
      ['a name with a space', { 'bad name': 'v' }],
      ['an empty name', { '': 'v' }],
      ['a name with a colon', { 'x:y': 'v' }],
      ['a non-ASCII name', { naïve: 'v' }],
      ['a value with CR/LF (header injection)', { h: 'v\r\nset-cookie: x' }],
      ['a value with a bare LF', { h: 'v\nx' }],
      ['a value with a bare CR', { h: 'v\rx' }],
      ['a value with a NUL', { h: 'v\u0000' }],
      ['a non-string value', { h: 42 as unknown as string }],
      ['a value outside Latin-1 (not a ByteString)', { h: 'price €5' }],
    ])('drops %s but keeps the valid headers beside it', (_label, bad) => {
      const r = createRequestDecoratorRegistry();
      r.addRequestDecorator(() => ({ ...bad, good: 'ok' }));
      expect(r.run(req())).toEqual({ good: 'ok' });
    });

    it('accepts every RFC 9110 token character in a name, and tabs/obs-text/other controls in a value', () => {
      const r = createRequestDecoratorRegistry();
      r.addRequestDecorator(() => ({ "!#$%&'*+-.^_`|~09AZaz": 'a\tb \u00ff\u0001' }));
      expect(r.run(req())).toEqual({ "!#$%&'*+-.^_`|~09AZaz": 'a\tb \u00ff\u0001' });
    });

    it('runs every decorator registered at the START of the run, even if one unsubscribes itself', () => {
      const r = createRequestDecoratorRegistry();
      let off: () => void = () => {};
      off = r.addRequestDecorator(() => {
        off();
        return { first: '1' };
      });
      r.addRequestDecorator(() => ({ second: '2' }));
      expect(r.run(req())).toEqual({ first: '1', second: '2' });
    });
  });
});
