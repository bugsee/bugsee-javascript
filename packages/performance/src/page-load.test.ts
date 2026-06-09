import type { Clock } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { createPerformanceController } from './controller';
import { collectNavigationTiming, collectPageLoadVitals, collectResourceTiming } from './page-load';
import type { RecordChildSpanOptions } from './span';
import { createTransactionStore } from './transaction-store';
import type { PerformanceEntryLike, WebVitalsEnv } from './web-vitals/env';

const entry = (
  over: Partial<PerformanceEntryLike> & Record<string, unknown>,
): PerformanceEntryLike =>
  ({ name: '', entryType: 'x', startTime: 0, duration: 0, ...over }) as never;

// A multi-type PerformanceObserver fake: instances tracked by entry type + durationThreshold.
function fakeObservers() {
  const instances: FakePO[] = [];
  class FakePO {
    static supportedEntryTypes = [
      'paint',
      'largest-contentful-paint',
      'layout-shift',
      'event',
      'first-input',
    ];
    readonly cb: (list: { getEntries(): PerformanceEntryLike[] }) => void;
    observed: { type: string; durationThreshold?: number } | undefined;
    constructor(cb: (list: { getEntries(): PerformanceEntryLike[] }) => void) {
      this.cb = cb;
      instances.push(this);
    }
    observe(o: { type: string; durationThreshold?: number }) {
      this.observed = o;
    }
    disconnect() {}
    takeRecords(): PerformanceEntryLike[] {
      return [];
    }
    emit(entries: PerformanceEntryLike[]) {
      this.cb({ getEntries: () => entries });
    }
  }
  const emit = (type: string, entries: PerformanceEntryLike[], threshold?: number) =>
    instances
      .find(
        (i) =>
          i.observed?.type === type &&
          (threshold === undefined || i.observed?.durationThreshold === threshold),
      )
      ?.emit(entries);
  return { Ctor: FakePO as never, emit };
}

function fakeTarget(extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, (() => void)[]>();
  return {
    addEventListener: (type: string, l: () => void) => {
      (listeners.get(type) ?? listeners.set(type, []).get(type))?.push(l);
    },
    emit: (type: string) => {
      for (const l of listeners.get(type) ?? []) l();
    },
    ...extra,
  };
}

const clock: Clock = { wallNow: () => 1000, monotonicNow: () => 0 };

