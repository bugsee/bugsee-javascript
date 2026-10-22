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
