import { describe, expect, it, vi } from 'vitest';
import type { NavigationDetail } from './navigation-source';
import {
  navigationSourceFor,
  UrlProducer,
  type UrlProducerDeps,
  urlProducerDepsFor,
} from './url-producer';

type Emit = { name: string; value: unknown; hold: boolean | undefined };

function setup(over: Partial<UrlProducerDeps> & { initial?: string | undefined } = {}) {
  const emits: Emit[] = [];
  const sink = {
    emit: (name: string, value: unknown, _d?: number, o?: { hold?: boolean }) =>
      void emits.push({ name, value, hold: o?.hold }),
  };
  let handler: ((d: NavigationDetail) => void) | undefined;
  const off = vi.fn();
  const source = {
    on: vi.fn((_stage: 'navigate', h: (d: NavigationDetail) => void) => {
      handler = h;
      return off;
    }),
  };
  const errors: unknown[] = [];
  const { initial, ...rest } = over;
  const producer = new UrlProducer({
    source,
    read: () => ('initial' in over ? initial : 'https://a.com/start'),
    onError: (e) => errors.push(e),
    ...rest,
  });
  const navigate = (href: string | undefined, source: NavigationDetail['source'] = 'url') =>
    handler?.({
      to: '/x',
      navigationType: 'push',
      source,
      ...(href !== undefined ? { href } : {}),
    });
  return { producer, emits, sink, navigate, off, source, errors };
}

