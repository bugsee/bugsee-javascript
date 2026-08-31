import { describe, expect, it, vi } from 'vitest';

import { absolutizeUrl, resolveBaseUrl, type UrlBaseGlobals } from './absolutize-url';

// REALMS. vitest cannot boot a real `Window`, `DedicatedWorkerGlobalScope` or `ServiceWorkerGlobalScope`
// — there is one `globalThis` per worker process and no way to swap its prototype for a spec realm. What
// distinguishes the realms for THIS code is exactly which globals exist and what they hold, and that is
// what the probe keys off, so each realm is expressed as an injected globals object of that realm's shape:
// a page HAS `document`, a worker does NOT. The injection seam is the honest form of the distinction; the
// two `globalThis` tests at the bottom prove the default probe reads the real globals it claims to.
const pageRealm = (baseURI: string, href = baseURI): UrlBaseGlobals => ({
  document: { baseURI },
  location: { href },
});
/** Dedicated OR service worker: no `document`; `location.href` is the WORKER SCRIPT's URL. */
const workerRealm = (href: string): UrlBaseGlobals => ({ location: { href } });
const bareRealm = (): UrlBaseGlobals => ({});

describe('resolveBaseUrl — the base is the one the RUNTIME itself would use', () => {
  it('prefers document.baseURI in a page realm', () => {
    expect(resolveBaseUrl(pageRealm('https://app.example.com/dir/'))).toBe(
      'https://app.example.com/dir/',
    );
  });

  it('honours a <base href> pointing at a DIFFERENT origin than location', () => {
    // The whole reason baseURI outranks location.href: a page carrying
    // `<base href="https://cdn.example.com/">` resolves every relative URL against the CDN, so
    // location.href would assert an origin the request never touched.
    const realm: UrlBaseGlobals = {
      document: { baseURI: 'https://cdn.example.com/assets/' },
      location: { href: 'https://app.example.com/page.html' },
    };
    expect(resolveBaseUrl(realm)).toBe('https://cdn.example.com/assets/');
  });

  it('falls back to location.href in a worker realm (no document)', () => {
    expect(resolveBaseUrl(workerRealm('https://sw.example.com/sw.js'))).toBe(
      'https://sw.example.com/sw.js',
    );
  });

  it('falls back to location.href when document exists but carries no baseURI', () => {
    // jsdom-ish / partial DOM shims: `document` present, `baseURI` missing.
    expect(resolveBaseUrl({ document: {}, location: { href: 'https://a.io/p' } })).toBe(
      'https://a.io/p',
    );
  });

  it('ignores a non-string baseURI and falls back to location.href', () => {
    expect(
      resolveBaseUrl({ document: { baseURI: 42 }, location: { href: 'https://a.io/p' } }),
    ).toBe('https://a.io/p');
  });

  it('ignores an EMPTY baseURI and falls back to location.href', () => {
    // `new URL(x, '')` throws, so an empty base is no base at all.
    expect(
      resolveBaseUrl({ document: { baseURI: '' }, location: { href: 'https://a.io/p' } }),
    ).toBe('https://a.io/p');
  });

  it('ignores a non-string location.href', () => {
    expect(resolveBaseUrl({ location: { href: {} } })).toBeUndefined();
  });

  it('ignores an empty location.href', () => {
    expect(resolveBaseUrl({ location: { href: '' } })).toBeUndefined();
  });

  it('returns undefined in a bare realm (node/bun/deno: no document, no location)', () => {
    expect(resolveBaseUrl(bareRealm())).toBeUndefined();
  });

  it('never throws on a hostile baseURI getter — it falls through to location', () => {
    const realm = {
      document: {
        get baseURI(): string {
          throw new Error('hostile baseURI');
        },
      },
      location: { href: 'https://a.io/p' },
    } as UrlBaseGlobals;
    expect(resolveBaseUrl(realm)).toBe('https://a.io/p');
  });

  it('never throws on a hostile location getter — it yields no base', () => {
    const realm = {
      get location(): { href: string } {
        throw new Error('hostile location');
      },
    } as UrlBaseGlobals;
    expect(resolveBaseUrl(realm)).toBeUndefined();
  });
});

describe('absolutizeUrl — resolves relative targets against that base', () => {
  it('absolutizes a root-relative path in a page realm', () => {
    expect(absolutizeUrl('/api/scenario/get', pageRealm('https://app.example.com/dir/'))).toBe(
      'https://app.example.com/api/scenario/get',
    );
  });

  it('absolutizes a path-relative target against the base DIRECTORY', () => {
    expect(absolutizeUrl('scenario/get', pageRealm('https://app.example.com/dir/'))).toBe(
      'https://app.example.com/dir/scenario/get',
    );
  });

  it('keeps a non-default port', () => {
    // The product ask names the port explicitly: `/api` on :5398 must come out on :5398.
    expect(absolutizeUrl('/api', pageRealm('http://localhost:5398/index.html'))).toBe(
      'http://localhost:5398/api',
    );
  });

  it('absolutizes a query-only target', () => {
    expect(absolutizeUrl('?q=1', pageRealm('https://a.io/dir/page'))).toBe(
      'https://a.io/dir/page?q=1',
    );
  });

  it('resolves against the <base href> origin, not location', () => {
    const realm: UrlBaseGlobals = {
      document: { baseURI: 'https://cdn.example.com/assets/' },
      location: { href: 'https://app.example.com/page.html' },
    };
    expect(absolutizeUrl('/api/x', realm)).toBe('https://cdn.example.com/api/x');
  });
});

