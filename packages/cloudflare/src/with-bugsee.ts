import { type Bugsee, type BugseeEdgeLaunchOptions, runInEdgeContext } from '@bugsee/vercel-edge';
import type { ExportedHandler } from './cloudflare-types';
import {
  emailAttributes,
  queueAttributes,
  scheduledAttributes,
  tailAttributes,
} from './handler-attributes';
import { launch } from './launch';
import { cloudflareRequestAttributes } from './request-cf';

// The unified Cloudflare Workers instrumentation wrapper (docs/design/edge-runtime.md C2). Cloudflare module
// Workers export a handler OBJECT (`export default { fetch, scheduled, queue, email, tail }`); each method is a
// distinct invocation type, and the non-fetch ones have NO incoming Request, so a fetch-only SDK misses cron /
// queue / email / tail entirely. `withBugsee` wraps every PRESENT method so it runs in its own Bugsee context
// (stamped with the trigger's faas.* attributes), captures + rethrows errors, and flushes via that handler's
// `ctx.waitUntil` — all on the shared `runInEdgeContext` core. Absent methods are left untouched.

/** Launch config for a Cloudflare Worker. Because `env` (and thus the app token, a Worker SECRET) is NOT
 *  available at module scope on Cloudflare, pass a CALLBACK that receives `env` — or, if your token is a plain
 *  constant, a static token string or an options object. */
export type BugseeWorkerConfig =
  | string
  | (BugseeEdgeLaunchOptions & { appToken: string })
  | ((env: unknown) => string | (BugseeEdgeLaunchOptions & { appToken: string }));

function resolveConfig(
  config: BugseeWorkerConfig,
  env: unknown,
): { appToken: string; options: BugseeEdgeLaunchOptions } {
  const value = typeof config === 'function' ? config(env) : config;
  if (typeof value === 'string') {
    return { appToken: value, options: {} };
  }
  const { appToken, ...options } = value;
  return { appToken, options };
}

/** Instrument a Cloudflare Workers exported handler. Wraps each present method (fetch / scheduled / queue /
 *  email / tail) with per-request Bugsee context + error capture + a `ctx.waitUntil` flush. The client is
 *  launched LAZILY on the first invocation (a per-isolate singleton) from `config` + the runtime `env`, so the
 *  app token can be a Worker secret. Returns a new handler object — the original is not mutated. */
export function withBugsee<Env, H extends ExportedHandler<Env>>(
  config: BugseeWorkerConfig,
  handler: H,
): H {
  let client: Bugsee | undefined;
  const ensureClient = (env: unknown): Bugsee => {
    if (client === undefined) {
      const { appToken, options } = resolveConfig(config, env);
      client = launch(appToken, options);
    }
    return client;
  };

  const wrapped: ExportedHandler<Env> = { ...handler };

  const fetchFn = handler.fetch;
  if (fetchFn !== undefined) {
    wrapped.fetch = (request, env, ctx) =>
      runInEdgeContext(
        ensureClient(env),
        { attributes: cloudflareRequestAttributes(request), ctx },
        () => fetchFn(request, env, ctx),
      );
  }
  const scheduledFn = handler.scheduled;
  if (scheduledFn !== undefined) {
    wrapped.scheduled = (controller, env, ctx) =>
      runInEdgeContext(
        ensureClient(env),
        { attributes: scheduledAttributes(controller), ctx },
        () => scheduledFn(controller, env, ctx),
      );
  }
  const queueFn = handler.queue;
  if (queueFn !== undefined) {
    wrapped.queue = (batch, env, ctx) =>
      runInEdgeContext(ensureClient(env), { attributes: queueAttributes(batch), ctx }, () =>
        queueFn(batch, env, ctx),
      );
  }
  const emailFn = handler.email;
  if (emailFn !== undefined) {
    wrapped.email = (message, env, ctx) =>
      runInEdgeContext(ensureClient(env), { attributes: emailAttributes(), ctx }, () =>
        emailFn(message, env, ctx),
      );
  }
  const tailFn = handler.tail;
  if (tailFn !== undefined) {
    wrapped.tail = (events, env, ctx) =>
      runInEdgeContext(ensureClient(env), { attributes: tailAttributes(events), ctx }, () =>
        tailFn(events, env, ctx),
      );
  }
  return wrapped as H;
}
