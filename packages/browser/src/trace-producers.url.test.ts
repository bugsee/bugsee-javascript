import { ScreenProducer } from '@bugsee/capture';
import { ScreenTracker } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { createBrowserSystemTraceProducers } from './trace-producers';
import { UrlProducer } from './url-producer';

const deps = {
  source: { on: () => () => {} },
  read: () => 'https://a.com/',
};

describe('createBrowserSystemTraceProducers: url', () => {
  it('builds no url producer without env.url', () => {
    expect(createBrowserSystemTraceProducers({}).some((p) => p.name === 'url')).toBe(false);
  });

  it('builds a url producer from env.url, with no lifecycle needed', () => {
    const producers = createBrowserSystemTraceProducers({ url: deps });
    expect(producers.filter((p) => p instanceof UrlProducer)).toHaveLength(1);
  });

  it('keeps url when sensors are replaced (it is not a sensor) and keeps battery first', () => {
    const producers = createBrowserSystemTraceProducers({ url: deps, sensors: false });
    expect(producers.map((p) => p.name)).toEqual(['battery', 'url']);
  });

  it('sensors:false without env.url is battery only', () => {
    expect(createBrowserSystemTraceProducers({ sensors: false }).map((p) => p.name)).toEqual([
      'battery',
    ]);
  });
});

describe('createBrowserSystemTraceProducers: route and view', () => {
  const routeViewState = new ScreenTracker();

  it('builds no screen producer without env.routeViewState', () => {
    expect(createBrowserSystemTraceProducers({}).some((p) => p.name === 'screen')).toBe(false);
  });

  it('builds one screen producer from env.routeViewState, with no lifecycle needed', () => {
    const producers = createBrowserSystemTraceProducers({ routeViewState });
    expect(producers.filter((p) => p instanceof ScreenProducer)).toHaveLength(1);
  });

  it('keeps it when sensors are replaced (it is not a sensor), after battery and url', () => {
    const producers = createBrowserSystemTraceProducers({
      url: deps,
      routeViewState,
      sensors: false,
    });
    expect(producers.map((p) => p.name)).toEqual(['battery', 'url', 'screen']);
  });

  it('a host-owned name is not written: hostOwnedTraces view / route', () => {
    const t = new ScreenTracker();
    t.setRoute('/r');
    t.setView({ name: 'V1' });
    const written = (hostOwnedTraces: string[]) => {
      const got: string[] = [];
      for (const p of createBrowserSystemTraceProducers({
        routeViewState: t,
        hostOwnedTraces,
        sensors: false,
      })) {
        if (p.name === 'screen') p.start({ emit: (name) => got.push(name) });
      }
      return got;
    };
    expect(written([])).toEqual(['route', 'view']);
    expect(written(['displays', 'view'])).toEqual(['route']);
    expect(written(['route'])).toEqual(['view']);
    expect(written(['route', 'view'])).toEqual([]);
  });
});