describe('UrlProducer', () => {
  it('is named `url` and emits nothing until started', () => {
    const { producer, emits, source } = setup();
    expect(producer.name).toBe('url');
    expect(emits).toEqual([]);
    expect(source.on).not.toHaveBeenCalled();
  });

  it('writes the SANITIZED current location at start, HELD (emitIfChanged)', () => {
    const { producer, emits, sink } = setup({ initial: 'https://a.com/o/42?token=abc&tab=items' });
    producer.start(sink);
    expect(emits).toEqual([
      { name: 'url', value: 'https://a.com/o/42?token=%3Credacted%3E&tab=items', hold: true },
    ]);
  });

  it('writes every navigation, sanitized, and de-duplicates consecutive equal values', () => {
    const { producer, emits, sink, navigate } = setup();
    producer.start(sink);
    navigate('https://a.com/b?api_key=1');
    navigate('https://a.com/b?api_key=2'); // equal AFTER sanitizing: not written again
    navigate('https://a.com/c');
    expect(emits.map((e) => e.value)).toEqual([
      'https://a.com/start',
      'https://a.com/b?api_key=%3Credacted%3E',
      'https://a.com/c',
    ]);
  });

  it('applies scheme handling (a data: location is never written)', () => {
    const { producer, emits, sink } = setup({ initial: 'data:text/plain;token=abc,hello' });
    producer.start(sink);
    expect(emits[0]?.value).toBe('data:%3Credacted%3E');
  });

  it('ignores a navigation without an address and an adapter-emitted one', () => {
    const { producer, emits, sink, navigate } = setup();
    producer.start(sink);
    navigate(undefined);
    navigate('https://a.com/adapter', 'route');
    navigate('https://a.com/adapter2', 'custom');
    expect(emits).toHaveLength(1); // the start value only
  });

  it('writes nothing at start when the location cannot be read', () => {
    const { producer, emits, sink } = setup({ initial: undefined });
    producer.start(sink);
    expect(emits).toEqual([]);
  });

  it('unsubscribes on stop, and stop() is idempotent', () => {
    const { producer, sink, off } = setup();
    producer.start(sink);
    producer.stop();
    producer.stop();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('a stopped producer that is started again writes its baseline again', () => {
    const { producer, emits, sink } = setup();
    producer.start(sink);
    producer.stop();
    producer.start(sink);
    expect(emits).toHaveLength(2);
  });

  describe('urlSanitizer hook (runs AFTER the default; its result is written as given)', () => {
    it('receives the default-sanitized URL, never the raw one', () => {
      const hook = vi.fn((u: string) => u);
      const { producer, sink } = setup({
        initial: 'https://u:pw@a.com/p?token=abc',
        urlSanitizer: hook,
      });
      producer.start(sink);
      expect(hook).toHaveBeenCalledWith('https://u:%3Credacted%3E@a.com/p?token=%3Credacted%3E');
    });

    it('writes the hook result as given', () => {
      const { producer, emits, sink } = setup({
        urlSanitizer: (u) => u.replace('/start', '/custom'),
      });
      producer.start(sink);
      expect(emits[0]?.value).toBe('https://a.com/custom');
    });

    it('clips a result over 2048 characters and marks it', () => {
      const { producer, emits, sink } = setup({ urlSanitizer: () => 'x'.repeat(5_000_000) });
      producer.start(sink);
      const value = emits[0]?.value as string;
      expect(value).toBe(`${'x'.repeat(2048)}%3Ctruncated%3E`);
    });

    it('a result of exactly 2048 characters is written whole', () => {
      const { producer, emits, sink } = setup({ urlSanitizer: () => 'y'.repeat(2048) });
      producer.start(sink);
      expect(emits[0]?.value).toBe('y'.repeat(2048));
    });

    it('when the hook drops or throws, the PREVIOUS value stays (nothing new is written)', () => {
      let mode: 'ok' | 'null' | 'throw' = 'ok';
      const { producer, emits, sink, navigate } = setup({
        urlSanitizer: (u) => {
          if (mode === 'throw') throw new Error('x');
          return mode === 'null' ? null : u;
        },
      });
      producer.start(sink);
      mode = 'null';
      navigate('https://a.com/two');
      mode = 'throw';
      navigate('https://a.com/three');
      expect(emits.map((e) => e.value)).toEqual(['https://a.com/start']);
    });

    it('null drops this URL: nothing is written and nothing is reported', () => {
      const { producer, emits, sink, errors } = setup({ urlSanitizer: () => null });
      producer.start(sink);
      expect(emits).toEqual([]);
      expect(errors).toEqual([]);
    });

    it('a throwing hook is reported, writes NOTHING (fail closed) and never throws into the host', () => {
      const boom = new Error('boom');
      const { producer, emits, sink, errors, navigate } = setup({
        urlSanitizer: () => {
          throw boom;
        },
      });
      expect(() => producer.start(sink)).not.toThrow();
      expect(() => navigate('https://a.com/n')).not.toThrow();
      expect(emits).toEqual([]);
      expect(errors).toEqual([boom, boom]);
    });

    it('a hook returning a non-string is reported and writes nothing', () => {
      const { producer, emits, sink, errors } = setup({
        urlSanitizer: (() => 42) as unknown as UrlProducerDeps['urlSanitizer'],
      });
      producer.start(sink);
      expect(emits).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain('urlSanitizer');
    });

    it('a throwing reporter is contained too', () => {
      const { producer, sink } = setup({
        urlSanitizer: () => {
          throw new Error('x');
        },
        onError: () => {
          throw new Error('reporter');
        },
      });
      expect(() => producer.start(sink)).not.toThrow();
    });
  });
});

describe('navigationSourceFor', () => {
  it('is undefined without a window', () => {
    expect(navigationSourceFor(undefined)).toBeUndefined();
  });

  it('is ONE instance per carrier, however many consumers ask (and the default carrier works)', () => {
    const carrier = {};
    const win = { addEventListener: () => {}, removeEventListener: () => {} };
    const a = navigationSourceFor(win, { carrier });
    expect(a).toBeDefined();
    expect(navigationSourceFor(win, { carrier })).toBe(a);
  });

  it('reports a window it cannot read and answers undefined', () => {
    const onError = vi.fn();
    const win = {
      get history(): never {
        throw new Error('torn down');
      },
    };
    expect(navigationSourceFor(win, { carrier: {}, onError })).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('urlProducerDepsFor', () => {
  const fakeWindow = () => {
    const listeners = new Map<string, Set<() => void>>();
    return {
      history: { pushState: vi.fn(), replaceState: vi.fn() },
      location: { pathname: '/a', href: 'https://a.com/a?token=1' },
      addEventListener: (t: string, l: () => void) => {
        (listeners.get(t) ?? listeners.set(t, new Set()).get(t))?.add(l);
      },
      removeEventListener: (t: string, l: () => void) => void listeners.get(t)?.delete(l),
      fire: (t: string) => {
        for (const l of listeners.get(t) ?? []) l();
      },
    };
  };

  it("reads the window's own location and listens to the window's own navigations", () => {
    const win = fakeWindow();
    const deps = urlProducerDepsFor(win, { carrier: {} });
    expect(deps?.read()).toBe('https://a.com/a?token=1');
    const seen: NavigationDetail[] = [];
    const off = deps?.source.on('navigate', (d) => seen.push(d));
    win.location.href = 'https://a.com/b';
    win.location.pathname = '/b';
    win.fire('popstate');
    off?.();
    expect(seen).toEqual([
      { to: '/b', navigationType: 'traverse', source: 'url', href: 'https://a.com/b' },
    ]);
  });

  it('shares ONE navigation source per carrier (history is patched once)', () => {
    const carrier = {};
    const first = urlProducerDepsFor(fakeWindow(), { carrier });
    const second = urlProducerDepsFor(fakeWindow(), { carrier });
    expect(second?.source).toBe(first?.source);
    expect(urlProducerDepsFor(fakeWindow(), { carrier: {} })?.source).not.toBe(first?.source);
  });

  it('a window without a location reads undefined; a non-string href too', () => {
    expect(urlProducerDepsFor({}, { carrier: {} })?.read()).toBeUndefined();
    expect(urlProducerDepsFor({ location: { href: 5 } }, { carrier: {} })?.read()).toBeUndefined();
  });

  it('never borrows the HOST history for a window that has none (isolated source)', () => {
    const pushState = vi.fn();
    vi.stubGlobal('history', { pushState, replaceState: vi.fn() });
    try {
      const deps = urlProducerDepsFor({ location: { href: 'https://a.com/' } }, { carrier: {} });
      const off = deps?.source.on('navigate', () => {});
      expect((globalThis as { history: { pushState: unknown } }).history.pushState).toBe(pushState);
      off?.();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ['history without its methods', { history: {} }],
    ['a null history', { history: null }],
    ['a window that cannot listen', { location: { href: 'https://a.com/' } }],
    ['a navigation without listeners', { navigation: {} }],
  ])('a partial window (%s) loses that detection but activation never throws', (_n, win) => {
    const deps = urlProducerDepsFor(win, { carrier: {} });
    expect(() => deps?.source.on('navigate', () => {})()).not.toThrow();
  });

  it('no window, no url trace', () => {
    expect(urlProducerDepsFor(undefined, {})).toBeUndefined();
  });

  it('a location that starts throwing later is reported by read(), which answers undefined', () => {
    const onError = vi.fn();
    let tornDown = false;
    const win = {
      get location(): { href: string } {
        if (tornDown) throw new Error('torn down');
        return { href: 'https://a.com/' };
      },
    };
    const deps = urlProducerDepsFor(win, { carrier: {}, onError });
    expect(deps).toBeDefined();
    tornDown = true;
    expect(deps?.read()).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a location getter that throws at creation yields no url trace, reported', () => {
    const onError = vi.fn();
    const win = {
      get location(): never {
        throw new Error('cross-origin');
      },
    };
    expect(urlProducerDepsFor(win, { carrier: {}, onError })).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a window whose history getter throws yields no url trace, reported, never thrown', () => {
    const onError = vi.fn();
    const win = {
      get history(): never {
        throw new Error('torn down');
      },
    };
    expect(urlProducerDepsFor(win, { carrier: {}, onError })).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('passes a function urlSanitizer through; ignores and reports anything else', () => {
    const hook = (u: string) => u;
    expect(urlProducerDepsFor({}, { carrier: {}, urlSanitizer: hook })?.urlSanitizer).toBe(hook);
    const onError = vi.fn();
    const deps = urlProducerDepsFor({}, { carrier: {}, urlSanitizer: 'nope', onError });
    expect(deps).toBeDefined();
    expect(deps?.urlSanitizer).toBeUndefined();
    expect(String(onError.mock.calls[0]?.[0])).toMatch(/urlSanitizer must be a function/);
  });

  it('hands onError to the producer when given', () => {
    const onError = vi.fn();
    expect(urlProducerDepsFor({}, { carrier: {}, onError })?.onError).toBe(onError);
  });
});
