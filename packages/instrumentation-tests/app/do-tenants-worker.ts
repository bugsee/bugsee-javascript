// Fixture Worker for the Durable Object TENANT-ISOLATION e2e (Wave 0.1 S5).
//
// Reproduces the exact scenario the adversarial review proved on real workerd (docs/review/cloudflare.md
// SEV1 #2): three Durable Objects for three different tenants, hosted in ONE isolate. A and B each log a
// secret and return cleanly; C logs and then throws, producing an incident bundle. Before the fix, C's
// bundle contained A's and B's secrets.
//
// This is the ONLY place in the repo that exercises real Durable Object placement — @edge-runtime/vm has no
// DO semantics, so multiple tenants sharing an isolate is not representable there.
import { instrumentDurableObject, launch } from '@bugsee/cloudflare';
import { CaptureStoreToken } from '@bugsee/core';

// The minimal Durable Object surface this fixture uses. Declared locally rather than depending on
// @cloudflare/workers-types: the harness needs two shapes, not the whole Workers API, and keeping the
// surface small makes it obvious exactly what the isolation test relies on (notably `id`, the tenant key).
interface DurableObjectId {
  toString(): string;
}
interface DurableObjectState {
  id: DurableObjectId;
}
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface Env {
  BUGSEE_ENDPOINT: string;
  TENANT: DurableObjectNamespace;
}

// A minimal DO: log this tenant's secret, then optionally fault. The SDK is launched from the constructor
// env, exactly as a real integrator would (the app token is a Worker secret, unavailable at module scope).
class TenantObject {
  #env: Env;
  constructor(_state: DurableObjectState, env: Env) {
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const secret = url.searchParams.get('secret') ?? 'none';
    console.log(secret);
    if (url.searchParams.get('fault') === '1') {
      throw new Error(`INCIDENT-IN-${url.searchParams.get('tenant')}`);
    }
    return new Response('ok');
  }
}

export const Tenant = instrumentDurableObject(
  (env) => ({
    appToken: 'e2e-do-token',
    endpoint: (env as Env).BUGSEE_ENDPOINT,
    // Network capture off: the only traffic here is the SDK's own upload, so leaving it on adds noise
    // without exercising anything this test is about. (The background tick still runs — an earlier comment
    // here claimed otherwise; nothing in this config disables it.)
    captureNetwork: false,
  }),
  TenantObject,
);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Launch once per isolate so the console interceptor is installed before any DO runs.
    const client = launch('e2e-do-token', {
      endpoint: env.BUGSEE_ENDPOINT,
      captureNetwork: false,
    });
    const url = new URL(request.url);
    // Co-location probe: the tenant partitions the ONE per-isolate client is holding. If workerd placed the
    // DOs in separate isolates this returns fewer than the tenants dispatched, because each isolate would
    // have its own client and its own store. This is the isolate-scoped observable the e2e needs — the
    // earlier proxy (session count) was per-UPLOAD and could not detect co-location at all.
    if (url.pathname === '/__owners') {
      const store = client.getService(CaptureStoreToken) as unknown as { owners?: () => string[] };
      return new Response(JSON.stringify(store.owners?.() ?? null), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const tenant = url.searchParams.get('tenant') ?? 'A';
    // idFromName gives a STABLE, distinct DO per tenant — the archetypal one-DO-per-customer pattern.
    const stub = env.TENANT.get(env.TENANT.idFromName(tenant));
    try {
      return await stub.fetch(request);
    } catch (error) {
      return new Response(`faulted: ${String(error)}`, { status: 500 });
    }
  },
};