describe('absolutizeUrl — pass-throughs must be BYTE-IDENTICAL', () => {
  const realm = pageRealm('https://app.example.com/dir/');
  // Anything already carrying a scheme is returned by identity — never round-tripped through `new URL`,
  // whose `.href` normalizes (lowercases the host, appends a root `/`, drops a default port,
  // percent-encodes). That normalization would rewrite URLs the app never wrote.
  const absolutes = [
    'https://other.example.com/x?a=1#f',
    'http://Other.Example.COM:80/X', // would be lowercased + :80-stripped by new URL().href
    'https://api.example.com', // would gain a trailing '/' by new URL().href
    'ws://rt.example.com/socket',
    'wss://rt.example.com/socket?token=t',
    'data:text/plain;base64,aGk=',
    'blob:https://app.example.com/9b2c-uuid',
    'mailto:bob@example.com',
    // The WITNESS for "identity, not round-trip", and for schemes with NO `//`. Every other entry above
    // happens to survive `new URL().href` untouched, so narrowing the scheme test to require `//` —
    // dropping `data:`, `blob:`, `mailto:` out of the short-circuit — was invisible until this case:
    // `new URL('mailto:…?subject=hi there').href` percent-encodes the space.
    'mailto:bob@example.com?subject=hi there',
    'chrome-extension://abcdef/panel.js',
  ];
  for (const url of absolutes) {
    it(`returns ${url} unchanged`, () => {
      expect(absolutizeUrl(url, realm)).toBe(url);
    });
  }

  it('is idempotent — absolutizing twice equals absolutizing once', () => {
    const once = absolutizeUrl('/api/x', realm);
    expect(absolutizeUrl(once, realm)).toBe(once);
  });
});

describe('absolutizeUrl — safety valve: a WRONG origin is worse than a missing one', () => {
  it('returns the raw string when there is no base at all', () => {
    expect(absolutizeUrl('/api/scenario/get', bareRealm())).toBe('/api/scenario/get');
  });

  it('does not even construct a URL when there is no base', () => {
    // The `base === undefined` guard is NOT redundant with the catch below it, even though both yield
    // the raw string: without the guard, `new URL(url, undefined)` THROWS on every call, and the
    // location-less hosts (node/bun/deno) are the ones where every single captured request takes this
    // path. Constructing-and-throwing per request is a cost that never shows up in an output assertion,
    // so it is asserted directly here.
    type Ctor = new (url: string, base?: string) => { href: string };
    const g = globalThis as unknown as { URL: Ctor };
    const real: Ctor = g.URL;
    const spy = vi.fn();
    class CountingUrl {
      readonly href: string;
      constructor(url: string, base?: string) {
        spy(url, base);
        this.href = new real(url, base).href;
      }
    }
    g.URL = CountingUrl;
    try {
      expect(absolutizeUrl('/api/x', bareRealm())).toBe('/api/x');
      expect(spy).not.toHaveBeenCalled();
      // …and it IS constructed when a base exists, so the assertion above cannot pass vacuously.
      expect(absolutizeUrl('/api/x', pageRealm('https://a.io/'))).toBe('https://a.io/api/x');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      g.URL = real;
    }
  });

  it('returns the raw string when the base itself is unparseable', () => {
    expect(absolutizeUrl('/api/x', workerRealm('not a url'))).toBe('/api/x');
  });

  it('returns the raw string for an unparseable target even though the base is fine', () => {
    // `//` is a protocol-relative URL with no host: it does NOT carry a scheme, so it reaches the
    // resolver, and `new URL('//', 'https://a.io/')` throws. This is the ONLY route into the catch that
    // is not a bad base, so it is what proves the resolver's own failure is contained.
    expect(absolutizeUrl('//', pageRealm('https://a.io/'))).toBe('//');
    expect(absolutizeUrl('///', pageRealm('https://a.io/'))).toBe('///');
  });

  it('returns a scheme-only string unchanged, without ever reaching the resolver', () => {
    // `http://` matches the scheme test and short-circuits; `new URL('http://', base)` would throw.
    expect(absolutizeUrl('http://', pageRealm('https://a.io/'))).toBe('http://');
  });

  it('returns an empty url unchanged rather than inventing the base', () => {
    // fetch('') really does resolve to the base, but an empty captured url is a producer bug, not a
    // request — synthesizing an origin for it would assert a target nothing contacted.
    expect(absolutizeUrl('', pageRealm('https://a.io/dir/'))).toBe('');
  });

  it('never throws for any input shape', () => {
    for (const raw of ['', '/', '//', '?', '#', '://', 'http://', '\\\\x', '%%%', 'a b c']) {
      expect(() => absolutizeUrl(raw, pageRealm('https://a.io/dir/'))).not.toThrow();
    }
  });
});