describe('collectPageLoadVitals', () => {
  it('collects all five vitals into a finished pageload transaction', () => {
    const { Ctor, emit } = fakeObservers();
    const win = fakeTarget();
    const doc = fakeTarget({ visibilityState: 'visible' });
    const env: WebVitalsEnv = {
      PerformanceObserver: Ctor,
      performance: {
        now: () => 100_000, // well past responseStart so TTFB validates (responseStart < now)
        interactionCount: 1, // native counter → no INP polyfill observer
        getEntriesByType: (type: string) =>
          type === 'navigation'
            ? [
                entry({
                  entryType: 'navigation',
                  type: 'navigate',
                  domainLookupStart: 10,
                  domainLookupEnd: 30,
                  connectStart: 30,
                  secureConnectionStart: 50,
                  connectEnd: 80,
                  requestStart: 80,
                  responseStart: 300,
                  responseEnd: 400,
                  domInteractive: 500,
                  loadEventEnd: 800,
                }),
              ]
            : [],
      } as never,
      queueMicrotask: (cb) => cb(),
      document: doc as never,
      window: win as never,
    };
    const store = createTransactionStore();
    const api = createPerformanceController({ clock, store, appVersion: '1.0' });

    collectPageLoadVitals(env, api, { name: '/checkout' });

    // TTFB is read immediately; the paint metric reports at paint; LCP/CLS/INP stream then finalize.
    emit('paint', [entry({ entryType: 'paint', name: 'first-contentful-paint', startTime: 800 })]);
    emit('largest-contentful-paint', [
      entry({ entryType: 'largest-contentful-paint', startTime: 1500 }),
    ]);
    emit('layout-shift', [
      entry({ entryType: 'layout-shift', startTime: 0, value: 0.05, hadRecentInput: false }),
    ]);
    emit(
      'event',
      [entry({ entryType: 'event', startTime: 0, duration: 90, interactionId: 1 })],
      40,
    );
    expect(store.size()).toBe(0); // nothing buffered until the page is hidden

    win.emit('pagehide'); // LCP/CLS/INP finalize, then the transaction finishes

    const [txn] = store.drain();
    expect(txn).toMatchObject({ name: '/checkout', operation: 'pageload', appVersion: '1.0' });
    expect(txn?.attributes).toMatchObject({
      'web_vital.ttfb.value': 300,
      'web_vital.ttfb.rating': 'good',
      'web_vital.fcp.value': 800,
      'web_vital.lcp.value': 1500,
      'web_vital.lcp.rating': 'good',
      'web_vital.cls.value': 0.05,
      'web_vital.inp.value': 90,
      'web_vital.inp.rating': 'good',
      // navigation-timing breakdown collected at finalize
      'nav.dns_ms': 20,
      'nav.connect_ms': 50,
      'nav.tls_ms': 30,
      'nav.request_ms': 220,
      'nav.response_ms': 100,
      'nav.dom_interactive_ms': 500,
      'nav.load_ms': 800,
    });
  });

  it('navigation timing: emits nav.<phase>_ms durations + milestones, skipping zero/missing phases', () => {
    const attrsFor = (nav?: Record<string, unknown>) => {
      const attrs: Record<string, unknown> = {};
      const span = {
        setAttribute: (k: string, v: unknown) => {
          attrs[k] = v;
          return span;
        },
      };
      const env: WebVitalsEnv = {
        performance: {
          now: () => 0,
          getEntriesByType: (type: string) =>
            type === 'navigation' && nav ? [entry({ entryType: 'navigation', ...nav })] : [],
        } as never,
      };
      collectNavigationTiming(env, span as never);
      return attrs;
    };

    expect(
      attrsFor({
        domainLookupStart: 10,
        domainLookupEnd: 30,
        connectStart: 30,
        secureConnectionStart: 50,
        connectEnd: 80,
        requestStart: 80,
        responseStart: 300,
        responseEnd: 400,
        domInteractive: 500,
        domContentLoadedEventEnd: 600,
        loadEventEnd: 800,
      }),
    ).toEqual({
      'nav.dns_ms': 20,
      'nav.connect_ms': 50,
      'nav.tls_ms': 30,
      'nav.request_ms': 220,
      'nav.response_ms': 100,
      'nav.dom_interactive_ms': 500,
      'nav.dom_content_loaded_ms': 600,
      'nav.load_ms': 800,
    });

    // cache hit (dns 0), no TLS (secureConnectionStart 0), HTML still streaming (responseEnd 0) → skipped
    expect(
      attrsFor({
        domainLookupStart: 0,
        domainLookupEnd: 0,
        connectStart: 30,
        connectEnd: 80,
        secureConnectionStart: 0,
        requestStart: 80,
        responseStart: 300,
        responseEnd: 0,
      }),
    ).toEqual({ 'nav.connect_ms': 50, 'nav.request_ms': 220 });

    // a phase whose end precedes its start (clock anomaly) → skipped, never a negative duration
    expect(attrsFor({ requestStart: 500, responseStart: 100 })).toEqual({});

    expect(attrsFor()).toEqual({}); // no navigation entry → nothing
  });

  it('resource timing: records resource.<initiatorType> spans with normalized url + size/status attrs', () => {
    const recordOn = (resources: Record<string, unknown>[], timeOrigin = 1000) => {
      const calls: { op: string; opts: RecordChildSpanOptions }[] = [];
      const span = {
        recordChildSpan: (op: string, opts: RecordChildSpanOptions) => {
          calls.push({ op, opts });
        },
      };
      const env: WebVitalsEnv = {
        performance: {
          now: () => 0,
          timeOrigin,
          getEntriesByType: (type: string) =>
            type === 'resource' ? resources.map((r) => entry({ entryType: 'resource', ...r })) : [],
        } as never,
      };
      collectResourceTiming(env, span as never);
      return calls;
    };

    // a normal asset → resource.<type> span with times (timeOrigin + start .. +duration), cleaned url, attrs
    expect(
      recordOn([
        {
          name: 'https://x.test/app.js?v=2#h',
          startTime: 10,
          duration: 40,
          initiatorType: 'script',
          responseStatus: 200,
          transferSize: 5000,
          encodedBodySize: 4000,
          decodedBodySize: 9000,
        },
      ]),
    ).toEqual([
      {
        op: 'resource.script',
        opts: {
          startTimestampMs: 1010,
          endTimestampMs: 1050,
          description: 'https://x.test/app.js', // query + fragment stripped
          attributes: {
            'http.status_code': 200,
            'http.transfer_size': 5000,
            'http.encoded_body_size': 4000,
            'http.decoded_body_size': 9000,
          },
        },
      },
    ]);

    // fetch/xhr are skipped (deduped by the http instrumentation); a no-initiatorType resource → other.
    expect(
      recordOn([
        { name: 'a', startTime: 0, duration: 1, initiatorType: 'fetch' },
        { name: 'b', startTime: 0, duration: 1, initiatorType: 'xmlhttprequest' },
        { name: 'https://x/p', startTime: 0, duration: 1 },
      ]).map((c) => c.op),
    ).toEqual(['resource.other']);

    // data:/blob: collapsed; a 0 status / 0 sizes (cross-origin opaque) yield no attributes.
    const collapsed = recordOn([
      { name: 'data:image/png;base64,AAAA', startTime: 0, duration: 1, initiatorType: 'img' },
      {
        name: 'x.js',
        startTime: 0,
        duration: 1,
        initiatorType: 'script',
        responseStatus: 0,
        transferSize: 0,
      },
    ]);
    expect(collapsed[0]?.opts.description).toBe('data:…');
    expect(collapsed[1]?.opts.attributes).toEqual({});

    // capped so a resource-heavy page can't bloat the bundle.
    expect(
      recordOn(
        Array.from({ length: 150 }, (_, i) => ({
          name: `r${i}.js`,
          startTime: 0,
          duration: 1,
          initiatorType: 'script',
        })),
      ),
    ).toHaveLength(100);
  });

  it('still finishes the pageload transaction even where the vitals APIs are absent, finalizing once', () => {
    const store = createTransactionStore();
    const api = createPerformanceController({ clock, store });
    const win = fakeTarget();
    collectPageLoadVitals({ window: win as never }, api, { name: '/' });
    expect(store.size()).toBe(0);
    win.emit('pagehide');
    win.emit('pagehide'); // a second hidden is a no-op (the finalized guard)
    const drained = store.drain();
    expect(drained).toHaveLength(1); // finished exactly once
    expect(drained[0]).toMatchObject({ name: '/', operation: 'pageload' });
    expect(drained[0]?.attributes).toBeUndefined(); // no vitals collected → no attributes
  });
});
