// The edge smoke scenario (X3). Bundled to an IIFE and evaluated INSIDE @edge-runtime/vm — a real WinterCG
// isolate (V8, fetch/Request/Response/crypto.subtle, NO node:*). It assigns three smoke runners onto
// globalThis that the harness invokes with the mock-collector URL. Each launches the REAL edge SDK, fires ONE
// incident (a throwing handler), and drives the upload to completion — proving the assembled edge SDK runs
// node-free in an actual edge isolate and delivers an incident-driven bundle. Capture providers are disabled
// (the smoke targets the launch + incident + upload path, not the console/network interceptors).
import { instrumentDurableObject, withBugsee } from '@bugsee/cloudflare';
import { launch as launchVercelEdge, withBugseeFetch } from '@bugsee/vercel-edge';

const G = globalThis as unknown as Record<string, unknown>;

// A ctx whose waitUntil collects the flush promise so the harness can await the upload to completion (the
// edge isolate would otherwise freeze on Response — exactly what this proves works).
function collectingCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
    },
    settle: () => Promise.all(pending),
  };
}

const baseOptions = (collector: string) =>
  ({ endpoint: collector, captureLogs: false, captureNetwork: false, carrier: {} }) as const;

// Vercel Edge: withBugseeFetch + a throwing handler → incident upload (flushed via ctx.waitUntil).
G.__runVercelEdge = async (collector: string): Promise<boolean> => {
  const bugsee = launchVercelEdge('vercel-edge-vm-token', baseOptions(collector));
  const { ctx, settle } = collectingCtx();
  const handler = withBugseeFetch(
    bugsee,
    async (_request: Request, _env: unknown, _ctx: unknown) => {
      throw new Error('vercel-edge vm incident');
    },
  );
  try {
    await handler(new Request('https://smoke.test/v'), {}, ctx);
  } catch {
    // rethrown by the wrapper — expected
  }
  await settle();
  return true;
};

// Cloudflare: withBugsee(handler object) + a throwing fetch → incident upload (platform 'workers').
G.__runCloudflare = async (collector: string): Promise<boolean> => {
  const { ctx, settle } = collectingCtx();
  const handler = withBugsee(
    { appToken: 'cloudflare-vm-token', ...baseOptions(collector) },
    {
      fetch: async (_request: Request, _env: unknown, _ctx: unknown) => {
        throw new Error('cloudflare vm incident');
      },
    },
  );
  try {
    await handler.fetch?.(new Request('https://smoke.test/c'), {}, ctx);
  } catch {
    // rethrown — expected
  }
  await settle();
  return true;
};

// Cloudflare Durable Object: instrumentDurableObject + a throwing fetch → incident upload (AWAITED in-request,
// since DurableObjectState.waitUntil is a no-op).
G.__runDurableObject = async (collector: string): Promise<boolean> => {
  class SmokeDurableObject {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
    async fetch(_request: Request): Promise<Response> {
      throw new Error('durable-object vm incident');
    }
  }
  const Instrumented = instrumentDurableObject(
    { appToken: 'durable-object-vm-token', ...baseOptions(collector) },
    SmokeDurableObject,
  );
  const instance = new Instrumented({ waitUntil: () => {} }, {});
  try {
    await instance.fetch(new Request('https://smoke.test/do'));
  } catch {
    // rethrown after the in-request flush already completed — expected
  }
  return true;
};
