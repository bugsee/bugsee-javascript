import {
  type Bugsee,
  createEdgeRequestContextStore,
  EdgeContextStoreToken,
} from '@bugsee/vercel-edge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext, ExportedHandler, ScheduledController } from './cloudflare-types';
import * as cfLaunch from './launch';
import { withBugsee } from './with-bugsee';

// A fake launched edge client: a real edge context store (single-slot in node), spied logException + flush.
function fakeClient() {
  const store = createEdgeRequestContextStore();
  const logException = vi.fn((_e: unknown, _o?: unknown) => Promise.resolve({ ok: true }));
  const flush = vi.fn(() => Promise.resolve(true));
  const client = {
    logException,
    flush,
    getService: (token: unknown) => (token === EdgeContextStoreToken ? store : undefined),
  } as unknown as Bugsee;
  return { client, store, logException, flush };
}

// A fake ExecutionContext whose waitUntil is a spy (a Mock is assignable to the (promise) => void slot).
const ctxStub = () => ({ waitUntil: vi.fn() });

afterEach(() => vi.restoreAllMocks());

describe('withBugsee', () => {
  it('wraps fetch: runs the original in a context with http + request.cf attrs + flushes via waitUntil', async () => {
    const { client, store, flush } = fakeClient();
    vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    let attrs: Record<string, unknown> | undefined;
    const handler = withBugsee('tok', {
      fetch: async (_req: Request, _env: unknown, _ctx: ExecutionContext) => {
        attrs = store.getCurrent()?.attributes;
        return new Response('ok');
      },
    });
    const request = new Request('https://x.test/p/1');
    Object.defineProperty(request, 'cf', {
      value: { colo: 'SJC', country: 'US' },
      configurable: true,
    });
    const ctx = ctxStub();
    const res = await handler.fetch?.(request, {}, ctx);
    expect(await res?.text()).toBe('ok');
    expect(attrs?.['http.url']).toBe('/p/1'); // shared route attrs
    expect(attrs?.['cf.colo']).toBe('SJC'); // C3 request.cf enrichment flows through withBugsee
    expect(attrs?.['cf.country']).toBe('US');
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('wraps scheduled (cron): stamps faas timer + cron, runs the original, flushes', async () => {
    const { client, store, flush } = fakeClient();
    vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    let attrs: Record<string, unknown> | undefined;
    const ran = vi.fn();
    const handler = withBugsee('tok', {
      scheduled: async (_c, _env: unknown, _ctx: ExecutionContext) => {
        attrs = store.getCurrent()?.attributes;
        ran();
      },
    });
    const ctx = ctxStub();
    await handler.scheduled?.({ cron: '*/5 * * * *', scheduledTime: 1 }, {}, ctx);
    expect(ran).toHaveBeenCalledTimes(1);
    expect(attrs).toMatchObject({ 'faas.trigger': 'timer', 'faas.cron': '*/5 * * * *' });
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('wraps queue: stamps the batch size + queue name', async () => {
    const { client, store } = fakeClient();
    vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    let attrs: Record<string, unknown> | undefined;
    const handler = withBugsee('tok', {
      queue: async (_b, _env: unknown, _ctx: ExecutionContext) => {
        attrs = store.getCurrent()?.attributes;
      },
    });
    await handler.queue?.({ queue: 'jobs', messages: [{}, {}] }, {}, ctxStub());
    expect(attrs).toMatchObject({
      'faas.trigger': 'pubsub',
      'messaging.destination.name': 'jobs',
      'messaging.batch.message_count': 2,
    });
  });

  it('wraps email: stamps the email marker and NO addresses (PII-safe)', async () => {
    const { client, store } = fakeClient();
    vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    let attrs: Record<string, unknown> | undefined;
    const handler = withBugsee('tok', {
      email: async (_m, _env: unknown, _ctx: ExecutionContext) => {
        attrs = store.getCurrent()?.attributes;
      },
    });
    await handler.email?.({ from: 'a@b.co', to: 'd@e.fo' }, {}, ctxStub());
    expect(attrs).toEqual({ 'faas.trigger': 'other', 'cloudflare.handler': 'email' });
  });

  it('wraps tail: stamps the forwarded-event count', async () => {
    const { client, store } = fakeClient();
    vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    let attrs: Record<string, unknown> | undefined;
    const handler = withBugsee('tok', {
      tail: async (_e, _env: unknown, _ctx: ExecutionContext) => {
        attrs = store.getCurrent()?.attributes;
      },
    });
    await handler.tail?.([{}, {}, {}], {}, ctxStub());
    expect(attrs).toMatchObject({ 'cloudflare.handler': 'tail', 'cloudflare.tail.event_count': 3 });
  });

  it('captures + RETHROWS a thrown handler error (mechanism uncaught)', async () => {
    const { client, logException } = fakeClient();
    vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    const boom = new Error('cron boom');
    const handler = withBugsee('tok', {
      scheduled: (_c: ScheduledController, _env: unknown, _ctx: ExecutionContext) => {
        throw boom;
      },
    });
    await expect(
      handler.scheduled?.({ cron: '* * * * *', scheduledTime: 1 }, {}, ctxStub()),
    ).rejects.toBe(boom);
    expect(logException).toHaveBeenCalledWith(boom, { mechanism: 'uncaught' });
  });

  it('launches the client LAZILY and ONCE (per-isolate) across multiple invocations', async () => {
    const { client } = fakeClient();
    const launchSpy = vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    const handler = withBugsee('tok', {
      fetch: async (_req: Request, _env: unknown, _ctx: ExecutionContext) => new Response('ok'),
    });
    expect(launchSpy).not.toHaveBeenCalled(); // not launched until the first invocation
    await handler.fetch?.(new Request('https://x.test/'), {}, ctxStub());
    await handler.fetch?.(new Request('https://x.test/'), {}, ctxStub());
    expect(launchSpy).toHaveBeenCalledTimes(1); // launched once, cached
  });

  it('resolves the app token from the env CALLBACK (token is a Worker secret)', async () => {
    const { client } = fakeClient();
    const launchSpy = vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    const handler = withBugsee((env: unknown) => (env as { TOKEN: string }).TOKEN, {
      fetch: async (_req: Request, _env: unknown, _ctx: ExecutionContext) => new Response('ok'),
    });
    await handler.fetch?.(new Request('https://x.test/'), { TOKEN: 'secret-from-env' }, ctxStub());
    expect(launchSpy).toHaveBeenCalledWith('secret-from-env', {});
  });

  it('passes an options object through to launch (appToken split out)', async () => {
    const { client } = fakeClient();
    const launchSpy = vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
    const handler = withBugsee(
      { appToken: 'tok', endpoint: 'https://collector.test', captureNetwork: false },
      { fetch: async (_req: Request, _env: unknown, _ctx: ExecutionContext) => new Response('ok') },
    );
    await handler.fetch?.(new Request('https://x.test/'), {}, ctxStub());
    expect(launchSpy).toHaveBeenCalledWith('tok', {
      endpoint: 'https://collector.test',
      captureNetwork: false,
    });
  });

  it('leaves absent handler methods absent and does not mutate the original handler', () => {
    const original: ExportedHandler = {
      fetch: async (_req: Request, _env: unknown, _ctx: ExecutionContext) => new Response('ok'),
    };
    const wrapped = withBugsee('tok', original);
    expect(wrapped.scheduled).toBeUndefined(); // not added
    expect(wrapped.queue).toBeUndefined();
    expect(wrapped).not.toBe(original); // a new object
    expect(wrapped.fetch).not.toBe(original.fetch); // fetch was wrapped, original untouched
  });
});
