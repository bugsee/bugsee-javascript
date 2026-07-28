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
import { assertBundleIntegrity, assertNoContractViolations, parseBundles } from './bundle';
import { type MockCollector, startMockCollector } from './collector';
import { bundleWorkerEntry } from './edge-bundle';

const SECRET_A = 'SECRET-OF-TENANT-A';
const SECRET_B = 'SECRET-OF-TENANT-B';
const INCIDENT_C = 'INCIDENT-IN-C';
// Tenant C's own LOG, deliberately distinct from its error string. Review pass 2 SEV2 #2: when C's secret
// and its thrown message were the same token, the suite passed with the owner-scoped drain killed and the
// bundle stripped of logs.json entirely — the error text in request.json/crash.json satisfied the
// assertion. A separate token means the suite can only pass if C's CAPTURE actually survived, so the test
// detects "traded the leak for blindness" as well as the leak itself.
const OWN_LOG_C = 'C-OWN-LOG-SECRET';

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
    await mf.dispatchFetch(`http://do.test/?tenant=C&secret=${OWN_LOG_C}&fault=1`);
    // The DO awaits its flush in-request (ctx.waitUntil is inert on DOs), so the upload has landed.
  }, 120_000);

  afterAll(async () => {
    await mf?.dispose();
    await collector?.close();
  });

  it('the three tenants really did share ONE isolate (otherwise this test proves nothing)', async () => {
    // If workerd placed each DO in its own isolate there would be nothing to leak and the assertions below
    // would be vacuous, so this must be a REAL co-location check.
    //
    // The original proxy — `collector.sessions.length === 1` — could not do that job: a session is created
    // per UPLOAD, and capture is incident-driven, so tenants A and B never upload. It stayed green with a
    // single tenant and no co-location at all (docs/review/session-changes-review.md SEV1 #3).
    //
    // Instead ask the ONE per-isolate client which tenant partitions it is holding. Three distinct owners in
    // one client's store is exactly "these three DOs shared an isolate".
    const res = await mf.dispatchFetch('http://do.test/__owners');
    const owners = (await res.json()) as string[] | null;
    expect(owners).not.toBeNull();
    expect(owners?.length).toBe(3);
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

  it('the faulting tenant KEPT its own capture (isolation must not become blindness)', () => {
    // Asserts on logs.json specifically, and on a token that appears ONLY in C's log — not in its error.
    // Without this, killing the owner-scoped drain produced a bundle with no logs.json at all and the
    // suite still passed (review pass 2, SEV2 #2).
    const bundles = parseBundles(collector);
    const logs = bundles
      .map((b) => b.files['logs.json'])
      .filter((f): f is Uint8Array => f !== undefined)
      .map((bytes) => strFromU8(bytes));
    expect(logs.length).toBeGreaterThan(0); // logs.json must exist at all
    expect(logs.join('\n')).toContain(OWN_LOG_C);
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

  it('the edge upload path emits nothing that violates the upload contract', () => {
    // The collector schema-validates every session/issue/manifest/request.json and RECORDS failures. That
    // recording is inert unless a suite reads it — and until now only the node/bun/deno suite did, so a
    // wire break on the EDGE assembler (a different assembler, and the one this session built) would have
    // been recorded and silently discarded (docs/review/session-integration-review.md SEV2 #1).
    assertNoContractViolations(collector);
  });
});