describe('absolutizeUrl — protocol-relative //host/path', () => {
  // DECISION: `//cdn.example.com/x` IS absolutized, gaining the base's scheme. It is not a pass-through.
  // The runtime resolves a protocol-relative URL against the base's scheme, so `https://cdn…/x` is
  // literally the origin that was contacted — and "add the protocol" is the product ask. The host and
  // path are untouched; only the scheme the request already used is made explicit.
  it('gains the base scheme, keeping host and path', () => {
    expect(absolutizeUrl('//cdn.example.com/x', pageRealm('https://app.example.com/dir/'))).toBe(
      'https://cdn.example.com/x',
    );
  });

  it('inherits an http base rather than defaulting to https', () => {
    expect(absolutizeUrl('//cdn.example.com/x', pageRealm('http://app.example.com/dir/'))).toBe(
      'http://cdn.example.com/x',
    );
  });

  it('is left alone when there is no base to take a scheme from', () => {
    expect(absolutizeUrl('//cdn.example.com/x', bareRealm())).toBe('//cdn.example.com/x');
  });
});

describe('absolutizeUrl — service worker realm', () => {
  // The SW script may be served from a different host/path than the pages it controls. `location.href`
  // is the SW SCRIPT's URL, and that is what the SW's OWN relative fetches resolve against — so it is
  // the base. `registration.scope` is deliberately NEVER consulted: it is not what relative resolution
  // uses, and borrowing it would assert an origin the request never touched.
  const sw = workerRealm('https://sw-host.example.com/workers/sw.js');

  it("resolves the SW's own relative fetch against the SW SCRIPT url, not the controlled page", () => {
    expect(absolutizeUrl('/api/scenario/get', sw)).toBe(
      'https://sw-host.example.com/api/scenario/get',
    );
  });

  it('resolves a path-relative target against the SW script DIRECTORY', () => {
    expect(absolutizeUrl('cache-manifest.json', sw)).toBe(
      'https://sw-host.example.com/workers/cache-manifest.json',
    );
  });

  it('passes an already-absolute CROSS-ORIGIN observed request through byte-identical', () => {
    // A SW sees requests for other origins via its `fetch` event; `event.request.url` is already
    // absolute. Re-resolving it against the SW base would be a silent origin rewrite.
    const observed = 'https://third-party.example.net/collect?a=1';
    expect(absolutizeUrl(observed, sw)).toBe(observed);
  });

  it('never borrows a scope-like base — no document is consulted in a worker realm', () => {
    // Belt and braces: even if a `document` somehow leaks onto a worker global (a bundler shim, a
    // polyfill), a realm WITHOUT one must resolve from location alone.
    expect(resolveBaseUrl(sw)).toBe('https://sw-host.example.com/workers/sw.js');
  });
});

describe('absolutizeUrl — the default probe reads the real globals', () => {
  const withGlobals = <T>(patch: Record<string, unknown>, run: () => T): T => {
    const g = globalThis as unknown as Record<string, unknown>;
    const had = new Map<string, { present: boolean; value: unknown }>();
    for (const [k, v] of Object.entries(patch)) {
      had.set(k, { present: k in g, value: g[k] });
      g[k] = v;
    }
    try {
      return run();
    } finally {
      for (const [k, prev] of had) {
        if (prev.present) {
          g[k] = prev.value;
        } else {
          delete g[k];
        }
      }
    }
  };

  it('uses globalThis.document.baseURI when no realm is injected', () => {
    expect(
      withGlobals({ document: { baseURI: 'https://real-global.example.com/app/' } }, () =>
        absolutizeUrl('api/x'),
      ),
    ).toBe('https://real-global.example.com/app/api/x');
  });

  it('uses globalThis.location.href when no realm is injected and there is no document', () => {
    expect(
      withGlobals({ location: { href: 'https://real-worker.example.com/w/sw.js' } }, () =>
        absolutizeUrl('/api/x'),
      ),
    ).toBe('https://real-worker.example.com/api/x');
  });

  it('returns the raw url on a bare host (node: no document, no location)', () => {
    // Guards the server tiers: node/bun/deno define neither global, so an incoming request target
    // captured as `/api/x` must stay `/api/x` — there is no client origin to attach to it.
    expect((globalThis as unknown as { document?: unknown }).document).toBeUndefined();
    expect((globalThis as unknown as { location?: unknown }).location).toBeUndefined();
    expect(absolutizeUrl('/api/x')).toBe('/api/x');
  });
});
