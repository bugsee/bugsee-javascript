// Durable Object TENANT ISOLATION on REAL workerd (Wave 0.1 S5,
// docs/design/cloudflare-tenant-isolation.md).
//
// THE acceptance test for the most severe finding of the 53-package adversarial review: Durable Objects for
// different tenants share one isolate, one client and one capture ring, so an incident in one uploaded every
// other tenant's data (docs/review/cloudflare.md SEV1 #2, reproduced there on real workerd).
//
// Everything else in the repo tests this against a driven context or a WinterCG VM. Neither can model DO
// placement — @edge-runtime/vm has no Durable Objects at all — so this is the only test where three real
// tenants genuinely share one real isolate. It runs the REAL SDK, bundled the way wrangler would, inside
// real workerd via miniflare, against the same mock collector the other harnesses use.
import { strFromU8, unzipSync } from '@bugsee/util';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertBundleIntegrity, parseBundles } from './bundle';
import { type MockCollector, startMockCollector } from './collector';
import { bundleWorkerEntry } from './edge-bundle';

const SECRET_A = 'SECRET-OF-TENANT-A';
const SECRET_B = 'SECRET-OF-TENANT-B';
const INCIDENT_C = 'INCIDENT-IN-C';

describe('Durable Object tenant isolation (real workerd via miniflare)', () => {
  let collector: MockCollector;
  let mf: Miniflare;

  beforeAll(async () => {
    collector = await startMockCollector();
    const script = await bundleWorkerEntry(
      new URL('../app/do-tenants-worker.ts', import.meta.url).pathname,
    );
    mf = new Miniflare({
      modules: true,
      script,
      // REQUIRED by @bugsee/cloudflare: AsyncLocalStorage is reachable only through node:async_hooks on
      // workerd (Wave 0.1 S0). Without the flag the Worker would not even start.
      compatibilityFlags: ['nodejs_compat'],
      compatibilityDate: '2026-07-01',
      durableObjects: { TENANT: 'Tenant' },
      bindings: { BUGSEE_ENDPOINT: collector.url },
    });
    // Three tenants, one isolate. A and B return cleanly; C faults and produces the incident bundle.
    await mf.dispatchFetch(`http://do.test/?tenant=A&secret=${SECRET_A}`);
    await mf.dispatchFetch(`http://do.test/?tenant=B&secret=${SECRET_B}`);
    await mf.dispatchFetch(`http://do.test/?tenant=C&secret=${INCIDENT_C}&fault=1`);
    // The DO awaits its flush in-request (ctx.waitUntil is inert on DOs), so the upload has landed.
  }, 120_000);

  afterAll(async () => {
    await mf?.dispose();
    await collector?.close();
  });

  it('the three tenants really did share ONE isolate (otherwise this test proves nothing)', () => {
    // If workerd placed each DO in its own isolate there would be nothing to leak, and a green result
    // below would be vacuous. One session per isolate is the observable proxy for co-location.
    expect(collector.sessions.length).toBe(1);
  });

  it('produced exactly one incident bundle, from the tenant that faulted', () => {
    expect(collector.uploads.length).toBeGreaterThan(0);
    const bundles = parseBundles(collector);
    for (const bundle of bundles) assertBundleIntegrity(bundle);
    const all = bundles
      .flatMap((b) => Object.values(b.files))
      .map((bytes) => strFromU8(bytes as Uint8Array))
      .join('\n');
    expect(all).toContain(INCIDENT_C);
  });

  it('tenant C’s bundle carries NEITHER tenant A’s NOR tenant B’s secret', () => {
    // The defect, stated exactly as the review proved it.
    const all = collector.uploads
      .flatMap((u) => Object.values(unzipSync(u.body) as Record<string, Uint8Array>))
      .map((bytes) => strFromU8(bytes))
      .join('\n');
    expect(all).not.toContain(SECRET_A);
    expect(all).not.toContain(SECRET_B);
  });
});
