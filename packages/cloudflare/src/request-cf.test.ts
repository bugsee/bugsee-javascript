import { describe, expect, it } from 'vitest';
import { cfAttributes, cloudflareRequestAttributes } from './request-cf';

// Build a Request with a Cloudflare `cf` object attached (the runtime sets it; node lets us assign it).
function cfRequest(url: string, cf: unknown): Request {
  const request = new Request(url);
  Object.defineProperty(request, 'cf', { value: cf, configurable: true });
  return request;
}

describe('cfAttributes', () => {
  it('stamps the curated geo/network subset (colo/country/city/timezone/asn/org/protocol/tls)', () => {
    const request = cfRequest('https://x.test/', {
      colo: 'SJC',
      country: 'US',
      city: 'San Jose',
      timezone: 'America/Los_Angeles',
      asn: 13335,
      asOrganization: 'Cloudflare',
      httpProtocol: 'HTTP/2',
      tlsVersion: 'TLSv1.3',
      latitude: '37.33', // deliberately NOT stamped (finer-grained PII)
      longitude: '-121.89',
    });
    expect(cfAttributes(request)).toEqual({
      'cf.colo': 'SJC',
      'cf.country': 'US',
      'cf.city': 'San Jose',
      'cf.timezone': 'America/Los_Angeles',
      'cf.asn': 13335,
      'cf.as_organization': 'Cloudflare',
      'http.protocol': 'HTTP/2',
      'tls.version': 'TLSv1.3',
    });
  });

  it('returns {} when cf is absent (local wrangler dev) or not an object', () => {
    expect(cfAttributes(new Request('https://x.test/'))).toEqual({}); // no cf at all
    expect(cfAttributes(cfRequest('https://x.test/', null))).toEqual({}); // cf null
    expect(cfAttributes(cfRequest('https://x.test/', 'edge'))).toEqual({}); // cf not an object
  });

  it('stamps only the present fields and omits a non-numeric asn / non-string field', () => {
    expect(
      cfAttributes(cfRequest('https://x.test/', { country: 'DE', asn: 'not-a-number', colo: 42 })),
    ).toEqual(
      { 'cf.country': 'DE' }, // asn (string) + colo (number) both dropped
    );
  });
});

describe('cloudflareRequestAttributes', () => {
  it('merges the http route attributes with the cf enrichment', () => {
    const request = cfRequest('https://x.test/orders/9?token=secret', {
      colo: 'LHR',
      country: 'GB',
    });
    expect(cloudflareRequestAttributes(request)).toEqual({
      'http.method': 'GET',
      'http.url': '/orders/9', // query dropped (shared requestAttributes)
      'cf.colo': 'LHR',
      'cf.country': 'GB',
    });
  });

  it('is just the http attributes when cf is absent', () => {
    expect(
      cloudflareRequestAttributes(new Request('https://x.test/p', { method: 'POST' })),
    ).toEqual({
      'http.method': 'POST',
      'http.url': '/p',
    });
  });
});
